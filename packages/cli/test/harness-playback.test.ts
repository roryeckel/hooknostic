import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { HookEventName } from "@hooknostic/sdk";
import type { IPty } from "node-pty";
import { adapterFixturesDir } from "@hooknostic/testkit";
import { defaultAdapterRegistry } from "../src/registry.js";
import {
  buildPlaybackArtifact,
  type PlaybackScenario,
  replayCommandFixtures,
  replayOpenCodeFixtures,
  runProcess,
  startModelPlayback,
  traceEvents,
} from "./harness-playback.js";

const selected = process.env["HOOKNOSTIC_PLAYBACK"] ?? "";
const adapter = defaultAdapterRegistry()[selected];
const tempDirs: string[] = [];

/** In-repo stdio MCP fixture server (see the file's header for the protocol). */
const McpFixtureServerPath = fileURLToPath(new URL("./mcp-fixture-server.mjs", import.meta.url));

if (selected !== "" && adapter === undefined) {
  throw new Error(`unknown HOOKNOSTIC_PLAYBACK harness ${JSON.stringify(selected)}`);
}

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

function tomlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function playbackPrompt(scenario: PlaybackScenario): string {
  if (scenario === "rewrite") {
    return "Use the shell tool once to create hooknostic-tool.txt, then stop.";
  }
  if (scenario === "block") {
    return "Use the shell tool once to create hooknostic-blocked.txt, then stop.";
  }
  return "Use the shell tool once to run a command that exits 17, then stop.";
}

/** Options the effect scenarios pass through to the per-harness drives. */
interface DriveOptions {
  /** Comma-separated PlaybackEffects the generated artifact should emit. */
  effects?: readonly string[];
  /** Replaces the default scenario prompt (e.g. the prompt-block sentinel). */
  prompt?: string;
  /** Scenario script override for the loopback server (e.g. stop-prevention's second turn). */
  script?: Parameters<typeof startModelPlayback>[2];
  /**
   * Expected exit code where the scenario's own semantics differ from the
   * default clean stop (a blocked prompt exits nonzero on Claude: blocking
   * the turn IS the success signal).
   */
  expectedExitCodes?: readonly (number | null)[];
  /**
   * Assert that at least one agent (tool-bearing) model request happened.
   * Off for scenarios where the hook's expected effect is that the turn
   * never starts (prompt-block): there the absence IS the assertion.
   */
  requireAgentRequest?: boolean;
  /**
   * Path to the in-repo stdio MCP fixture server; registers it with the
   * harness (Codex: `mcp_servers.*`), enabling the MCP-only drive.
   */
  mcpServerPath?: string;
  /** Captures the raw harness stdout/stderr for scenario-level diagnostics. */
  capture?: (raw: { stdout: string; stderr: string; code: number | null }) => void;
  /** Extra per-drive assertions once the session ended cleanly. */
  verify?: (outcome: { server: Awaited<ReturnType<typeof startModelPlayback>>; dir: string }) => Promise<void>;
}

/* eslint-disable no-control-regex -- ANSI stripping needs the escape control char */

async function runClaudePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  const server = await startModelPlayback("anthropic-messages", scenario, options.script);
  try {
    const result = await runProcess(
      "claude",
      [
        "-p",
        options.prompt ?? playbackPrompt(scenario),
        "--model",
        "hooknostic-playback",
        "--plugin-dir",
        build.artifactDir,
        "--dangerously-skip-permissions",
        "--max-turns",
        "6",
      ],
      {
        cwd: build.artifactDir,
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          ANTHROPIC_API_KEY: "hooknostic-playback",
          ANTHROPIC_BASE_URL: server.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
          ...(options.effects ? { HOOKNOSTIC_PLAYBACK_EFFECTS: options.effects.join(",") } : {}),
        },
      },
    );
    expect(
      options.expectedExitCodes ?? [0],
      `claude exit ${result.code}: ${result.stdout}\n${result.stderr}`,
    ).toContain(result.code);
    expect(server.errors).toEqual([]);
    if (!options.requireAgentRequest) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some(
        (request) =>
          request !== null && typeof request === "object" && "tools" in request,
      ),
      JSON.stringify(server.requests, null, 2),
    ).toBe(true);
    await options.verify?.({ server, dir: build.artifactDir });
  } finally {
    await server.close();
  }
}

