import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

async function runClaudePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
): Promise<void> {
  const server = await startModelPlayback("anthropic-messages", scenario);
  try {
    const result = await runProcess(
      "claude",
      [
        "-p",
        playbackPrompt(scenario),
        "--model",
        "hooknostic-playback",
        "--plugin-dir",
        build.artifactDir,
        "--dangerously-skip-permissions",
        "--max-turns",
        "3",
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
        },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(server.errors).toEqual([]);
    expect(
      server.requests.some(
        (request) =>
          request !== null && typeof request === "object" && "tools" in request,
      ),
      JSON.stringify(server.requests, null, 2),
    ).toBe(true);
  } finally {
    await server.close();
  }
}

async function runCodexPlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
): Promise<void> {
  const server = await startModelPlayback("openai-responses", scenario);
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
        'sandbox_mode="workspace-write"',
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
      ],
      {
        cwd: build.artifactDir,
        input: playbackPrompt(scenario),
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
        },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(server.errors).toEqual([]);
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
  } finally {
    await server.close();
  }
}

async function runOpenCodePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
): Promise<void> {
  const server = await startModelPlayback("openai-chat", scenario);
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
        playbackPrompt(scenario),
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
        },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(server.errors).toEqual([]);
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
  } finally {
    await server.close();
  }
}

async function runInstalledHarness(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
): Promise<void> {
  if (adapter!.id === "claude") await runClaudePlayback(build, scenario);
  else if (adapter!.id === "codex") await runCodexPlayback(build, scenario);
  else await runOpenCodePlayback(build, scenario);
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(adapter === undefined)(`offline harness playback: ${selected || "disabled"}`, () => {
  it("uses exactly the captured reference harness version", async () => {
    const detection = await adapter!.detect!();
    expect(detection.installed, detection.detail).toBe(true);
    expect(detection.version).toBe(adapter!.harness.referenceVersion);
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
});
