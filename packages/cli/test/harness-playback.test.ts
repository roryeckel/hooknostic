import { execSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { IPty, spawn as ptySpawn } from "node-pty";
import { afterAll, describe, expect, it } from "vitest";

import { claudeAgentPluginProjector } from "@hooknostic/adapter-claude";
import { codexAgentPluginProjector } from "@hooknostic/adapter-codex";
import { opencodeAgentPluginProjector } from "@hooknostic/adapter-opencode";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA, loadAgentPlugin } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";
import { adapterFixturesDir, SCENARIOS } from "@hooknostic/testkit";

import { defaultAdapterRegistry } from "../src/registry.js";
import {
  buildPlaybackArtifact,
  openCodePlaybackConfigHome,
  type PlaybackScenario,
  prepareOpenCodePluginDependency,
  replayCommandFixtures,
  replayOpenCodeFixtures,
  runProcess,
  scriptedTool,
  startModelPlayback,
  traceEvents,
} from "./harness-playback.js";

const selected = process.env["HOOKNOSTIC_PLAYBACK"] ?? "";
const adapter = defaultAdapterRegistry()[selected];
const tempDirs: string[] = [];

/** In-repo stdio MCP fixture server (see the file's header for the protocol). */
const McpFixtureServerPath = fileURLToPath(new URL("./mcp-fixture-server.mjs", import.meta.url));
const StdinEofFixturePath = fileURLToPath(new URL("./stdin-eof-fixture.mjs", import.meta.url));
const PluginMcpEnvFixturePath = fileURLToPath(new URL("./plugin-mcp-env-fixture.mjs", import.meta.url));