async function runCodexPlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  const server = await startModelPlayback("openai-responses", scenario, options.script);
  try {
    await runProcess("git", ["init"], {
      cwd: build.artifactDir,
      env: process.env,
      timeoutMs: 30_000,
    });
    const result = await runProcess(
      "codex",
      [
        "exec",
        "-",
        "--dangerously-bypass-hook-trust",
        "--color",
        "never",
        "-c",
        'model="hooknostic-playback"',
        "-c",
        'model_provider="hooknostic_playback"',
        "-c",
        'approval_policy="never"',
        "-c",
        // Playback exercises hooks, not Codex's host sandbox. A sandboxed
        // spawn failure makes the block scenario pass vacuously.
        'sandbox_mode="danger-full-access"',
        "-c",
        'model_providers.hooknostic_playback.name="Hooknostic Playback"',
        "-c",
        `model_providers.hooknostic_playback.base_url=${tomlLiteral(`${server.baseUrl}/v1`)}`,
        "-c",
        'model_providers.hooknostic_playback.wire_api="responses"',
        "-c",
        "model_providers.hooknostic_playback.requires_openai_auth=false",
        "-c",
        "model_providers.hooknostic_playback.request_max_retries=0",
        "-c",
        "model_providers.hooknostic_playback.stream_max_retries=0",
        "-c",
        `projects={${tomlLiteral(build.artifactDir)}={trust_level=${tomlLiteral("trusted")}}}`,
        ...(options.mcpServerPath
          ? [
              // MCP tool calls trip an approval gate under approval_policy
              // "never" (verified on codex 0.151.0: the gate is bypassed by
              // the approvals-and-sandbox bypass, not by a feature flag).
              "--dangerously-bypass-approvals-and-sandbox",
              "-c",
              `mcp_servers.hooknostic_fixture.command=${tomlLiteral("node")}`,
              "-c",
              `mcp_servers.hooknostic_fixture.args=[${tomlLiteral(options.mcpServerPath)}]`,
            ]
          : []),
      ],
      {
        cwd: build.artifactDir,
        input: options.prompt ?? playbackPrompt(scenario),
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
          ...(options.effects ? { HOOKNOSTIC_PLAYBACK_EFFECTS: options.effects.join(",") } : {}),
        },
      },
    );
    expect(
      options.expectedExitCodes ?? [0],
      `codex exit ${result.code}: ${result.stdout}\n${result.stderr}\nserverErrors: ${JSON.stringify(server.errors)}\nurls: ${JSON.stringify((server.urls ?? []).slice(0, 10))}`,
    ).toContain(result.code);
    options.capture?.({ stdout: result.stdout, stderr: result.stderr, code: result.code });
    expect(server.errors).toEqual([]);
    if (!options.requireAgentRequest) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some(
        (request) => request !== null && typeof request === "object" && "tools" in request,
      ),
      JSON.stringify(server.requests, null, 2),
    ).toBe(true);
    expect(
      await traceEvents(build.tracePath),
      `${result.stdout}\n${result.stderr}\nrequests: ${JSON.stringify(server.requests, null, 2)}`,
    ).toContain("tool.before");
    await options.verify?.({ server, dir: build.artifactDir });
  } finally {
    await server.close();
  }
}