async function startProjectionMcpTransports(): Promise<{
  httpUrl: string;
  sseUrl: string;
  counts: { http: number; sseGet: number; ssePost: number };
  received: { httpPaths: string[]; authorizations: (string | undefined)[] };
  close(): Promise<void>;
}> {
  const counts = { http: 0, sseGet: 0, ssePost: 0 };
  const received: { httpPaths: string[]; authorizations: (string | undefined)[] } = {
    httpPaths: [],
    authorizations: [],
  };
  let baseUrl = "";
  let sse: ServerResponse | undefined;
  const responseFor = (request: Record<string, unknown>, toolName: string) => {
    if (request.method === "initialize") {
      const parameters = request.params as { protocolVersion?: string } | undefined;
      return {
        protocolVersion: parameters?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: `hooknostic-${toolName}`, version: "1.0.0" },
      };
    }
    if (request.method === "tools/list") {
      return {
        tools: [
          {
            name: toolName,
            description: "Projected transport playback marker.",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        ],
      };
    }
    if (request.method === "ping") return {};
    return { content: [{ type: "text", text: `${toolName}-marker` }] };
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/sse") {
      counts.sseGet += 1;
      sse = response;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`event: endpoint\ndata: ${baseUrl}/sse/messages\n\n`);
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const rpc = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    if (request.method === "POST" && request.url?.startsWith("/http")) {
      counts.http += 1;
      received.httpPaths.push(request.url);
      received.authorizations.push(request.headers.authorization);
      if (rpc.id === undefined) {
        response.writeHead(202).end();
      } else {
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "hooknostic-http-session",
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: responseFor(rpc, "http_probe") }));
      }
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/sse/messages")) {
      counts.ssePost += 1;
      response.writeHead(202).end();
      if (rpc.id !== undefined) {
        sse?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: responseFor(rpc, "sse_probe") })}\n\n`,
        );
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("transport server has no TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    httpUrl: `${baseUrl}/http`,
    sseUrl: `${baseUrl}/sse`,
    counts,
    received,
    async close() {
      sse?.end();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

if (selected !== "" && adapter === undefined) {
  throw new Error(`unknown HOOKNOSTIC_PLAYBACK harness ${JSON.stringify(selected)}`);
}

describe("scriptedTool schema fidelity", () => {
  it("does not invent a description field absent from the declared shell schema", () => {
    const tool = scriptedTool(
      {
        tools: [
          {
            name: "Bash",
            input_schema: { properties: { command: { type: "string" } } },
          },
        ],
      },
      "rewrite",
    );

    expect(JSON.parse(tool.arguments)).toEqual({ command: expect.any(String) });
  });

  it("includes a description when the declared shell schema supports one", () => {
    const tool = scriptedTool(
      {
        tools: [
          {
            name: "Bash",
            input_schema: {
              properties: { command: { type: "string" }, description: { type: "string" } },
            },
          },
        ],
      },
      "rewrite",
    );

    expect(JSON.parse(tool.arguments)).toMatchObject({
      command: expect.any(String),
      description: "Playback probe command",
    });
  });
});

describe("runProcess argument passing", () => {
  const ARGS = ["plain", "has space", 'has "quote"', "100%", "%PATH%", "a&b|c", String.raw`C:\dir with space\file`];
  const echoArgv = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";

  it("passes arguments with spaces to a script at a spaced path intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic run process "));
    try {
      const script = join(dir, "echo argv.mjs");
      await writeFile(script, echoArgv);
      const result = await runProcess("node", [script, ...ARGS], { cwd: dir, env: process.env, timeoutMs: 10_000 });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(ARGS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // npm installs harness CLIs on Windows as .cmd shims that forward %*.
  it.skipIf(process.platform !== "win32")("passes arguments through an npm-style .cmd shim intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic run process "));
    try {
      await writeFile(join(dir, "echo-argv.mjs"), echoArgv);
      await writeFile(join(dir, "echo-argv.cmd"), '@node "%~dp0\\echo-argv.mjs" %*\r\n');
      const env = { ...process.env, PATH: `${dir};${process.env["PATH"] ?? ""}` };
      const result = await runProcess("echo-argv", ARGS, { cwd: dir, env, timeoutMs: 10_000 });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(ARGS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("model playback cleanup", () => {
  it("closes child stdin when no input is supplied", async () => {
    const result = await runProcess("node", [StdinEofFixturePath], {
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ code: 0, stdout: "stdin-eof\n", stderr: "" });
  });

  it("closes with idle client connections still open", async () => {
    const server = await startModelPlayback("openai-chat");
    const socket = connect(Number(new URL(server.baseUrl).port), "127.0.0.1");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.once("connect", resolvePromise);
      socket.once("error", rejectPromise);
    });

    const close = server.close();
    const result = await Promise.race([
      close.then(() => true),
      new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 250)),
    ]);
    socket.destroy();
    await close;
    expect(result).toBe(true);
  });
});

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
  if (scenario === "continuation") {
    return "Use the shell tool once to print hooknostic-block-continuation, then stop.";
  }
  return "Use the shell tool once to run a command that exits 17, then stop.";
}

async function waitForTraceEvent(path: string, event: HookEventName, timeoutMs = 30_000): Promise<HookEventName[]> {
  const deadline = Date.now() + timeoutMs;
  let events: HookEventName[] = [];
  while (Date.now() < deadline) {
    events = await traceEvents(path).catch(() => []);
    if (events.includes(event)) return events;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return events;
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
   * Defaults to true; disable only for scenarios where the hook's expected
   * effect is that the turn never starts (prompt-block): there the absence
   * IS the assertion.
   */
  requireAgentRequest?: boolean;
  /** Extra CLI args appended to the harness invocation (e.g. stream-json output). */
  extraArgs?: readonly string[];
  /** Run the harness from a nested project directory while retaining root ownership. */
  harnessCwd?: string;
  /**
   * Path to the in-repo stdio MCP fixture server; registers it with the
   * harness (Codex: `mcp_servers.*`), enabling the MCP-only drive.
   */
  mcpServerPath?: string;
  /**
   * opencode-serve lane only: a hook event the drive must observe in the trace
   * BEFORE it tears the server down.
   *
   * The drive's own completion signal is `server.turnCount >= 2`, which for
   * these scenarios is the model's scripted text completion -- one step BEFORE
   * the session goes idle. Every observable that lands at idle (`turn.stop`,
   * and the promptAsync post that stop-prevention and notify depend on) is
   * therefore produced AFTER the drive would otherwise kill the server, and a
   * scenario asserting on it is racing teardown by a few hundred milliseconds.
   * Losing that race is unrecoverable: the later `waitForTraceEvent` polls a
   * file no live process can still append to, so it burns its whole timeout
   * and reports the event as absent rather than as late.
   *
   * Naming the observable here makes teardown wait for the thing the scenario
   * is about, instead of for a proxy that happens to precede it.
   */
  awaitTraceEvent?: HookEventName;
  /**
   * opencode-serve lane only: how many model turns the drive polls for before
   * it stops waiting. Defaults to 2 -- a scripted tool call and its completion.
   *
   * Scenarios whose claim IS an extra turn must raise this. Two turns are what
   * the script alone produces, so on this lane `turnCount >= 2` is evidence of
   * nothing beyond the script running.
   */
  minTurns?: number;
  /** Captures the raw harness stdout/stderr for scenario-level diagnostics. */
  capture?: (raw: { stdout: string; stderr: string; code: number | null }) => void;
  /**
   * One message from the OpenCode serve transcript API (GET /session/:id/message).
   */
  serve?: {
    /** The drive's own session id. */
    sessionId: string;
    /** Fresh transcript read; each call re-fetches. */
    messages: () => Promise<ServeMessage[]>;
  };
  /** Extra per-drive assertions once the session ended cleanly. */
  verify?: (outcome: {
    server: Awaited<ReturnType<typeof startModelPlayback>>;
    dir: string;
    /** Present only on the opencode-serve lane. */
    serve?: OpenCodeServeSession;
  }) => Promise<void>;
  /** Extra provider-config keys for the opencode lanes (e.g. permission rules). */
  opencodeConfig?: { permission?: Record<string, string>; mcp?: Record<string, Record<string, unknown>> };
}

/** A message row from OpenCode's GET /session/:id/message (smoke-proven shape). */
interface ServeMessage {
  info?: { role?: string };
  parts?: { type?: string; text?: string }[];
}

/** Transcript access for drives on the opencode-serve lane. */
interface OpenCodeServeSession {
  sessionId: string;
  messages: () => Promise<ServeMessage[]>;
}

/* eslint-disable no-control-regex -- ANSI stripping needs the escape control char */

async function runClaudePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  const isolatedConfig = await prepareClaudePtyConfig(build.artifactDir);
  const server = await startModelPlayback("anthropic-messages", scenario, options.script);
  try {
    const mcpConfigPath = join(build.artifactDir, "mcp-playback.json");
    if (options.mcpServerPath !== undefined) {
      await writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            hooknostic_fixture: {
              type: "stdio",
              command: "node",
              args: [options.mcpServerPath],
            },
          },
        }),
        "utf8",
      );
    }
    const result = await runProcess(
      "claude",
      [
        "-p",
        options.prompt ?? playbackPrompt(scenario),
        "--model",
        "hooknostic-playback",
        ...(build.project ? [] : ["--plugin-dir", build.artifactDir]),
        "--dangerously-skip-permissions",
        "--max-turns",
        "6",
        ...(options.mcpServerPath !== undefined ? ["--strict-mcp-config", "--mcp-config", mcpConfigPath] : []),
        ...(options.extraArgs ?? []),
      ],
      {
        cwd: options.harnessCwd ?? build.artifactDir,
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          CLAUDE_CONFIG_DIR: isolatedConfig,
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
    options.capture?.({ stdout: result.stdout, stderr: result.stderr, code: result.code });
    expect(server.errors).toEqual([]);
    if (options.requireAgentRequest === false) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some((request) => request !== null && typeof request === "object" && "tools" in request),
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
        cwd: options.harnessCwd ?? build.artifactDir,
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
    if (options.requireAgentRequest === false) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some((request) => request !== null && typeof request === "object" && "tools" in request),
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
    await prepareOpenCodePluginDependency(
      build.artifactDir,
      process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? adapter!.harness.referenceVersion,
    );
    await writeOpenCodeProviderConfig(build.artifactDir, server.baseUrl, {
      ...options.opencodeConfig,
      ...(options.mcpServerPath !== undefined ? { mcpServerPath: options.mcpServerPath } : {}),
    });
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(
        "opencode",
        [
          "run",
          options.prompt ?? playbackPrompt(scenario),
          "--model",
          "playback/hooknostic-playback",
          "--print-logs",
          "--log-level",
          "DEBUG",
        ],
        {
          cwd: build.artifactDir,
          timeoutMs: 90_000,
          env: {
            ...withoutCredentials(),
            PWD: build.artifactDir,
            XDG_CONFIG_HOME: openCodePlaybackConfigHome(build.artifactDir),
            HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
            ...(options.effects ? { HOOKNOSTIC_PLAYBACK_EFFECTS: options.effects.join(",") } : {}),
          },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nserverErrors: ${JSON.stringify(server.errors)}\nurls: ${JSON.stringify(server.urls)}\nrequests: ${JSON.stringify(server.requests)}`,
      );
    }
    expect(
      options.expectedExitCodes ?? [0],
      `opencode exit ${result.code}: ${result.stdout}\n${result.stderr}`,
    ).toContain(result.code);
    options.capture?.({ stdout: result.stdout, stderr: result.stderr, code: result.code });
    expect(server.errors).toEqual([]);
    if (options.requireAgentRequest === false) {
      await options.verify?.({ server, dir: build.artifactDir });
      return;
    }
    expect(
      server.requests.some((request) => request !== null && typeof request === "object" && "tools" in request),
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

/** The playback provider config every OpenCode drive needs in the artifact dir. */
async function writeOpenCodeProviderConfig(
  artifactDir: string,
  baseUrl: string,
  options: {
    permission?: Record<string, string>;
    mcp?: Record<string, Record<string, unknown>>;
    mcpServerPath?: string;
    // Package-delivery plugins, named the way a consuming project names them.
    //
    // A relative entry resolves against the declaring config file's own
    // directory -- intended OpenCode behaviour, not a bug
    // (.capture/opencode-plugin-routes). This helper writes the config at the
    // project root, so a relative path here would be project-root relative and
    // would work; the drives pass absolute paths because the package they name
    // deliberately lives outside the project.
    plugin?: readonly string[];
  } = {},
): Promise<void> {
  const mcp = {
    ...(options.mcp ?? {}),
    ...(options.mcpServerPath === undefined
      ? {}
      : {
          hooknostic_fixture: {
            type: "local",
            command: ["node", options.mcpServerPath],
            enabled: true,
          },
        }),
  };
  await writeFile(
    join(artifactDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "playback/hooknostic-playback",
        enabled_providers: ["playback"],
        ...(options.plugin === undefined ? {} : { plugin: [...options.plugin] }),
        ...(options.permission !== undefined ? { permission: options.permission } : {}),
        ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
        provider: {
          playback: {
            npm: "@ai-sdk/openai-compatible",
            name: "Hooknostic Playback",
            options: { baseURL: `${baseUrl}/v1`, apiKey: "hooknostic-playback" },
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
}

/**
 * The opencode-serve driver (ADR-0010): a persistent `opencode serve` instead
 * of `opencode run`. `run` exits at session.idle, before a promptAsync-posted
 * turn can start, so stop prevention is inert there (captured:
 * .capture/opencode-client) — the server lane is the only vehicle where the
 * prevent channel is observable. The session is driven over OpenCode's HTTP
 * API; the plugin posts into the same server from inside the process.
 */
async function runOpenCodeServePlayback(
  build: Awaited<ReturnType<typeof buildPlaybackArtifact>>,
  scenario: PlaybackScenario,
  options: DriveOptions = {},
): Promise<void> {
  const server = await startModelPlayback("openai-chat", scenario, options.script);
  // The serve lane must be an independent instance. The parent environment of
  // an opencode-hosted session carries OPENCODE=1 / OPENCODE_PID (the host's
  // own `opencode serve`); anything left set links this child to that daemon
  // instead of starting fresh — and the daemon's credential is enforced on its
  // port, so a reachability-only probe can silently interrogate the wrong
  // server. Strip the linkage, pin a known Basic credential for the drive's
  // own server (OPENCODE_SERVER_PASSWORD is otherwise inherited from whatever
  // host launched us), and verify identity via the session API below.
  const port = await freePort();
  const servePassword = "hooknostic-playback-serve";
  const serveEnv: Record<string, string | undefined> = {
    ...withoutCredentials(),
    PWD: build.artifactDir,
    XDG_CONFIG_HOME: openCodePlaybackConfigHome(build.artifactDir),
    // Same env contract as the `opencode run` drive: the generated plugin
    // traces to this file and gates its effects on this list.
    HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
    ...(options.effects ? { HOOKNOSTIC_PLAYBACK_EFFECTS: options.effects.join(",") } : {}),
    OPENCODE_SERVER_PASSWORD: servePassword,
    OPENCODE_SERVER_USERNAME: "hooknostic",
  };
  delete serveEnv["OPENCODE"];
  delete serveEnv["OPENCODE_PID"];
  delete serveEnv["OPENCODE_BINARY"];
  delete serveEnv["OPENCODE_CONFIG_CONTENT"];
  const authHeaders = {
    authorization: `Basic ${Buffer.from(`hooknostic:${servePassword}`).toString("base64")}`,
  };
  // git init + provider config must precede the server: the plugin resolves
  // from the project directory at server start.
  await runProcess("git", ["init"], {
    cwd: build.artifactDir,
    env: process.env,
    timeoutMs: 30_000,
  });
  await prepareOpenCodePluginDependency(
    build.artifactDir,
    process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? adapter!.harness.referenceVersion,
  );
  await writeOpenCodeProviderConfig(build.artifactDir, server.baseUrl, {
    ...options.opencodeConfig,
    ...(options.mcpServerPath !== undefined ? { mcpServerPath: options.mcpServerPath } : {}),
  });
  const child = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
    cwd: build.artifactDir,
    shell: process.platform === "win32",
    // PWD must agree with cwd (validated live on 1.18.25: opencode trusts an
    // inherited PWD and would run the session in a second instance's project,
    // where no plugins exist). The runOpenCodePlayback drive already does this
    // for the same reason.
    env: serveEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveStderr = "";
  let serveStdout = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (serveStderr += chunk));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (serveStdout += chunk));
  const stopServer = async (): Promise<void> => {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      child.kill();
      return;
    }
    // With shell:true the handle is cmd.exe; kill() would orphan the real
    // server holding the port and scratch dir (same tree-kill the smoke uses).
    await new Promise<void>((resolvePromise) => {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("close", () =>
        resolvePromise(),
      );
    });
  };
  try {
    const serveBase = `http://127.0.0.1:${port}`;
    const base = serveBase;
    // Ready = /app answers 200 to OUR pinned credential. Reachability alone is
    // not enough: if a parent opencode daemon already listens nearby, a 401
    // from it would otherwise be mistaken for our server being slow, and the
    // drive would interrogate the wrong instance (the daemon rejects foreign
    // credentials). A 200 to the pinned credential can only come from the
    // server we just spawned with that exact env.
    let lastStatus: number | string = "unreachable";
    let up = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${base}/app`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(5_000),
        });
        lastStatus = response.status;
        if (response.ok) {
          up = true;
          break;
        }
      } catch (error) {
        lastStatus = String(error).slice(0, 120);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      up,
      `opencode serve never became ready with the drive's pinned credential (last probe: ${lastStatus})\nstdout: ${serveStdout.slice(0, 1500)}\nstderr: ${serveStderr.slice(-1500)}`,
    ).toBe(true);

    const session = (await (
      await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      })
    ).json()) as { id: string };

    // OpenCode's documented async endpoint acknowledges acceptance with 204;
    // completion is observed independently below. This avoids treating the
    // synchronous /message response as a lifecycle signal while the plugin
    // posts back into the same session.
    const promptResponse = await fetch(`${base}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        model: { providerID: "playback", modelID: "hooknostic-playback" },
        parts: [{ type: "text", text: options.prompt ?? playbackPrompt(scenario) }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (promptResponse.status !== 204) {
      const body = await promptResponse.text().catch(() => "");
      throw new Error(
        `OpenCode async prompt returned ${promptResponse.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
    }

    // prompt_async returns before the turn completes. Poll the model side so
    // the drive can observe both the original tool-call turn and its completion
    // (or the extra turn posted by stop prevention).
    const postedTurns = await (async (): Promise<number> => {
      const wanted = options.minTurns ?? 2;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (server.turnCount >= wanted) return server.turnCount;
        await new Promise((r) => setTimeout(r, 500));
      }
      return server.turnCount;
    })();
    // Before teardown, not after: see DriveOptions.awaitTraceEvent. A miss is
    // left to the scenario's own assertion, which reports the trace it got.
    if (options.awaitTraceEvent !== undefined) {
      await waitForTraceEvent(build.tracePath, options.awaitTraceEvent);
    }
    options.capture?.({
      stdout: `served turns: ${postedTurns}`,
      stderr: serveStderr,
      code: 0,
    });
    expect(server.errors, `loopback errors: ${JSON.stringify(server.errors)}`).toEqual([]);
    await options.verify?.({
      server,
      dir: build.artifactDir,
      // The session transcript API, authenticated with the drive's pinned
      // credential: GET returns every message (info.role + text parts), the
      // surface where promptAsync-posted notifications land (captured:
      // .capture/opencode-client -- user-role message, no turn of its own).
      serve: {
        sessionId: session.id,
        messages: async () =>
          (await (
            await fetch(`${serveBase}/session/${session.id}/message`, {
              headers: authHeaders,
              signal: AbortSignal.timeout(5_000),
            })
          ).json()) as ServeMessage[],
      },
    });
  } finally {
    await stopServer();
    await server.close();
  }
}

/** A free TCP port the OS is not holding (bind-and-close race is acceptable here). */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePromise, rejectPromise) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address() as { port: number };
      srv.close(() => resolvePromise(address.port));
    });
    srv.on("error", rejectPromise);
  });
}

/**
 * The registry-to-drive map (ADR-0010): every scenario id in
 * `packages/testkit/src/scenarios.ts` must be registered here with a drive
 * that actually exercises it. `describeScenarioCoverage` only checks that a
 * capability cell appears in some scenario's `covers`; this map is the other
 * half of the contract — a scenario with no executable drive (or a deleted
 * drive) fails the gate below instead of reporting phantom coverage.
 */
const scenarioDrives = new Map<string, { drive: () => Promise<void>; skip: () => boolean }>();

function scenarioDrive(id: string, drive: () => Promise<void>, skip: () => boolean = () => false): void {
  scenarioDrives.set(id, { drive, skip });
}

/** A declared scheduled-lane limitation takes precedence over a local skip. */
function scenarioSkipReason(scenario: (typeof SCENARIOS)[number], entry: { skip: () => boolean }): string | undefined {
  const declared = adapter === undefined ? undefined : scenario.inconclusiveByHarness?.[adapter.id];
  if (declared !== undefined) return declared;
  return entry.skip() ? "the scenario driver is unavailable in this environment" : undefined;
}

afterAll(async () => {
  // Windows: a pty-killed harness releases its CWD asynchronously, so an
  // immediate recursive rm can hit EBUSY while claude.exe is still tearing
  // down. Retry briefly before giving up — a leaked scratch dir must not turn
  // a passing drive into a suite failure.
  await Promise.all(
    tempDirs.map(async (dir) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }),
  );
  // The explicit budget is what makes the paragraph above true. Vitest's
  // default hook timeout is 10s, and this hook can legitimately need more: the
  // OpenCode drives leave a scratch directory per cell, each holding two full
  // `@opencode-ai/plugin` installs, and a recursive delete of that many small
  // files on Windows is slow before the retry sleeps are counted. Exceeding the
  // default reported `Failed Suites 1` with every test passing — precisely the
  // "a leaked scratch dir must not fail a passing drive" outcome this hook
  // exists to prevent, arrived at through the cleanup rather than the leak.
}, 120_000);

/** The adapter's resolved level for a cell at its own referenceVersion. */
function cellLevel(id: string): string | undefined {
  if (adapter === undefined) return undefined;
  const resolution = adapter.capabilities({
    id: adapter!.id,
    version: adapter!.harness.referenceVersion,
    delivery: "project",
    output: ".",
  });
  return resolution.matrix?.[id as keyof NonNullable<typeof resolution.matrix>]?.level;
}

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

// Text of every `role: "system"` message in one recorded request, for the
// OpenAI-compatible playback path (`messages: [{ role, content }]`, content a
// string or an array of text parts).
function systemMessageTexts(request: unknown): string[] {
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is { role: string; content: unknown } => (m as { role?: unknown })?.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((part) =>
                typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
              )
              .join("")
          : "",
    );
}

// Indices of recorded requests whose SYSTEM MESSAGES do not carry `marker`.
//
// Deliberately NOT a recursive string walk over the request. The channel this
// asserts has an inert twin: writing the same text through chat.params puts it
// in the request body as a top-level `systemPrompt` field, where no
// OpenAI-compatible API reads it (.capture/opencode-context-channel). A walk
// over every string would accept that regression, which is precisely the
// failure the cell exists to exclude. It also keeps the per-request boundary,
// which a flat requestContents() over the whole recording loses.
function requestsWithoutMarker(requests: readonly unknown[], marker: string): number[] {
  return requests.flatMap((request, index) =>
    systemMessageTexts(request).some((t) => t.includes(marker)) ? [] : [index],
  );
}

// --- pty-approval lane ----------------------------------------------------
// Interactive-only cells (Claude permission.request.*, tool.before
// requestApproval) need a real pseudo-terminal: headless `-p` sessions decide
// without prompting. The drive starts the interactive TUI under node-pty,
// walks the first-run dialogs, sends a prompt whose scripted tool call trips
// the approval prompt, and lets the hook answer it â€” proven by the trace.
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

/**
 * The Claude binary for the pty drives. Never hard-code an author's install
 * path: an explicit override wins, then PATH resolution, then a clear error.
 */
function claudeBinaryPath(): string {
  const override = process.env["HOOKNOSTIC_CLAUDE_BIN"];
  if (override !== undefined && override !== "") return override;
  const probe = process.platform === "win32" ? "where claude" : "which claude";
  try {
    const resolved = execSync(probe, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => (process.platform === "win32" ? /\.(?:exe|cmd|bat)$/i.test(line) : line !== ""));
    if (resolved !== undefined) return resolved;
  } catch {
    // fall through to the error below
  }
  throw new Error("claude binary not found: set HOOKNOSTIC_CLAUDE_BIN or add claude to PATH");
}

function spawnClaudePty(args: string[], options: Parameters<typeof ptySpawn>[2]): IPty {
  const binary = claudeBinaryPath();
  // A Windows npm shim is a batch file, which ConPTY cannot execute directly.
  // Let cmd interpret the shim; native executables still run directly.
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)
    ? ptyModule!.spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", binary, ...args], options)
    : ptyModule!.spawn(binary, args, options);
}

// Constructed playback-only state. See .capture/harness-playback/README.md.
async function prepareClaudePtyConfig(dir: string): Promise<string> {
  const configDir = join(dir, "claude-config");
  await mkdir(configDir);
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] },
    }),
  );
  return configDir;
}

// --- first-run dialog walk (pty drives) ------------------------------------
// A fresh machine (CI) renders a different first-run sequence than a box with
// local state, and the order moved between versions: 2.1.238 fresh renders
// theme -> custom API key -> security notes -> trust, while 2.1.250 with
// local state renders trust first and the API-key dialog only when the key
// is not already accepted (both observed in the raw pty streams). So the
// walk reacts to each dialog's own text instead of a fixed sequence and
// answers every dialog at most once. The TUI emits spaces inconsistently
// (sometimes as literal spaces, sometimes as cursor-right escapes), so
// matching runs against a whitespace-stripped screen.
const DIALOG_SETTLE_MS = 600;

function dialogScreen(plainScreen: () => string): string {
  return plainScreen().replace(/\s+/g, "");
}

function mainPromptVisible(plainScreen: () => string): boolean {
  const current = dialogScreen(plainScreen).slice(-2500);
  const marker = Math.max(current.lastIndexOf("\u276f"), current.lastIndexOf(">"));
  if (marker === -1) return false;
  // List dialogs leave their selected option immediately after the cursor;
  // the main input line is followed by status text instead. This survives
  // Claude rendering the cursor's trailing space as a cursor movement.
  return !/^(?:\d+\.?)?(?:Yes|No|Claudeaccount|AnthropicConsoleaccount|3rd-partyplatform)/.test(
    current.slice(marker + 1),
  );
}

describe("Claude PTY prompt recognition", () => {
  it("recognizes the Windows ASCII prompt cursor", () => {
    expect(mainPromptVisible(() => ">  ? for shortcuts")).toBe(true);
    expect(mainPromptVisible(() => "> No, exit")).toBe(false);
    expect(mainPromptVisible(() => "> Yes, I trust this folder")).toBe(false);
  });
});

async function waitForMainPrompt(plainScreen: () => string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mainPromptVisible(plainScreen)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Confirm a list dialog with the wanted option selected, wherever the cursor
 * currently sits. The live selection is the most recently rendered frame
 * (ink repaints only the changed lines, so the last cursor marker on the
 * screen belongs to the current frame); poll and nudge with the up key — the
 * select widget wraps — until the wanted option is selected, then Enter.
 * Selection detection strips whitespace (adjacent options run together:
 * "YesNo (recommended)") and optional "1."-style option numbers (2.1.238
 * numbers options, 2.1.250 does not), then reads the label that follows the
 * last cursor marker.
 */
async function confirmDialogSelection(pty: IPty, screen: () => string, wantedPrefix: string): Promise<void> {
  const selected = (): boolean => {
    const stripped = screen().slice(-2500);
    const marker = Math.max(stripped.lastIndexOf("\u276f"), stripped.lastIndexOf(">"));
    if (marker === -1) return false;
    return stripped
      .slice(marker + 1)
      .replace(/^[0-9]*\.?/, "")
      .startsWith(wantedPrefix);
  };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (selected()) break;
    pty.write("\u001b[A");
    await new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS));
  }
  if (!selected()) {
    pty.kill();
    throw new Error(`Claude playback could not select ${wantedPrefix}`);
  }
  pty.write("\r");
  await new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS));
}