async function runOpenCodePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  const server = await startModelPlayback("openai-chat", scenario, options.script);
  try {
    await runProcess("git", ["init"], {
      cwd: build.artifactDir,
      env: process.env,
      timeoutMs: 30_000,
    });
    await writeFile(
      join(build.artifactDir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "playback/hooknostic-playback",
          enabled_providers: ["playback"],
          provider: {
            playback: {
              npm: "@ai-sdk/openai-compatible",
              name: "Hooknostic Playback",
              options: { baseURL: `${server.baseUrl}/v1`, apiKey: "hooknostic-playback" },
              models: {
                "hooknostic-playback": {
                  name: "Hooknostic Playback",
                  limit: { context: 32_768, output: 4_096 },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = await runProcess(
      "opencode",
      [
        "run",
        options.prompt ?? playbackPrompt(scenario),
        "--model",
        "playback/hooknostic-playback",
      ],
      {
        cwd: build.artifactDir,
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          PWD: build.artifactDir,
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
          ...(options.effects ? { HOOKNOSTIC_PLAYBACK_EFFECTS: options.effects.join(",") } : {}),
        },
      },
    );
    expect(
      options.expectedExitCodes ?? [0],
      `opencode exit ${result.code}: ${result.stdout}\n${result.stderr}`,
    ).toContain(result.code);
    expect(server.errors).toEqual([]);
    if (!options.requireAgentRequest) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some(
        (request) => request !== null && typeof request === "object" && "tools" in request,
      ),
      JSON.stringify(server.requests, null, 2),
    ).toBe(true);
    expect(
      await traceEvents(build.tracePath),
      `${result.stdout}\n${result.stderr}\nrequests: ${JSON.stringify(server.requests, null, 2)}`,
    ).toContain("tool.before");
    await options.verify?.({ server, dir: build.artifactDir });
  } finally {
    await server.close();
  }
}

async function runInstalledHarness(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  if (adapter!.id === "claude") await runClaudePlayback(build, scenario, options);
  else if (adapter!.id === "codex") await runCodexPlayback(build, scenario, options);
  else await runOpenCodePlayback(build, scenario, options);
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The adapter's resolved level for a cell at its own referenceVersion. */
function cellLevel(id: string): string | undefined {
  if (adapter === undefined) return undefined;
  const resolution = adapter.capabilities({
    id: adapter!.id,
    version: adapter!.harness.referenceVersion,
    mode: "local",
    output: ".",
  });
  return resolution.matrix?.[id as keyof NonNullable<typeof resolution.matrix>]?.level;
}

describe.skipIf(adapter === undefined)(`offline harness playback: ${selected || "disabled"}`, () => {
  it("uses exactly the captured reference harness version", async () => {
    const detection = await adapter!.detect!();
    expect(detection.installed, detection.detail).toBe(true);
    // harness-watch installs a build newer than referenceVersion and names it
    // here so verification runs against the build under test; unset means
    // CI's exact reference pin. The playback artifact keeps baking
    // referenceVersion into its capability resolution on purpose: the
    // load-bearing question is whether the artifact consumers already have
    // keeps working on the new binary.
    const expectedVersion = process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? adapter!.harness.referenceVersion;
    expect(detection.version).toBe(expectedVersion);
  });

  it("replays every captured hook payload through the generated production artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-playback-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    const fixturesDir = adapterFixturesDir(adapter!);
    if (adapter!.shimExecution === "command") {
      await replayCommandFixtures(build, fixturesDir);
    } else {
      await replayOpenCodeFixtures(build, fixturesDir);
    }
  });

  it(
    "loads the generated artifact in the real harness and executes a rewritten tool call",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-harness-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      await runInstalledHarness(build, "rewrite");

      expect(await readFile(join(dir, "hooknostic-tool.txt"), "utf8")).toBe(
        "hooknostic-rewritten",
      );
      const events = await traceEvents(build.tracePath);
      expect(events).toContain("session.start");
      expect(events).toContain("prompt.before");
      expect(events).toContain("tool.before");
      expect(events).toContain("tool.after");
      expect(events).toContain("turn.stop");
      if (adapter!.shimExecution === "command") expect(events).toContain("session.end");
    },
  );

  it(
    "blocks a tool call before its marker command executes",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-block-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      await runInstalledHarness(build, "block");

      await expect(access(join(dir, "hooknostic-blocked.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await traceEvents(build.tracePath)).toContain("tool.before");
    },
  );

  it.skipIf(adapter?.id !== "claude")(
    "dispatches tool.error when Claude runs a failing shell command",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-failure-claude-"));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      await runInstalledHarness(build, "fail");

      expect(await traceEvents(build.tracePath)).toContain("tool.error");
    },
  );

  // --- scenario-registry drives (ADR-0010) --------------------------------

  // Extracts every string appearing as message content in the recorded model
  // requests, across the three wire protocols. A context injection is proven
  // when its marker text the hook emitted reaches the model side.
  function requestContents(requests: readonly unknown[]): string[] {
    const contents: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        contents.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) walk(item);
      }
    };
    for (const request of requests) walk(request);
    return contents;
  }

  // --- pty-approval lane ----------------------------------------------------
  // Interactive-only cells (Claude permission.request.*, tool.before
  // requestApproval) need a real pseudo-terminal: headless `-p` sessions decide
  // without prompting. The drive starts the interactive TUI under node-pty,
  // walks the first-run dialogs, sends a prompt whose scripted tool call trips
  // the approval prompt, and lets the hook deny it — proven by the trace.
  let ptyModule: { spawn: (...args: readonly unknown[]) => IPty } | undefined;
  const nodePty = (): { spawn: (...args: readonly unknown[]) => IPty } =>
    createRequire(import.meta.url)("node-pty") as { spawn: (...args: readonly unknown[]) => IPty };
  function ptyApprovable(): boolean {
    if (process.platform !== "win32" && process.platform !== "linux") return false;
    try {
      // node-pty ships platform binaries via a build script; a dynamic probe
      // keeps environments without the build working for the other scenarios.
      ptyModule = nodePty();
      return true;
    } catch {
      return false;
    }
  }

  it(
    "delivers context injected on session.start to the model",
    // Only where the adapter claims the cell: OpenCode has no session-start
    // context channel, and the profile is the truth (skipped ≠ silent — the
    // coverage gate in testkit already ties every claimed cell to a lane).
    { timeout: 180_000, skip: cellLevel("session.start.context.add") === undefined },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-ctxadd-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let recordedRequests: readonly unknown[] = [];
      await runInstalledHarness(build, "rewrite", {
        effects: ["context-add"],
        verify: async ({ server }) => {
          recordedRequests = server.requests;
        },
      });

      // The agent request after session.start must carry the hook's
      // injected context. The walk is protocol-agnostic: any string deep in
      // the recorded request bodies matching the injected marker proves the
      // harness delivered hook context to the model side.
      const contents = requestContents(recordedRequests);
      expect(
        contents.some((text) => text.includes("hooknostic-context [session.start]")),
        `injected session.start context missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toBe(true);
    },
  );

  it(
    "delivers context injected at prompt submit to the model and observes the prompt",
    { timeout: 180_000, skip: cellLevel("prompt.before.context.add") === undefined },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-promptctx-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let recordedRequests: readonly unknown[] = [];
      await runInstalledHarness(build, "rewrite", {
        effects: ["context-add"],
        verify: async ({ server }) => {
          recordedRequests = server.requests;
        },
      });

      const contents = requestContents(recordedRequests);
      expect(
        contents.some((text) => text.includes("hooknostic-context [prompt.before]")),
        `injected prompt.before context missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toBe(true);
    },
  );

  it(
    "stops the turn from a prompt.before block before any model call",
    { timeout: 180_000, skip: cellLevel("prompt.before.block") === undefined },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-promptblock-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let recordedRequests: readonly unknown[] = [];
      await runInstalledHarness(build, "rewrite", {
        effects: ["block-prompt"],
        prompt: "hooknostic-block-this-prompt: then stop.",
        // Blocking the prompt is the success signal; Claude surfaces it as a
        // nonzero exit ("the turn did not start"), a clean stop is fine too.
        expectedExitCodes: [0, 1, 2],
        verify: async ({ server }) => {
          recordedRequests = server.requests;
        },
      });

      const events = await traceEvents(build.tracePath);
      expect(events).toContain("prompt.before");
      // Blocked before the agent turn: no model request ever carried tools
      // (a blocked prompt means the model is never reached for the turn).
      const agentRequests = recordedRequests.filter(
        (request) =>
          request !== null &&
          typeof request === "object" &&
          Array.isArray((request as Record<string, unknown>)["tools"]) &&
          ((request as Record<string, unknown>)["tools"] as unknown[]).length > 0,
      );
      expect(agentRequests, "blocked prompt still reached the model side").toEqual([]);
      expect(await readFile(join(dir, "hooknostic-tool.txt"), "utf8").catch(() => null)).toBeNull();
    },
  );

  it(
    "prevents the first stop and makes the harness take another model turn",
    {
      timeout: 180_000,
      // OpenCode's prevent channel is inert under `opencode run` (the process
      // exits at session.idle before the posted turn can start) -- profile
      // documents this; the opencode-serve lane covers it separately.
      skip:
        cellLevel("turn.stop.prevent") === undefined ||
        (adapter!.id === "opencode" && process.platform !== "linux"),
    },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-stopprevent-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let servedTurns = 0;
      await runInstalledHarness(build, "rewrite", {
        effects: ["prevent-stop-once"],
        // Turn 2+ completes immediately: the prevented stop makes the
        // harness re-prompt, and the model's completion ends the retry loop
        // (the hook prevents exactly once -- see control.prevented).
        script: [
          { kind: "tool", disposition: "rewrite" },
          { kind: "text", text: "Stop hook active; standing down now." },
        ],
        verify: async ({ server }) => {
          servedTurns = server.turnCount;
        },
      });

      expect(
        servedTurns,
        `stop prevention did not produce a second model turn (turns served: ${servedTurns})`,
      ).toBeGreaterThanOrEqual(2);
      expect(await traceEvents(build.tracePath)).toContain("turn.stop");
    },
  );

  it(
    "surfaces notify on stop where the harness honors it and records the stop event",
    { timeout: 180_000, skip: cellLevel("turn.stop.notify") === undefined },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-notify-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      await runInstalledHarness(build, "rewrite", { effects: ["notify"] });

      const events = await traceEvents(build.tracePath);
      expect(events).toContain("turn.stop");
    },
  );

  it(
    "replaces an MCP tool output before the model reads it",
     {
      timeout: 180_000,
      skip:
        cellLevel("tool.after.output.replace") === undefined ||
        adapter?.id !== "codex" || // the mcp-stdio drive is Codex-specific
        // Scheduled loopback cannot drive this drive today: codex's tool
        // router rejects scripted namespaced function calls from custom
        // Responses providers with "unsupported call" (upstream issue
        // openai/codex#31354 -- the OpenAI-native path rewrites namespaced
        // calls, custom providers do not). The drive stays for the manual
        // `force_llm` lane, where the OpenAI-native model emits the
        // namespaced call Codex dispatches correctly. Skipped ≠ silent: the
        // step summary reports the inconclusive lane every run.
        true,
    },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-mcpreplace-codex-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let recordedRequests: readonly unknown[] = [];
      let servedUrls: string[] = [];
      let driveStdout = "";
      let driveStderr = "";
      await runInstalledHarness(build, "rewrite", {
        effects: ["replace-outputs", "prevent-stop-once"],
        mcpServerPath: McpFixtureServerPath,
        // Codex registers stdio MCP servers asynchronously, so the first
        // turn's tool list usually lacks the fixture tool. Turn 1 completes
        // with text; the stop hook prevents that stop (exactly once, gated on
        // stop_hook_active), which forces turn 2 — by then the MCP tool is
        // registered and the script calls it. Turn 3 completes.
        script: [
          { kind: "text", text: "I will call the echo tool on the next step." },
          { kind: "tool", toolName: "hooknostic_echo" },
          { kind: "text", text: "Stop hook active; standing down now." },
        ],
        verify: async ({ server }) => {
          recordedRequests = server.requests;
          servedUrls = server.urls;
        },
        capture: (raw) => {
          driveStdout = raw.stdout;
          driveStderr = raw.stderr;
        },
      });

      const events = await traceEvents(build.tracePath);
      // The replaced output must be what the model sees in the next request.
      const contents = requestContents(recordedRequests);
      expect(
        events,
        `no tool.after\nstdout: ${driveStdout}\nstderr: ${driveStderr}\nurls: ${JSON.stringify(servedUrls)}\nevents: ${JSON.stringify(events)}\nrequests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toContain("tool.after");
      expect(
        contents.some((text) => text.includes("hooknostic-replaced-tool-output")),
        `replaced MCP output missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toBe(true);
    },
  );

  it(
    "denies an interactive permission prompt and surfaces the request to the hook",
    {
      timeout: 240_000,
      skip: !ptyApprovable() || adapter?.id !== "claude" || cellLevel("permission.request.block") === undefined,
    },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-ptyperm-claude-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      const server = await startModelPlayback(
        "anthropic-messages",
        "rewrite",
        // Turn 1 emits the shell call that trips the approval prompt; the
        // hook's permission-deny effect answers it; turn 2 completes.
        [
          { kind: "tool", disposition: "rewrite", marker: "hooknostic-approval.txt" },
          { kind: "text" },
        ],
      );
      try {
        await runProcess("git", ["init"], { cwd: dir, env: process.env, timeoutMs: 30_000 });
        // The TUI drive: first-run dialogs (trust + API key), then the prompt,
        // then leave the denial to the hook. Terminal state matters only for
        // diagnostics; the trace is the assertion surface.
        const claudePath = process.platform === "win32" ? "c:/users/ex0du/.local/bin/claude.exe" : "claude";
        const pty = ptyModule!.spawn(
          claudePath,
          ["--plugin-dir", build.artifactDir],
          {
            name: "xterm-256color",
            cols: 110,
            rows: 34,
            cwd: dir,
            env: {
              ...withoutCredentials(),
              ANTHROPIC_API_KEY: "hooknostic-playback",
              ANTHROPIC_BASE_URL: server.baseUrl,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
              DISABLE_AUTOUPDATER: "1",
              DISABLE_TELEMETRY: "1",
              HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
              HOOKNOSTIC_PLAYBACK_EFFECTS: "context-add,permission-deny",
            } as NodeJS.ProcessEnv,
          } as never,
        );
        let screen = "";
        pty.onData((data: string) => {
          screen += data;
        });
        const plainScreen = (): string => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        const waitUntil = async (marker: string, timeoutMs: number): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (plainScreen().includes(marker)) return true;
            await new Promise((r) => setTimeout(r, 500));
          }
          return false;
        };
        // Walk first-run dialogs. Order varies by local state (trust is always
        // first; the API-key dialog only appears when the key isn't already
        // accepted) — poll for each dialog's marker and only then acknowledge.
        await waitUntil("Quicksafetycheck", 15_000);
        pty.write("\u001b[B\r"); // select "Yes, I trust this folder"
        // The API-key dialog, when it appears, starts with the word
        // "customAPIkey" on 2.1.250.
        if (await waitUntil("customAPIkey", 10_000)) {
          await new Promise((r) => setTimeout(r, 800));
          pty.write("\u001b[B\r");
        }
        // Wait for the TUI input line, then send the prompt.
        await waitUntil("\u276f ", 20_000);
        await new Promise((r) => setTimeout(r, 1_500));
        pty.write("Use the shell tool once to create hooknostic-approval.txt.\r");
        // The approval prompt appears; the plugin denies it. Wait out the turn.
        await waitUntil("Doyouwanttoproceed", 30_000);
        await new Promise((r) => setTimeout(r, 15_000));
        try {
          pty.kill();
        } catch {
          // already gone
        }
        const events = await traceEvents(build.tracePath).catch(() => [] as HookEventName[]);
        expect(
          events,
          `permission.request never fired; requests: ${server.requests.length}; screen: ${JSON.stringify(
            plainScreen().slice(0, 2600),
          )}`,
        ).toContain("permission.request");
        // The deny must prevent the command: the marker never appears.
        expect(
          await readFile(join(dir, "hooknostic-approval.txt"), "utf8").catch(() => null),
          "denied command executed anyway",
        ).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  it(
    "dispatches compaction hooks when the context fills",
    {
      timeout: 240_000,
      skip:
        cellLevel("context.compact.before.observe") === undefined ||
        // The free loopback lane cannot deterministically fill the context:
        // claude caps each shell result (~30k chars) and the drive caps turns
        // (6), so the context never nears the 200k-token limit. The drive
        // below stays for the manual `force_llm` lane, where real turns grow
        // the context naturally. Skipped ≠ silent: the step summary reports
        // the inconclusive lane every run.
        true,
    },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), `hooknostic-compact-${adapter!.id}-`));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      // Each scripted turn is a tool call whose result carries a huge fill
      // payload (see HOOKNOSTIC_PLAYBACK_FILL in harness-playback.ts): after a
      // handful of turns the context is near the limit and the harness must
      // compact, dispatching the before/after hooks.
      process.env["HOOKNOSTIC_PLAYBACK_FILL"] = "hooknostic-fill ".repeat(24_000);
      try {
        await runInstalledHarness(build, "rewrite", {
          // The drive caps claude at 6 turns; "reached max turns" (exit 1) is
          // the expected end state for this drive — the events are what matter.
          script: Array.from({ length: 12 }, () => ({ kind: "tool" as const })),
          expectedExitCodes: [0, 1],
          verify: async () => {},
        });
      } finally {
        delete process.env["HOOKNOSTIC_PLAYBACK_FILL"];
      }
      const events = await traceEvents(build.tracePath);
      expect(
        events,
        `compaction never dispatched; events: ${JSON.stringify(events)}`,
      ).toContain("context.compact.before");
    },
  );
});