async function walkFirstRunDialogs(pty: IPty, plainScreen: () => string, timeoutMs = 60_000): Promise<void> {
  const screen = (): string => dialogScreen(plainScreen);
  const handled = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = screen();
    if (!handled.has("theme") && current.includes("Choosethetextstyle")) {
      handled.add("theme");
      // Any theme works: confirm the preselected entry.
      pty.write("\r");
      await new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS));
    } else if (!handled.has("api-key") && current.includes("DoyouwanttousethisAPIkey")) {
      handled.add("api-key");
      // Fresh state preselects "No (recommended)"; the loopback key must be
      // accepted or the harness discards the env key entirely and falls into
      // the OAuth login flow, which cannot complete in playback.
      await confirmDialogSelection(pty, screen, "Yes");
    } else if (current.includes("Selectloginmethod:")) {
      pty.kill();
      throw new Error("Claude playback reached login onboarding instead of using the loopback API key");
    } else if (!handled.has("security") && current.includes("PressEnte")) {
      handled.add("security");
      pty.write("\r");
      await new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS));
    } else if (!handled.has("terminal-setup") && current.includes("terminalsetup?")) {
      handled.add("terminal-setup");
      // Recent Claude versions add this optional setup after the security
      // notes. Accept the preselected recommended settings so the main input
      // becomes available to the PTY drive.
      pty.write("\r");
      await new Promise((r) => setTimeout(r, DIALOG_SETTLE_MS));
    } else if (!handled.has("trust") && current.includes("Quicksafetycheck")) {
      handled.add("trust");
      // The preselected trust entry moved between versions (2.1.238 fresh
      // defaults to "Yes"; the walk must not assume it).
      await confirmDialogSelection(pty, screen, "Yes,Itrustthisfolder");
    } else if (mainPromptVisible(plainScreen)) {
      // Onboarding is done when the main TUI input line renders. Check this
      // only after known dialogs so stale frames cannot hide a later dialog.
      return;
    } else {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
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

  it("runs repository-local integration without installing a plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-local-playback-"));
    tempDirs.push(dir);
    const transports = await startProjectionMcpTransports();
    const source = join(dir, "portable");
    await mkdir(join(source, "mcp-working-dir"), { recursive: true });
    await writeFile(join(source, "plugin-mcp-env-fixture.mjs"), await readFile(PluginMcpEnvFixturePath));
    const skillSource = join(dir, "portable-skills/local-sample");
    await mkdir(skillSource, { recursive: true });
    await writeFile(
      join(skillSource, "SKILL.md"),
      "---\nname: local-sample\ndescription: local-skill-marker\n---\nSynthetic playback skill.\n",
    );
    const projectCwdOverride = adapter!.id === "claude" ? "./mcp-working-dir" : "${PLUGIN_ROOT}/..";
    const build = await buildPlaybackArtifact(adapter!, dir, {
      delivery: "project",
      project: true,
      componentOptions: {
        ...(adapter!.id === "claude"
          ? {}
          : { mcpProjectCwdServers: ["localProbe"], mcpStartupTimeoutMs: { localProbe: 60_000 } }),
      },
      components: {
        origin: "direct",
        skills: [
          {
            name: "local-sample",
            source: skillSource,
            files: [
              {
                path: "SKILL.md",
                mode: 0o644,
                contents: new TextEncoder().encode(
                  "---\nname: local-sample\ndescription: local-skill-marker\n---\nSynthetic playback skill.\n",
                ),
              },
            ],
          },
        ],
        mcp: {
          root: source,
          config: {
            $schema: AGENT_PLUGIN_MCP_SCHEMA,
            mcpServers: {
              localProbe: {
                type: "stdio" as const,
                command: "node",
                args: ["${PLUGIN_ROOT}/plugin-mcp-env-fixture.mjs", "${PLUGIN_DATA}", adapter!.id],
                env: { CAPTURE_PATH: "${PLUGIN_ROOT}/mcp-environment.json" },
                cwd: projectCwdOverride,
              },
              localHttp: {
                type: "streamable-http" as const,
                url:
                  adapter!.id === "claude"
                    ? transports.httpUrl + "/${HOOKNOSTIC_PLAYBACK_REMOTE_PATH}"
                    : transports.httpUrl,
                ...(adapter!.id === "claude"
                  ? { headers: { Authorization: "Bearer ${HOOKNOSTIC_PLAYBACK_REMOTE_HEADER}" } }
                  : {}),
              },
              ...(adapter!.id === "opencode"
                ? {
                    missingRemote: {
                      type: "streamable-http" as const,
                      url: "https://example.invalid/${HOOKNOSTIC_PLAYBACK_UNSET_REMOTE}/mcp",
                    },
                  }
                : {}),
              ...(adapter!.id === "codex" ? {} : { localSse: { type: "sse" as const, url: transports.sseUrl } }),
            },
          },
        },
      },
    });
    const harnessCwd = adapter!.id === "codex" ? join(dir, "nested/session") : dir;
    await mkdir(harnessCwd, { recursive: true });
    let harnessOutput = "";
    if (adapter!.id === "claude") {
      process.env["HOOKNOSTIC_PLAYBACK_REMOTE_PATH"] = "expanded-path";
      process.env["HOOKNOSTIC_PLAYBACK_REMOTE_HEADER"] = "expanded-header";
    }
    try {
      await runInstalledHarness(build, "rewrite", {
        harnessCwd,
        ...(adapter!.id === "claude"
          ? { extraArgs: ["--strict-mcp-config", "--mcp-config", join(dir, ".mcp.json")] }
          : {}),
        ...(adapter!.id === "opencode"
          ? {
              opencodeConfig: {
                mcp: {
                  localProbe: { type: "remote", url: "https://inherited.invalid/mcp", enabled: true },
                  inheritedOnly: { type: "remote", url: "https://example.invalid/inherited", enabled: false },
                },
              },
            }
          : {}),
        capture: ({ stdout, stderr }) => {
          harnessOutput = stdout + stderr;
        },
        verify: async ({ server }) => {
          expect(requestContents(server.requests).join("\n")).toContain("local-skill-marker");
          {
            const environment = JSON.parse(await readFile(join(source, "mcp-environment.json"), "utf8"));
            expect(normalize(environment.pluginRoot)).toBe(normalize(source));
            expect(normalize(environment.cwd)).toBe(
              normalize(adapter!.id === "claude" ? join(source, "mcp-working-dir") : dir),
            );
            expect(normalize(environment.pluginData)).toBe(normalize(join(dir, ".hooknostic/data")));
            expect(environment.argv).toEqual([environment.pluginData, adapter!.id]);
            expect(transports.counts.http).toBeGreaterThan(0);
            if (adapter!.id === "claude") {
              expect(transports.received.httpPaths).toContain("/http/expanded-path");
              expect(transports.received.authorizations).toContain("Bearer expanded-header");
            }
            if (adapter!.id !== "codex") {
              expect(transports.counts.sseGet).toBeGreaterThan(0);
              expect(transports.counts.ssePost).toBeGreaterThan(0);
            }
          }
        },
      });
    } finally {
      delete process.env["HOOKNOSTIC_PLAYBACK_REMOTE_PATH"];
      delete process.env["HOOKNOSTIC_PLAYBACK_REMOTE_HEADER"];
      await transports.close();
    }
    if (adapter!.id === "opencode") {
      expect(harnessOutput).toContain("Hooknostic disabled MCP");
      expect(harnessOutput).toContain("HOOKNOSTIC_PLAYBACK_UNSET_REMOTE");
    }
    const events = await traceEvents(build.tracePath);
    expect(events).toContain("tool.before");
  }, 180_000);

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

  it.skipIf(adapter?.id !== "claude")(
    "discovers a projected skill, starts all MCP transports with native variables, and runs combined hooks",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-projection-playback-"));
      tempDirs.push(dir);
      const hookBuild = await buildPlaybackArtifact(adapter!, join(dir, "hook-build"));
      const transports = await startProjectionMcpTransports();
      const portable = join(dir, "portable");
      const projectDir = join(dir, "project");
      await mkdir(projectDir);
      await mkdir(join(portable, "mcp-working-dir"), { recursive: true });
      await writeFile(join(portable, "mcp-working-dir/README.md"), "MCP working directory fixture.\n");
      await mkdir(join(portable, "skills/projection-probe"), { recursive: true });
      await writeFile(
        join(portable, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
          name: "projection-playback",
          version: "1.0.0",
          description: "No-spend Agent Plugin projection playback fixture.",
          author: { name: "Hooknostic contributors" },
        }),
      );
      await writeFile(
        join(portable, "skills/projection-probe/SKILL.md"),
        "---\nname: projection-probe\ndescription: Exercise projected plugin discovery.\n---\nHOOKNOSTIC_SKILL_DISCOVERY_MARKER\n",
      );
      await writeFile(
        join(portable, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            projection: {
              type: "stdio",
              command: "node",
              args: ["${PLUGIN_ROOT}/plugin-mcp-env-fixture.mjs", "${PLUGIN_DATA}"],
              env: { CAPTURE_PATH: "${PLUGIN_ROOT}/mcp-environment.json" },
              cwd: "./mcp-working-dir",
            },
            projectedHttp: { type: "streamable-http", url: transports.httpUrl },
            projectedSse: { type: "sse", url: transports.sseUrl },
          },
        }),
      );
      await writeFile(join(portable, "plugin-mcp-env-fixture.mjs"), await readFile(PluginMcpEnvFixturePath));
      const loaded = await loadAgentPlugin({ root: portable });
      expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      const hookArtifacts = await Promise.all(
        ["hooks/hooks.json", "runtime/hooknostic.mjs"].map(async (path) => ({
          path,
          contents: await readFile(join(hookBuild.artifactDir, path)),
        })),
      );
      const plan = await claudeAgentPluginProjector.project(loaded.package!, {
        target: {
          id: "claude",
          version: adapter!.harness.referenceVersion,
          delivery: "package",
          output: ".",
        },
        hookArtifacts,
        support: claudeAgentPluginProjector.profiles[0]!.components,
        onUnsupported: "error",
      });
      expect(plan.issues).toEqual([]);
      const pluginDir = join(dir, "plugin");
      for (const artifact of plan.files) {
        const path = join(pluginDir, artifact.path);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, artifact.contents, { mode: artifact.mode });
      }
      const validation = await runProcess("claude", ["plugin", "validate", "--strict", pluginDir], {
        cwd: dir,
        env: process.env,
        timeoutMs: 30_000,
      });
      expect(validation.code, validation.stdout + validation.stderr).toBe(0);

      const server = await startModelPlayback("anthropic-messages", "rewrite", [
        { kind: "tool", toolName: "projection_echo" },
        { kind: "text", text: "projection complete" },
      ]);
      try {
        const result = await runProcess(
          "claude",
          [
            "-p",
            "/projection-probe",
            "--model",
            "hooknostic-playback",
            "--plugin-dir",
            pluginDir,
            "--dangerously-skip-permissions",
            "--max-turns",
            "3",
          ],
          {
            cwd: projectDir,
            timeoutMs: 90_000,
            env: {
              ...withoutCredentials(),
              ANTHROPIC_API_KEY: "hooknostic-playback",
              ANTHROPIC_BASE_URL: server.baseUrl,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
              DISABLE_AUTOUPDATER: "1",
              DISABLE_TELEMETRY: "1",
              HOOKNOSTIC_PLAYBACK_TRACE: hookBuild.tracePath,
            },
          },
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(server.errors).toEqual([]);
        expect(JSON.stringify(server.requests)).toContain("HOOKNOSTIC_SKILL_DISCOVERY_MARKER");
        const environment = JSON.parse(await readFile(join(pluginDir, "mcp-environment.json"), "utf8"));
        expect(normalize(environment.pluginRoot)).toBe(pluginDir);
        expect(normalize(environment.cwd)).toBe(join(pluginDir, "mcp-working-dir"));
        expect(environment.pluginData).toBeTypeOf("string");
        expect(environment.argv).toEqual([environment.pluginData]);
        expect(transports.counts.http).toBeGreaterThan(0);
        expect(transports.counts.sseGet).toBeGreaterThan(0);
        expect(transports.counts.ssePost).toBeGreaterThan(0);
        expect(await readFile(hookBuild.tracePath, "utf8")).toContain('"event":"prompt.before"');
      } finally {
        await Promise.all([server.close(), transports.close()]);
      }
    },
    120_000,
  );

  // The Codex half of the same claim the Claude lane above establishes, and the
  // reason no paid probe is needed for it: `.capture/codex-native-mcp` already
  // recorded that the native route binds neither variable and that a declared
  // `cwd: "."` reaches the plugin root, so what is left to show is that a real
  // installed plugin starts its server THROUGH the generated launcher and that
  // both variables arrive. CODEX_HOME keeps the install off the contributor's
  // own configuration (.capture/codex-isolated-home).
  it.skipIf(adapter?.id !== "codex")(
    "starts a projected MCP server through the generated launcher",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-projection-"));
      tempDirs.push(dir);
      const portable = join(dir, "portable");
      const marketplace = join(dir, "marketplace");
      const pluginSource = join(marketplace, "plugins", "projection-playback");
      const codexHome = join(dir, "codex-home");
      const projectDir = join(dir, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(portable, "mcp-working-dir"), { recursive: true });
      await writeFile(join(portable, "mcp-working-dir/README.md"), "MCP working directory fixture.\n");
      await mkdir(join(portable, "skills/projection-probe"), { recursive: true });
      await writeFile(
        join(portable, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
          name: "projection-playback",
          version: "1.0.0",
          description: "No-spend Agent Plugin projection playback fixture.",
        }),
      );
      await writeFile(
        join(portable, "skills/projection-probe/SKILL.md"),
        "---\nname: projection-probe\ndescription: Exercise projected plugin discovery.\n---\nHOOKNOSTIC_SKILL_DISCOVERY_MARKER\n",
      );
      await writeFile(
        join(portable, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            projection: {
              type: "stdio",
              command: "node",
              // ${PLUGIN_DATA} in argv is the shape this route used to drop
              // outright; the launcher expands it and creates the directory.
              args: ["${PLUGIN_ROOT}/plugin-mcp-env-fixture.mjs", "${PLUGIN_DATA}"],
              env: { CAPTURE_PATH: "${PLUGIN_ROOT}/mcp-environment.json" },
              cwd: "./mcp-working-dir",
            },
          },
        }),
      );
      await writeFile(join(portable, "plugin-mcp-env-fixture.mjs"), await readFile(PluginMcpEnvFixturePath));
      const loaded = await loadAgentPlugin({ root: portable });
      expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);

      // From the binary under test, not from `referenceVersion`: plugin mode is
      // established only from 0.153.2 and the reference version predates it, so
      // this lane has to say what it actually ran against. Reading it also
      // keeps a version literal out of the test.
      const reported = await runProcess("codex", ["--version"], {
        cwd: dir,
        env: process.env,
        timeoutMs: 30_000,
      });
      const installedVersion = /(\d+\.\d+\.\d+)/.exec(reported.stdout)?.[1];
      expect(installedVersion, reported.stdout + reported.stderr).toBeTypeOf("string");
      const target = {
        id: "codex",
        version: installedVersion!,
        delivery: "package" as const,
        output: ".",
      };
      const resolved = resolveAgentPluginProjection(target, codexAgentPluginProjector);
      // Below the plugin-hooks range this adapter declines every component, so
      // there is no projection to install and nothing this lane can establish.
      if (resolved.matrix?.["agent-plugin.mcp.stdio"]?.level === "unsupported") return;
      const plan = await codexAgentPluginProjector.project(loaded.package!, {
        target,
        // Hooks are not what this lane establishes, and an empty set keeps it
        // independent of a plugin-mode artifact build.
        hookArtifacts: [],
        support: resolved.matrix!,
        onUnsupported: "error",
      });
      expect(plan.issues).toEqual([]);
      for (const artifact of plan.files) {
        await mkdir(join(pluginSource, artifact.path, ".."), { recursive: true });
        await writeFile(join(pluginSource, artifact.path), artifact.contents);
      }
      // A marketplace.json at the marketplace ROOT is rejected; it is read from
      // .agents/plugins/ (.capture/codex-agent-plugin).
      await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
      await writeFile(
        join(marketplace, ".agents", "plugins", "marketplace.json"),
        JSON.stringify({
          name: "hooknostic-projection-playback",
          owner: { name: "Hooknostic contributors" },
          plugins: [{ name: "projection-playback", version: "1.0.0", source: "./plugins/projection-playback" }],
        }),
      );

      const codexEnv = { ...process.env, CODEX_HOME: codexHome };
      const added = await runProcess("codex", ["plugin", "marketplace", "add", marketplace], {
        cwd: dir,
        env: codexEnv,
        timeoutMs: 60_000,
      });
      expect(added.code, added.stdout + added.stderr).toBe(0);
      // The qualified form is mandatory: a bare name is rejected.
      const installed = await runProcess(
        "codex",
        ["plugin", "add", "projection-playback@hooknostic-projection-playback"],
        { cwd: dir, env: codexEnv, timeoutMs: 60_000 },
      );
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);
      const installRoot = join(codexHome, "plugins/cache/hooknostic-projection-playback/projection-playback/1.0.0");

      // The launcher derives PLUGIN_DATA from the home directory, so the lane
      // stubs one: otherwise every run leaves a directory in the contributor's
      // real home, and the assertion below could only check "non-empty".
      const homeDir = join(dir, "home");
      await mkdir(homeDir, { recursive: true });
      const pluginData = join(homeDir, ".hooknostic", "plugin-data", "projection-playback");

      const server = await startModelPlayback("openai-responses", "rewrite");
      try {
        await runProcess("git", ["init"], { cwd: projectDir, env: process.env, timeoutMs: 30_000 });
        const result = await runProcess(
          "codex",
          [
            "exec",
            "hello",
            "--skip-git-repo-check",
            "--color",
            "never",
            "-c",
            'model="hooknostic-playback"',
            "-c",
            'model_provider="hooknostic_playback"',
            "-c",
            'approval_policy="never"',
            "-c",
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
            `projects={${tomlLiteral(projectDir)}={trust_level=${tomlLiteral("trusted")}}}`,
          ],
          {
            cwd: projectDir,
            timeoutMs: 120_000,
            env: { ...codexEnv, USERPROFILE: homeDir, HOME: homeDir },
          },
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
      } finally {
        await server.close();
      }

      const environment = JSON.parse(await readFile(join(installRoot, "mcp-environment.json"), "utf8"));
      // Both variables arrive, absolute, in a subprocess the harness binds
      // neither for.
      expect(normalize(environment.pluginRoot)).toBe(normalize(installRoot));
      // Outside the version-scoped install root, so an upgrade cannot discard it.
      expect(normalize(environment.pluginData)).toBe(normalize(pluginData));
      expect(environment.pluginData.startsWith(installRoot)).toBe(false);
      // ${PLUGIN_DATA} in argv reached the server expanded, not literal.
      expect(environment.argv).toEqual([environment.pluginData]);
      // The declared cwd is honoured through the launcher, not lost to it.
      expect(normalize(environment.cwd)).toBe(normalize(join(installRoot, "mcp-working-dir")));
    },
    240_000,
  );

  // The OpenCode half of the same claim. Unlike Codex there is no install
  // command: `delivery: "package"` emits an npm package, and a project names
  // its DIRECTORY in `opencode.json`'s `plugin` array -- no registry
  // publication, nothing copied into the repository.
  //
  // Driven at `delivery: "package"` because that is the only delivery the
  // projector ever sees: `build.ts` runs it under
  // `config.targets[id].delivery === "package"` and nowhere else, project
  // components going through `adapter.projectComponents` instead (covered by
  // the repository-local integration drive above). This cell previously passed
  // `delivery: "project"` and wrote the plan into `.opencode/plugins/`, a
  // combination no build produces; it only worked while both deliveries
  // emitted the same project-tree fragment.
  //
  // What the package route adds over that fragment, and what this establishes:
  // OpenCode loads exactly the module `exports["./server"]` names, and the
  // generated entry re-exports BOTH plugins from it -- so an injector reached
  // through one re-export still resolves ${PLUGIN_ROOT} to the nested package.
  it.skipIf(adapter?.id !== "opencode")(
    "loads a projected npm package named by path and starts its MCP server",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-projection-"));
      tempDirs.push(dir);
      const portable = join(dir, "portable");
      const projectDir = join(dir, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(join(portable, "mcp-working-dir"), { recursive: true });
      await writeFile(join(portable, "mcp-working-dir/README.md"), "MCP working directory fixture.\n");
      await mkdir(join(portable, "skills/projection-probe"), { recursive: true });
      await writeFile(
        join(portable, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
          name: "projection-playback",
          version: "1.0.0",
          description: "No-spend Agent Plugin projection playback fixture.",
        }),
      );
      await writeFile(
        join(portable, "skills/projection-probe/SKILL.md"),
        "---\nname: projection-probe\ndescription: Exercise projected plugin discovery.\n---\nHOOKNOSTIC_SKILL_DISCOVERY_MARKER\n",
      );
      await writeFile(
        join(portable, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            projection: {
              type: "stdio",
              command: "node",
              args: ["${PLUGIN_ROOT}/plugin-mcp-env-fixture.mjs", "${PLUGIN_DATA}"],
              env: { CAPTURE_PATH: "${PLUGIN_ROOT}/mcp-environment.json" },
              cwd: "./mcp-working-dir",
            },
          },
        }),
      );
      await writeFile(join(portable, "plugin-mcp-env-fixture.mjs"), await readFile(PluginMcpEnvFixturePath));
      const loaded = await loadAgentPlugin({ root: portable });
      expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);

      const target = {
        id: "opencode",
        version: process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? adapter!.harness.referenceVersion,
        delivery: "package" as const,
        output: ".",
      };
      const plan = await opencodeAgentPluginProjector.project(loaded.package!, {
        target,
        hookArtifacts: [],
        support: resolveAgentPluginProjection(target, opencodeAgentPluginProjector).matrix!,
        onUnsupported: "error",
      });
      expect(plan.issues).toEqual([]);
      // Deliberately OUTSIDE the project directory: a package is named by path,
      // not discovered by a scan, so nothing about this route requires the
      // output to live in the repository it serves.
      const packageDir = join(dir, "plugin-package");
      for (const directory of plan.directories ?? []) {
        await mkdir(join(packageDir, directory), { recursive: true });
      }
      for (const artifact of plan.files) {
        await mkdir(join(packageDir, artifact.path, ".."), { recursive: true });
        await writeFile(join(packageDir, artifact.path), artifact.contents);
      }
      // The entry OpenCode resolves must be the one the manifest names, and it
      // must re-export both plugins -- asserted here rather than left implicit
      // in a passing run, so a regression to a bare module says what broke.
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      expect(manifest.exports["./server"]).toBe("./index.js");
      const entry = await readFile(join(packageDir, manifest.exports["./server"]), "utf8");
      expect(entry).toContain("HooknosticComponents");
      // This drive projects with no hook artifacts, so the hook half must be
      // ABSENT from the entry. Re-exporting a module the build never produced
      // throws on import and takes the whole plugin down -- skills and MCP
      // servers included -- which is the one way this route fails silently
      // enough to look like "the plugin just did not load".
      expect(entry).not.toContain("HooknosticPlugin");

      const homeDir = join(dir, "home");
      await mkdir(homeDir, { recursive: true });
      const pluginData = join(homeDir, ".hooknostic", "plugin-data", "projection-playback");

      const server = await startModelPlayback("openai-chat", "rewrite");
      try {
        await runProcess("git", ["init"], { cwd: projectDir, env: process.env, timeoutMs: 30_000 });
        await prepareOpenCodePluginDependency(
          projectDir,
          process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? adapter!.harness.referenceVersion,
        );
        // Absolute because the package sits outside the project, which is the
        // point: this route names a directory, it does not scan for one.
        await writeOpenCodeProviderConfig(projectDir, server.baseUrl, {
          plugin: [packageDir.replaceAll("\\", "/")],
        });
        const result = await runProcess("opencode", ["run", "hello", "--model", "playback/hooknostic-playback"], {
          cwd: projectDir,
          timeoutMs: 180_000,
          // Home is stubbed for the same reason as the Codex lane: the
          // launcher derives PLUGIN_DATA from it, and a test must not leave a
          // directory in the contributor's real home.
          // The isolation every other OpenCode drive uses: real credentials
          // stripped, and an XDG config home inside the project. Without it
          // the run links to whatever OpenCode launched the test.
          env: {
            ...withoutCredentials(),
            PWD: projectDir,
            XDG_CONFIG_HOME: openCodePlaybackConfigHome(projectDir),
            USERPROFILE: homeDir,
            HOME: homeDir,
          },
        });
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(server.errors).toEqual([]);
      } finally {
        await server.close();
      }

      const packageRoot = join(packageDir, "package");
      const environment = JSON.parse(await readFile(join(packageRoot, "mcp-environment.json"), "utf8"));
      // The nested author package, not the package root the entry sits in, is
      // ${PLUGIN_ROOT} -- resolved from the injector's own import.meta.url
      // after the entry re-exported it.
      expect(normalize(environment.pluginRoot)).toBe(normalize(packageRoot));
      // A user-level directory, so rebuilding the package output is not an
      // "update" that resets a server's state.
      expect(normalize(environment.pluginData)).toBe(normalize(pluginData));
      expect(environment.pluginData.startsWith(packageDir)).toBe(false);
      expect(environment.pluginData.startsWith(projectDir)).toBe(false);
      expect(environment.argv).toEqual([environment.pluginData]);
      expect(normalize(environment.cwd)).toBe(normalize(join(packageRoot, "mcp-working-dir")));
    },
    300_000,
  );

  // Codex's capability matrix resolves by version and ignores mode, so a
  // plugin-mode build advertises the deny and rewrite channels that every other
  // effect drive verifies through `.codex/hooks.json` instead. ADR-0011's sixth
  // amendment forbids treating one route's evidence as another's, and the only
  // plugin-boundary evidence was that a marker command ran -- not that its
  // response was honoured. This drives the same two effects through an
  // INSTALLED plugin.
  it.skipIf(adapter?.id !== "codex").each([
    [
      "denies a tool call",
      "block" as const,
      async (projectDir: string) => {
        await expect(access(join(projectDir, "hooknostic-blocked.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    ],
    [
      "rewrites a tool input",
      "rewrite" as const,
      async (projectDir: string) => {
        expect(await readFile(join(projectDir, "hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
      },
    ],
  ])(
    "%s through an installed plugin",
    async (_label, scenario, verifyEffect) => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-plugin-effect-"));
      tempDirs.push(dir);
      const marketplace = join(dir, "marketplace");
      const pluginSource = join(marketplace, "plugins", "harness-playback");
      const codexHome = join(dir, "codex-home");
      const projectDir = join(dir, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });

      // Plugin mode is established only from 0.153.2 and `referenceVersion`
      // predates it, so the build is targeted at the binary actually under test.
      const reported = await runProcess("codex", ["--version"], {
        cwd: dir,
        env: process.env,
        timeoutMs: 30_000,
      });
      const installedVersion = /(\d+\.\d+\.\d+)/.exec(reported.stdout)?.[1];
      expect(installedVersion, reported.stdout + reported.stderr).toBeTypeOf("string");
      let build: Awaited<ReturnType<typeof buildPlaybackArtifact>>;
      try {
        build = await buildPlaybackArtifact(adapter!, pluginSource, {
          delivery: "package",
          version: installedVersion!,
        });
      } catch (error) {
        // Below the plugin-hooks range the adapter refuses to generate at all,
        // which is the honest outcome on an older binary rather than a failure.
        expect((error as Error).message).toContain("requires harness");
        return;
      }

      await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
      await writeFile(
        join(marketplace, ".agents", "plugins", "marketplace.json"),
        JSON.stringify({
          name: "hooknostic-effect-playback",
          owner: { name: "Hooknostic contributors" },
          plugins: [{ name: "harness-playback", version: "1.0.0", source: "./plugins/harness-playback" }],
        }),
      );
      const codexEnv = { ...process.env, CODEX_HOME: codexHome };
      const added = await runProcess("codex", ["plugin", "marketplace", "add", marketplace], {
        cwd: dir,
        env: codexEnv,
        timeoutMs: 60_000,
      });
      expect(added.code, added.stdout + added.stderr).toBe(0);
      const installed = await runProcess("codex", ["plugin", "add", "harness-playback@hooknostic-effect-playback"], {
        cwd: dir,
        env: codexEnv,
        timeoutMs: 60_000,
      });
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);

      const server = await startModelPlayback("openai-responses", scenario);
      try {
        await runProcess("git", ["init"], { cwd: projectDir, env: process.env, timeoutMs: 30_000 });
        const result = await runProcess(
          "codex",
          [
            "exec",
            "-",
            "--skip-git-repo-check",
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
            `projects={${tomlLiteral(projectDir)}={trust_level=${tomlLiteral("trusted")}}}`,
          ],
          {
            cwd: projectDir,
            input: playbackPrompt(scenario),
            timeoutMs: 120_000,
            env: { ...codexEnv, HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath },
          },
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(server.errors).toEqual([]);
      } finally {
        await server.close();
      }

      // The effect, not merely the invocation: the hook fired through the
      // plugin boundary AND its write channel was honoured.
      expect(await traceEvents(build.tracePath)).toContain("tool.before");
      await verifyEffect(projectDir);
    },
    300_000,
  );

  it("drives the fixture MCP tool through the generated production artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-mcp-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    await runInstalledHarness(build, "rewrite", {
      ...(adapter!.id === "codex" ? { effects: ["prevent-stop-once"] } : {}),
      mcpServerPath: McpFixtureServerPath,
      // Codex discovers stdio MCP servers after the first agent turn. Its stop
      // hook drives a second turn; Claude and OpenCode have the fixture tool
      // before the first response.
      script:
        adapter!.id === "codex"
          ? [
              { kind: "text", text: "I will call the echo tool on the next step." },
              { kind: "tool", toolName: "hooknostic_echo" },
              { kind: "text", text: "MCP output received; standing down now." },
            ]
          : [
              { kind: "tool", toolName: "hooknostic_echo" },
              { kind: "text", text: "MCP output received; standing down now." },
            ],
    });
    const trace = await readFile(build.tracePath, "utf8");
    expect(trace, `fixture MCP tool did not reach the artifact: ${trace}`).toContain('"toolKind":"mcp"');
    expect(trace).toContain('"event":"tool.before"');
    expect(trace).toContain('"event":"tool.after"');
  });
});

// --- registry gate (ADR-0010) ---------------------------------------------
// The coverage audit in testkit only checks that a capability cell appears in
// some scenario's `covers`. This gate is the other half: every scenario in
// the registry must have an executable drive registered above. A placeholder
// entry — or a deleted drive — fails here instead of reporting phantom
// coverage. Runs even when no harness is selected, so CI always sees it.
it("every scenario in the registry has an executable drive", () => {
  const missing = SCENARIOS.filter((scenario) => !scenarioDrives.has(scenario.id)).map((scenario) => scenario.id);
  expect(missing, `scenarios without a drive: ${missing.join(", ")}`).toEqual([]);
});

// --- drive registrations ---------------------------------------------------

scenarioDrive("lifecycle-observe", async () => {
  const dir = await mkdtemp(join(tmpdir(), `hooknostic-harness-${adapter!.id}-`));
  tempDirs.push(dir);
  const build = await buildPlaybackArtifact(adapter!, dir);
  await runInstalledHarness(build, "rewrite");

  expect(await readFile(join(dir, "hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
  const events = await traceEvents(build.tracePath);
  expect(events).toContain("session.start");
  expect(events).toContain("prompt.before");
  expect(events).toContain("tool.before");
  expect(events).toContain("tool.after");
  expect(events).toContain("turn.stop");
  if (adapter!.shimExecution === "command") expect(events).toContain("session.end");
});

scenarioDrive("tool-before-block", async () => {
  const dir = await mkdtemp(join(tmpdir(), `hooknostic-block-${adapter!.id}-`));
  tempDirs.push(dir);
  const build = await buildPlaybackArtifact(adapter!, dir);
  await runInstalledHarness(build, "block");

  await expect(access(join(dir, "hooknostic-blocked.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await traceEvents(build.tracePath)).toContain("tool.before");
});

scenarioDrive("tool-before-rewrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), `hooknostic-rewrite-${adapter!.id}-`));
  tempDirs.push(dir);
  const build = await buildPlaybackArtifact(adapter!, dir);
  await runInstalledHarness(build, "rewrite");

  // The rewrite must reach process execution: the marker file carries the
  // rewritten command's output, not the original's.
  expect(await readFile(join(dir, "hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
  expect(await traceEvents(build.tracePath)).toContain("tool.before");
});

scenarioDrive("shell-tool-variants", async () => {
  const dir = await mkdtemp(join(tmpdir(), `hooknostic-shellvariants-${adapter!.id}-`));
  tempDirs.push(dir);
  const build = await buildPlaybackArtifact(adapter!, dir);
  await runInstalledHarness(build, "rewrite");

  // Every shell shape the adapter classifies must be drivable end to end:
  // the rewrite drive already proves the harness's default shell tool; the
  // observe cells ride along every drive, so the trace is the assertion.
  const events = await traceEvents(build.tracePath);
  expect(events).toContain("tool.before");
  expect(events).toContain("tool.after");
});

scenarioDrive(
  "tool-error",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-failure-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    let recordedRequests: readonly unknown[] = [];
    await runInstalledHarness(build, "fail", {
      effects: ["context-add"],
      verify: async ({ server }) => {
        recordedRequests = server.requests;
      },
    });

    const events = await traceEvents(build.tracePath);
    expect(events).toContain("tool.error");
    // The scenario covers tool.error.context.add, so the assertion must prove
    // the injected error context reaches the model side — observing the event
    // alone would report the context channel as covered while unexercised.
    const contents = requestContents(recordedRequests);
    expect(
      contents.some((text) => text.includes("hooknostic-context [tool.error]")),
      `injected tool.error context missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
    ).toBe(true);
  },
  () => adapter?.id !== "claude" || cellLevel("tool.error.context.add") === undefined,
);

scenarioDrive(
  "session-start-context-add",
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
  () => cellLevel("session.start.context.add") === undefined,
);

scenarioDrive(
  "prompt-before-context-add",
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
  () => cellLevel("prompt.before.context.add") === undefined,
);

scenarioDrive(
  "model-request-before-context-add",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-modelreqctx-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    let recordedRequests: readonly unknown[] = [];
    await runInstalledHarness(build, "rewrite", {
      effects: ["context-add"],
      verify: async ({ server }) => {
        recordedRequests = server.requests;
      },
    });

    // Unlike the session.start channel, this one fires per model request, so
    // the marker must be present in EVERY recorded request rather than merely
    // somewhere among them -- that per-request presence IS the cell. `some`
    // would pass when only the title-generation request carried the context
    // and the agent request did not, which is the failure worth catching.
    expect(recordedRequests.length, "no model requests were recorded").toBeGreaterThan(0);
    const without = requestsWithoutMarker(recordedRequests, "hooknostic-context [model.request.before]");
    expect(
      without,
      `${without.length}/${recordedRequests.length} model requests lacked the injected model.request.before context (indices)`,
    ).toEqual([]);
  },
  () => cellLevel("model.request.before.context.add") === undefined,
);

scenarioDrive(
  "prompt-before-block",
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
      // The absence of a model request IS the assertion here.
      requireAgentRequest: false,
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
  () => cellLevel("prompt.before.block") === undefined,
);

scenarioDrive(
  "tool-before-context-add",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-toolctx-${adapter!.id}-`));
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
      contents.some((text) => text.includes("hooknostic-context [tool.before]")),
      `injected tool.before context missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
    ).toBe(true);
  },
  () => cellLevel("tool.before.context.add") === undefined,
);

scenarioDrive(
  "tool-after-context-add",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-toolafterctx-${adapter!.id}-`));
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
      contents.some((text) => text.includes("hooknostic-context [tool.after]")),
      `injected tool.after context missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
    ).toBe(true);
  },
  () => cellLevel("tool.after.context.add") === undefined,
);

scenarioDrive(
  "stop-prevent",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-stopprevent-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    let servedTurns = 0;
    if (adapter!.id === "opencode") {
      // OpenCode's prevent channel is inert under `opencode run` (the process
      // exits at session.idle before the posted turn can start) — the
      // opencode-serve driver lane is the executable form of this scenario
      // (captured: .capture/opencode-client).
      await runOpenCodeServePlayback(build, "rewrite", {
        effects: ["prevent-stop-once"],
        script: [
          { kind: "tool", disposition: "rewrite" },
          { kind: "text", text: "Stop hook active; standing down now." },
        ],
        // Three, not two: the script alone produces the tool call and its
        // completion, so `>= 2` holds whether or not the stop was ever
        // prevented. The third turn is the re-prompt prevention posts, and it
        // is the only served turn that evidences the cell.
        minTurns: 3,
        // The prevented stop is published at session.idle, which follows the
        // scripted text completion. Held until the trace has it so teardown
        // cannot outrun the observable.
        awaitTraceEvent: "turn.stop",
        verify: async ({ server }) => {
          servedTurns = server.turnCount;
        },
      });
    } else {
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
    }

    // What counts as "another turn" is per-harness, because the scripts differ
    // in how many turns they produce on their own. On the opencode-serve lane
    // the script produces two by itself, so only a third evidences prevention.
    const requiredTurns = adapter!.id === "opencode" ? 3 : 2;
    expect(
      servedTurns,
      `stop prevention did not produce an extra model turn (turns served: ${servedTurns}, required: ${requiredTurns})`,
    ).toBeGreaterThanOrEqual(requiredTurns);
    // OpenCode dispatches plugin event callbacks without awaiting their
    // promises. The loopback server can therefore receive turn 2 before the
    // first session.idle callback finishes writing this trace. Wait for the
    // scenario's actual observable instead of treating request arrival as
    // plugin completion. (The serve drive already holds teardown until this
    // event exists -- see DriveOptions.awaitTraceEvent -- so on that lane this
    // re-reads a trace that is already complete.)
    expect(await waitForTraceEvent(build.tracePath, "turn.stop")).toContain("turn.stop");
  },
  () => cellLevel("turn.stop.prevent") === undefined,
);

scenarioDrive(
  "stop-notify",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-notify-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    if (adapter!.id === "opencode") {
      // OpenCode's notify channel is a promptAsync post into the session
      // (captured: .capture/opencode-client) -- only a session that outlives
      // the turn exposes the transcript it lands in, so this scenario's
      // opencode lane runs on the opencode-serve driver (registry override).
      let transcript: ServeMessage[] = [];
      let transcriptError = "";
      let servedTurns = 0;
      await runOpenCodeServePlayback(build, "rewrite", {
        effects: ["notify"],
        verify: async ({ server, serve }) => {
          servedTurns = server.turnCount;
          // The post lands during session.idle, right as the drive's
          // turn-count poll is finishing; poll the transcript briefly so the
          // assertion reads state after the post, not a race with it.
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            try {
              transcript = await serve!.messages();
              transcriptError = "";
            } catch (error) {
              transcriptError = String(error);
            }
            if (transcript.some((m) => (m.parts ?? []).some((p) => p.text?.includes("hooknostic-notify-marker")))) {
              return;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
        },
      });
      const events = await traceEvents(build.tracePath);
      expect(events).toContain("turn.stop");
      const rendered = transcript.map((m) => ({
        role: m.info?.role,
        text: (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(" "),
      }));
      // Approximate semantics, asserted as documented (profile rationale):
      // the marker reaches the session transcript as a user-role message
      // without driving a turn of its own (promptAsync noReply).
      expect(
        rendered.some((m) => m.text.includes("hooknostic-notify-marker")),
        `notify marker missing from the serve transcript (last read error: ${transcriptError}): ${JSON.stringify(rendered, null, 2).slice(0, 2000)}`,
      ).toBe(true);
      expect(
        rendered.find((m) => m.text.includes("hooknostic-notify-marker"))?.role,
        `notify message role unexpected: ${JSON.stringify(rendered, null, 2).slice(0, 2000)}`,
      ).toBe("user");
      // No extra turn: the scripted rewrite session serves exactly two agent
      // requests (tool call + completion); a third would mean the noReply
      // notification drove a turn of its own.
      expect(servedTurns, `notify posted with noReply but drove an extra agent request (${servedTurns} served)`).toBe(
        2,
      );
      return;
    }
    let driveStdout = "";
    await runInstalledHarness(build, "rewrite", {
      effects: ["notify"],
      // Claude renders systemMessage as a system notice in the stream
      // (captured: .capture/claude-output); plain `-p` text mode discards it.
      // stream-json requires --verbose.
      extraArgs: adapter!.id === "claude" ? ["--output-format", "stream-json", "--verbose"] : [],
      capture: (raw) => {
        driveStdout = raw.stdout;
      },
    });

    const events = await traceEvents(build.tracePath);
    expect(events).toContain("turn.stop");
    // The notify marker must reach the harness's user-facing channel, not
    // just be accepted on the wire. Claude renders systemMessage as a system
    // notice in the stream (captured: .capture/claude-output); Codex accepts
    // and discards it (captured: .capture/codex-output) -- the profile's
    // "unsupported" is the assertion there.
    if (adapter!.id === "claude") {
      expect(
        driveStdout,
        `notify marker missing from claude stream output: ${JSON.stringify(driveStdout.slice(0, 2000))}`,
      ).toContain("hooknostic-notify-marker");
    }
    // Inverted watch (ADR-0010 §4): Codex accepts the systemMessage on the
    // wire and discards it (captured: .capture/codex-output, variant D --
    // validated, logged "Stop Completed", rendered nowhere). If the marker
    // ever appears in output, the profile's explicit "unsupported" has
    // drifted and the adapter decision must be revisited with fresh
    // evidence, not silently updated.
    if (adapter!.id === "codex") {
      expect(
        driveStdout,
        `turn.stop.notify was rated unsupported but the marker rendered: ${JSON.stringify(driveStdout.slice(0, 2000))}`,
      ).not.toContain("hooknostic-notify-marker");
    }
  },
  () => cellLevel("turn.stop.notify") === undefined,
);

scenarioDrive(
  "tool-after-output-replace",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-mcpreplace-codex-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    let recordedRequests: readonly unknown[] = [];
    let driveStdout = "";
    let driveStderr = "";
    await runInstalledHarness(build, "rewrite", {
      effects: ["replace-outputs", "prevent-stop-once"],
      ...(adapter!.id === "codex" ? { mcpServerPath: McpFixtureServerPath } : {}),
      // Codex registers stdio MCP servers asynchronously, so the first
      // turn's tool list usually lacks the fixture tool. Turn 1 completes
      // with text; the stop hook prevents that stop (exactly once, gated on
      // stop_hook_active), which forces turn 2 — by then the MCP tool is
      // registered and the script calls it. Turn 3 completes.
      script:
        adapter!.id === "codex"
          ? [
              { kind: "text", text: "I will call the echo tool on the next step." },
              { kind: "tool", toolName: "hooknostic_echo" },
              { kind: "text", text: "Stop hook active; standing down now." },
            ]
          : [{ kind: "tool" }, { kind: "text", text: "Stop hook active; standing down now." }],
      verify: async ({ server }) => {
        recordedRequests = server.requests;
      },
      capture: (raw) => {
        driveStdout = raw.stdout;
        driveStderr = raw.stderr;
      },
    });

    const events = await traceEvents(build.tracePath);
    // Every output-replacement drive must reach the post-tool hook. Codex
    // additionally uses the MCP fixture so its inverted watch can exercise
    // the hook channel that rejects updatedMCPToolOutput.
    expect(events, `no tool.after\nstdout: ${driveStdout}\nstderr: ${driveStderr}`).toContain("tool.after");
    // The cell is unsupported on the hook channel: the engine strictly
    // rejects updatedMCPToolOutput from a PostToolUse hook (captured live on
    // 0.151.0, .capture/codex-tools; matches upstream codex-rs
    // unsupported_updated_mcp_tool_output_fails_open). The generated artifact
    // gates the effect off (HN401), so the contract here is that the
    // artifact never attempts the dead channel: the model must see the
    // fixture's ORIGINAL output in the next request, and the replaced marker
    // must surface nowhere.
    const contents = requestContents(recordedRequests);
    if (adapter!.id === "codex") {
      // The cell is unsupported on the hook channel: the engine strictly
      // rejects updatedMCPToolOutput from a PostToolUse hook (captured live
      // on 0.151.0, .capture/codex-tools; matches upstream codex-rs
      // unsupported_updated_mcp_tool_output_fails_open). The generated
      // artifact gates the effect off (HN401), so the contract here is that
      // the artifact never attempts the dead channel: the model must see the
      // fixture's ORIGINAL output in the next request, and the replaced
      // marker must surface nowhere.
      expect(
        contents.some((text) => text.includes("hooknostic-mcp-tool-output")),
        `original MCP output missing from model requests: stdout: ${driveStdout}\nstderr: ${driveStderr}\nrequests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toBe(true);
      expect(
        contents.some((text) => text.includes("hooknostic-replaced-tool-output")),
        `replaced output reached the model although the cell is unsupported (upstream honoured updatedMCPToolOutput?): ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
      ).toBe(false);
      expect(
        driveStderr + driveStdout,
        `replaced output surfaced in the harness channels (cell no longer unsupported?): ${driveStderr.slice(0, 2000)}`,
      ).not.toContain("hooknostic-replaced-tool-output");
      return;
    }
    // OpenCode exercises its native shell tool here; the replacement must
    // reach the following model request.
    expect(
      contents.some((text) => text.includes("hooknostic-replaced-tool-output")),
      `replaced tool output missing from model requests: stdout: ${driveStdout}\nstderr: ${driveStderr}\nrequests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
    ).toBe(true);
  },
  () => cellLevel("tool.after.output.replace") === undefined,
);

scenarioDrive(
  "permission-request",
  async () => {
    if (adapter!.id === "opencode") {
      // Captured live on 1.18.25 (.capture/opencode-permission): the
      // permission.ask callback never fires (upstream #9229); the ask
      // surfaces as the permission.asked bus event and the deny is delivered
      // via the client reply API. The bus fires whether or not a terminal is
      // attached, so the serve lane drives it headlessly: bash:ask makes the
      // scripted mkdir trip a real ask; the hook's permission-deny effect
      // rejects it; the denied command must never run and the turn must
      // complete.
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-perm-opencode-"));
      tempDirs.push(dir);
      const build = await buildPlaybackArtifact(adapter!, dir);
      let permissionObserved = false;
      await runOpenCodeServePlayback(build, "rewrite", {
        effects: ["permission-deny"],
        opencodeConfig: { permission: { bash: "ask" } },
        script: [{ kind: "tool", disposition: "rewrite", marker: "hooknostic-perm-marker.txt" }, { kind: "text" }],
        verify: async ({ server }) => {
          // The deny round-trip (bus event → reply API) happens inside the
          // turn; a third agent request would mean the rejection did not
          // halt-and-continue as captured.
          permissionObserved = server.turnCount >= 1;
        },
      });
      const events = await traceEvents(build.tracePath);
      expect(events, `permission.request never fired (observed flag: ${permissionObserved})`).toContain(
        "permission.request",
      );
      expect(
        await readFile(join(dir, "hooknostic-perm-marker.txt"), "utf8").catch(() => null),
        "denied command executed anyway",
      ).toBeNull();
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-ptyperm-claude-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    const server = await startModelPlayback(
      "anthropic-messages",
      "rewrite",
      // Turn 1 emits the shell call that trips the approval prompt; the
      // hook's permission-deny effect answers it; turn 2 completes.
      [{ kind: "tool", disposition: "rewrite", marker: "hooknostic-approval.txt" }, { kind: "text" }],
    );
    try {
      await runProcess("git", ["init"], { cwd: dir, env: process.env, timeoutMs: 30_000 });
      // The TUI drive: first-run dialogs (trust + API key), then the prompt,
      // then leave the denial to the hook. Terminal state matters only for
      // diagnostics; the trace is the assertion surface.
      const configDir = await prepareClaudePtyConfig(dir);
      const pty = spawnClaudePty(["--plugin-dir", build.artifactDir], {
        name: "xterm-256color",
        cols: 110,
        rows: 34,
        cwd: dir,
        env: {
          ...withoutCredentials(),
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "hooknostic-playback",
          ANTHROPIC_BASE_URL: server.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
          // permission-deny only: context-add would return first and the
          // permission block branch would never run (the denial is the
          // assertion, so the effect must not be shadowed).
          HOOKNOSTIC_PLAYBACK_EFFECTS: "permission-deny",
        } as NodeJS.ProcessEnv,
      } as never);
      let screen = "";
      pty.onData((data: string) => {
        screen += data;
      });
      const plainScreen = (): string => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
      // Walk first-run dialogs reactively: fresh CI state renders a different
      // sequence (theme -> API key -> security notes -> trust on 2.1.238)
      // than a box with local state (trust first on 2.1.250), so the walk
      // polls for each dialog's own text instead of assuming order.
      await walkFirstRunDialogs(pty, plainScreen, 60_000);
      // Wait for the TUI input line, then send the prompt.
      await waitForMainPrompt(plainScreen, 20_000);
      await new Promise((r) => setTimeout(r, 1_500));
      pty.write("Use the shell tool once to create hooknostic-approval.txt.\r");
      // The plugin denies the prompt. The PTY's rendered completion text is
      // not stable across Claude versions (2.1.238 can remain on the tool's
      // "Waiting" frame even after the follow-up request is served), so use
      // the loopback model's agent-turn count as the completion signal.
      const turnCompleted = await (async (): Promise<boolean> => {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          if (server.turnCount >= 2) return true;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      })();
      try {
        pty.kill();
      } catch {
        // already gone
      }
      const events = await traceEvents(build.tracePath).catch(() => [] as HookEventName[]);
      expect(
        events,
        `permission.request never fired; requests: ${server.requests.length}; screen: ${JSON.stringify(
          plainScreen().slice(-6000),
        )}`,
      ).toContain("permission.request");
      // The denial must be honored natively: the turn completed after the
      // prompt (the harness continued past the denied call), and the denied
      // command never executed.
      expect(
        turnCompleted,
        `turn never completed after the denial; model turns: ${server.turnCount}; screen: ${JSON.stringify(
          plainScreen().slice(-6000),
        )}`,
      ).toBe(true);
      expect(
        await readFile(join(dir, "hooknostic-approval.txt"), "utf8").catch(() => null),
        "denied command executed anyway",
      ).toBeNull();
    } finally {
      await server.close();
    }
  },
  // Two drivers, two preconditions. Claude takes the pty-approval lane, which
  // needs node-pty and a platform it builds on. OpenCode takes the serve lane
  // (`driverByHarness` in the scenario record), which attaches no terminal and
  // so must not inherit the pty requirement — the earlier single predicate
  // demanded `id === "claude"` and skipped the OpenCode branch this drive
  // opens with, silently, on every run.
  () => {
    if (cellLevel("permission.request.block") === undefined) return true;
    if (adapter?.id === "opencode") return false;
    return adapter?.id !== "claude" || !ptyApprovable();
  },
);

scenarioDrive(
  "context-compact",
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
    expect(events, `compaction never dispatched; events: ${JSON.stringify(events)}`).toContain(
      "context.compact.before",
    );
  },
  () => cellLevel("context.compact.before.observe") === undefined,
);

// --- tool-before-approval (pty-approval) ----------------------------------
// Interactive-only: headless `-p` sessions decide without prompting. The
// drive starts the interactive TUI under node-pty, walks the first-run
// dialogs, sends a prompt whose scripted tool call trips the approval
// prompt, and lets the hook's requestApproval surface the native prompt.
scenarioDrive(
  "tool-before-approval",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-ptyapproval-claude-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    const server = await startModelPlayback(
      "anthropic-messages",
      "rewrite",
      // Turn 1 emits the shell call that trips the approval prompt; the
      // hook's request-approval effect surfaces it; turn 2 completes.
      [{ kind: "tool", disposition: "rewrite", marker: "hooknostic-approval.txt" }, { kind: "text" }],
    );
    try {
      await runProcess("git", ["init"], { cwd: dir, env: process.env, timeoutMs: 30_000 });
      const configDir = await prepareClaudePtyConfig(dir);
      const pty = spawnClaudePty(["--plugin-dir", build.artifactDir, "--allowedTools", "Bash"], {
        name: "xterm-256color",
        cols: 110,
        rows: 34,
        cwd: dir,
        env: {
          ...withoutCredentials(),
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "hooknostic-playback",
          ANTHROPIC_BASE_URL: server.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
          HOOKNOSTIC_PLAYBACK_EFFECTS: "request-approval",
        } as NodeJS.ProcessEnv,
      } as never);
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
      // Walk first-run dialogs (same reactive walk as the permission drive).
      await walkFirstRunDialogs(pty, plainScreen, 60_000);
      await waitForMainPrompt(plainScreen, 20_000);
      await new Promise((r) => setTimeout(r, 1_500));
      pty.write("Use the shell tool once to create hooknostic-approval.txt.\r");
      // The hook's requestApproval surfaces the native approval prompt.
      const prompted = await waitUntil("Doyouwanttoproceed", 30_000);
      // Approve it: the command must then execute.
      pty.write("y\r");
      await new Promise((r) => setTimeout(r, 15_000));
      try {
        pty.kill();
      } catch {
        // already gone
      }
      const events = await traceEvents(build.tracePath).catch(() => [] as HookEventName[]);
      expect(
        events,
        `tool.before never fired; requests: ${server.requests.length}; screen: ${JSON.stringify(
          plainScreen().slice(-6000),
        )}`,
      ).toContain("tool.before");
      expect(plainScreen()).not.toContain("Hook JSON output validation failed");
      expect(dialogScreen(plainScreen)).toContain("approvalrequestedbyharnessplayback");
      // Bash is preallowed: only the hook's ask can cause this prompt.
      // The native prompt must have surfaced (the effect's whole point).
      expect(
        prompted,
        `native approval prompt never appeared; screen: ${JSON.stringify(plainScreen().slice(-6000))}`,
      ).toBe(true);
      // Approving must let the command run: the marker appears.
      expect(
        await readFile(join(dir, "hooknostic-approval.txt"), "utf8").catch(() => null),
        "approved command never executed",
      ).toBe("hooknostic-original");
    } finally {
      await server.close();
    }
  },
  () => !ptyApprovable() || adapter?.id !== "claude" || cellLevel("tool.before.requestApproval") === undefined,
);

// --- tool-after-block-continuation (loopback) ------------------------------
// The scripted tool output carries the sentinel; the hook's
// block-continuation effect answers it. The block reason must reach the
// model (Claude: stderr; Codex: decision block), which decides whether to
// stop — the turn ends either way, so the model-side marker is the assertion.
scenarioDrive(
  "tool-after-block-continuation",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-continuation-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    let recordedRequests: readonly unknown[] = [];
    await runInstalledHarness(build, "continuation", {
      effects: ["block-continuation"],
      verify: async ({ server }) => {
        recordedRequests = server.requests;
      },
    });

    const events = await traceEvents(build.tracePath);
    expect(events).toContain("tool.after");
    // The block reason must reach the model side (the harness decides
    // whether to stop from it).
    const contents = requestContents(recordedRequests);
    expect(
      contents.some((text) => text.includes("continuation blocked by harness playback")),
      `block reason missing from model requests: ${JSON.stringify(contents.slice(0, 20), null, 2)}`,
    ).toBe(true);
  },
  () => cellLevel("tool.after.blockContinuation") === undefined,
);

// --- agent-subagent (subagent) ---------------------------------------------
// The scripted model emits the harness's own subagent tool call (Claude
// `Task`, Codex `spawn_agent`); the harness spawns the subagent and
// dispatches agent.start/agent.stop to the artifact.
scenarioDrive(
  "agent-subagent",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), `hooknostic-subagent-${adapter!.id}-`));
    tempDirs.push(dir);
    const build = await buildPlaybackArtifact(adapter!, dir);
    // The subagent tool name is per-harness: Claude 2.1.250 exposes `Agent`
    // (the toolmap's EXACT table), Codex `spawn_agent`.
    const subagentTool = adapter!.id === "codex" ? "spawn_agent" : "Agent";
    let recordedRequests: readonly unknown[] = [];
    let driveStdout = "";
    let driveStderr = "";
    await runInstalledHarness(build, "rewrite", {
      script: [{ kind: "tool", toolName: subagentTool }, { kind: "text" }],
      verify: async ({ server }) => {
        recordedRequests = server.requests;
      },
      capture: (raw) => {
        driveStdout = raw.stdout;
        driveStderr = raw.stderr;
      },
    });

    const events = await traceEvents(build.tracePath);
    expect(
      events,
      `subagent lifecycle never dispatched; events: ${JSON.stringify(events)}\nstdout: ${driveStdout}\nstderr: ${driveStderr}\nrequests: ${JSON.stringify(requestContents(recordedRequests).slice(0, 30), null, 2)}`,
    ).toContain("agent.start");
    expect(events).toContain("agent.stop");
  },
  () => {
    if (cellLevel("agent.start.observe") === undefined || cellLevel("agent.stop.observe") === undefined) {
      return true;
    }
    return false;
  },
);

it("requestsWithoutMarker demands a system message, not merely a string in the body", () => {
  // Two failure modes this pins, both real.
  //
  // 1. Per-request boundary: requestContents flattens every string across every
  //    request, so a flat .some() passes when only one request carried the
  //    context, and a flat .every() can never pass (tool schemas are strings too).
  // 2. Model-visibility: the rejected chat.params implementation puts the same
  //    text in the body as a top-level `systemPrompt` field, which no
  //    OpenAI-compatible API reads. A recursive string walk accepts it.
  const asSystemMessage = {
    messages: [
      { role: "system", content: "MARK" },
      { role: "user", content: "hi" },
    ],
  };
  const noMarker = { messages: [{ role: "user", content: "hi" }] };
  // Exactly the shape captured from the inert channel.
  const asTopLevelField = { systemPrompt: "MARK", messages: [{ role: "user", content: "hi" }] };
  const asTextParts = { messages: [{ role: "system", content: [{ type: "text", text: "MARK" }] }] };

  expect(requestsWithoutMarker([asSystemMessage, asSystemMessage], "MARK")).toEqual([]);
  expect(requestsWithoutMarker([asTextParts], "MARK")).toEqual([]);

  // (1) the per-request boundary
  expect(requestsWithoutMarker([asSystemMessage, noMarker], "MARK")).toEqual([1]);

  // (2) the inert channel must NOT satisfy the cell
  expect(requestsWithoutMarker([asTopLevelField], "MARK")).toEqual([0]);
  expect(JSON.stringify(asTopLevelField)).toContain("MARK");
  expect(requestContents([asTopLevelField]).some((t) => t.includes("MARK"))).toBe(true);
});

it("writes declared scheduled-lane inconclusives for the workflow summary", async () => {
  const path = process.env["HOOKNOSTIC_PLAYBACK_INCONCLUSIVE_PATH"];
  if (path === undefined || adapter === undefined) return;
  const scenarios = SCENARIOS.flatMap((scenario) => {
    const entry = scenarioDrives.get(scenario.id);
    if (entry === undefined) return [];
    const reason = scenarioSkipReason(scenario, entry);
    if (reason === undefined) return [];
    const cells = scenario.covers.filter((cell) => cellLevel(cell) !== undefined);
    return cells.length === 0 ? [] : [{ id: scenario.id, cells, reason }];
  });
  await writeFile(path, JSON.stringify({ harness: adapter.id, scenarios }, null, 2) + "\n", "utf8");
});

// Register after every `scenarioDrive` call above. Vitest executes describe
// callbacks immediately during module evaluation, so registering this loop
// beside the basic playback tests would inspect the still-empty map.
describe.skipIf(adapter === undefined)(`offline harness playback scenarios: ${selected || "disabled"}`, () => {
  for (const scenario of SCENARIOS) {
    const entry = scenarioDrives.get(scenario.id);
    if (entry === undefined) continue;
    const skipReason = scenarioSkipReason(scenario, entry);
    it(scenario.title, { timeout: 240_000, skip: skipReason !== undefined }, entry.drive);
  }
});
