import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessAdapter } from "@hooknostic/core";
import { buildPluginIR, bundleRuntime } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";
import { definePlugin, hook, HOOK_EVENT_NAMES } from "@hooknostic/sdk";
import { expect } from "vitest";

const RUNTIME_POLICY = {
  onHookError: "continue" as const,
  // Codex caps SessionEnd at three seconds. Keep the portable budget at one
  // second so generated native timeouts fit every validated harness.
  timeoutMs: 1_000,
  contextCharLimit: 16_000,
  notifyCharLimit: 2_000,
};

const require = createRequire(import.meta.url);

export interface PlaybackBuild {
  artifactDir: string;
  runtimePath: string;
  tracePath: string;
  events: HookEventName[];
}

export type ModelProtocol = "anthropic-messages" | "openai-responses" | "openai-chat";
export type PlaybackScenario = "rewrite" | "block" | "fail";

// These model-side envelopes are constructed test inputs, not captured hook
// payloads. Keep their evidence boundary and promotion procedure explicit in
// .capture/harness-playback/README.md.

export interface ModelPlayback {
  baseUrl: string;
  requests: unknown[];
  errors: string[];
  close(): Promise<void>;
}

function targetFor(adapter: HarnessAdapter, output: string) {
  return {
    id: adapter.id,
    version: adapter.harness.referenceVersion,
    mode: adapter.supportedModes()[0]!,
    output,
  };
}

export function observedEvents(adapter: HarnessAdapter): HookEventName[] {
  const target = targetFor(adapter, ".");
  const resolved = adapter.capabilities(target);
  if (resolved.matrix === undefined || resolved.diagnostics.length > 0) {
    throw new Error(
      `${adapter.id}: reference-version capabilities did not resolve: ${resolved.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  return HOOK_EVENT_NAMES.filter(
    (event) => resolved.matrix?.[`${event}.observe` as keyof typeof resolved.matrix] !== undefined,
  );
}

function playbackPluginSource(events: readonly HookEventName[]): string {
  const definitions = events.map((event) => {
    const capabilities =
      event === "tool.before"
        ? `capabilities: {
        "tool.before.block": "optional",
        "tool.before.input.replace": "optional",
      },`
        : "";
    const rewrite =
      event === "tool.before"
        ? `
        const command = event.tool.shell?.command;
        if (command?.includes("hooknostic-blocked")) {
          return block("blocked by harness playback");
        }
        if (command?.includes("hooknostic-original")) {
          return updateShell({
            command: command.replace("hooknostic-original", "hooknostic-rewritten"),
          });
        }`
        : "";
    return `
    hook(${JSON.stringify(event)}, {
      id: ${JSON.stringify(`playback-${event}`)},
      ${capabilities}
      async run(event) {
        appendFileSync(tracePath, JSON.stringify({
          event: event.event,
          nativeEvent: event.harness.nativeEvent,
          harnessVersion: event.harness.version,
        }) + "\\n");${rewrite}
      },
    })`;
  });

  return `
import { appendFileSync } from "node:fs";
import { block, definePlugin, hook, updateShell } from "@hooknostic/sdk";

const tracePath = process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
if (!tracePath) throw new Error("HOOKNOSTIC_PLAYBACK_TRACE is required");

export default definePlugin({
  name: "harness-playback",
  hooks: [${definitions.join(",")}
  ],
});
`;
}

export async function buildPlaybackArtifact(
  adapter: HarnessAdapter,
  artifactDir: string,
): Promise<PlaybackBuild> {
  if (adapter.shimEntry === undefined || adapter.shimAliases === undefined) {
    throw new Error(`${adapter.id}: playback requires a generated shim entry and aliases`);
  }

  const events = observedEvents(adapter);
  const entryPath = join(artifactDir, "playback-hooks.ts");
  const tracePath = join(artifactDir, "hook-trace.jsonl");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(entryPath, playbackPluginSource(events), "utf8");

  const hooks = events.map((event) =>
    hook(event, {
      id: `playback-${event}`,
      ...(event === "tool.before"
        ? {
            capabilities: {
              "tool.before.block": "optional" as const,
              "tool.before.input.replace": "optional" as const,
            },
          }
        : {}),
      async run() {},
    }),
  );
  const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "harness-playback", hooks }));
  if (ir === undefined) {
    throw new Error(
      `${adapter.id}: could not build playback IR: ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  const target = targetFor(adapter, artifactDir);
  const resolution = adapter.capabilities(target);
  const capabilities = Object.fromEntries(
    Object.entries(resolution.matrix ?? {}).map(([id, entry]) => [id, entry.level]),
  );
  const bundle = await bundleRuntime({
    source: adapter.shimEntry({
      entryImportPath: entryPath.replaceAll("\\", "/"),
      capabilities,
      minimumCapabilityLevel: "approximate",
      policy: RUNTIME_POLICY,
      harnessVersion: adapter.harness.referenceVersion,
    }),
    resolveDir: artifactDir,
    alias: {
      ...adapter.shimAliases(),
      // The generated source lives in a scratch project with no node_modules.
      // Point its one user-facing import back at this workspace; imports from
      // the adapter shim resolve relative to the shim package itself.
      "@hooknostic/sdk": require.resolve("@hooknostic/sdk"),
    },
  });
  const artifacts = await adapter.compile(ir, target, bundle, { runtime: RUNTIME_POLICY });
  for (const artifact of artifacts) {
    const path = join(artifactDir, artifact.path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, artifact.contents, "utf8");
    if (artifact.executable === true) await chmod(path, 0o755);
  }

  const runtime = artifacts.find((artifact) =>
    adapter.shimExecution === "command"
      ? artifact.path.endsWith("hooknostic.mjs")
      : artifact.path.endsWith("hooknostic.js"),
  );
  if (runtime === undefined) throw new Error(`${adapter.id}: generated runtime artifact not found`);
  return { artifactDir, runtimePath: join(artifactDir, runtime.path), tracePath, events };
}

function runNode(
  args: string[],
  options: { cwd: string; input: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new Error(`${command} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, options.timeoutMs ?? 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

function jsonSchemaForTool(tool: Record<string, unknown>): Record<string, unknown> {
  const direct = tool["parameters"] ?? tool["input_schema"];
  if (direct !== null && typeof direct === "object") return direct as Record<string, unknown>;
  const fn = tool["function"];
  if (fn !== null && typeof fn === "object") {
    const parameters = (fn as Record<string, unknown>)["parameters"];
    if (parameters !== null && typeof parameters === "object") {
      return parameters as Record<string, unknown>;
    }
  }
  return {};
}

function toolName(tool: Record<string, unknown>): string | undefined {
  if (typeof tool["name"] === "string") return tool["name"];
  const fn = tool["function"];
  if (fn !== null && typeof fn === "object") {
    const name = (fn as Record<string, unknown>)["name"];
    if (typeof name === "string") return name;
  }
  return undefined;
}

function requestTools(request: Record<string, unknown>): Record<string, unknown>[] {
  const tools = request["tools"];
  if (Array.isArray(tools)) return tools as Record<string, unknown>[];
  if (tools !== null && typeof tools === "object") {
    return Object.entries(tools).map(([name, value]) => ({
      ...(value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}),
      name,
    }));
  }
  return [];
}

function scriptedTool(
  request: Record<string, unknown>,
  scenario: PlaybackScenario,
): { name: string; arguments: string } {
  const tools = requestTools(request);
  const tool = tools.find((candidate) => /bash|shell|exec/i.test(toolName(candidate) ?? ""));
  if (tool === undefined) {
    throw new Error(`playback request exposed no shell tool: ${JSON.stringify(tools)}`);
  }
  const schema = jsonSchemaForTool(tool);
  const properties =
    schema["properties"] !== null && typeof schema["properties"] === "object"
      ? (schema["properties"] as Record<string, Record<string, unknown>>)
      : {};
  const key = ["command", "cmd"].find((candidate) => properties[candidate] !== undefined);
  if (key === undefined) {
    throw new Error(`playback shell tool has no captured command key: ${JSON.stringify(tool)}`);
  }
  const script =
    scenario === "rewrite"
      ? "require('node:fs').writeFileSync('hooknostic-tool.txt','hooknostic-original')"
      : scenario === "block"
        ? "require('node:fs').writeFileSync('hooknostic-blocked.txt','unexpected-execution')"
        : "process.stderr.write('hooknostic-intentional-failure');process.exit(17)";
  const command = `node -e "${script}"`;
  const value = properties[key]?.["type"] === "array" ? ["node", "-e", script] : command;
  return { name: toolName(tool)!, arguments: JSON.stringify({ [key]: value }) };
}

function sse(
  response: ServerResponse,
  events: unknown[],
  namedEvents = false,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    const name =
      namedEvents && event !== null && typeof event === "object" && "type" in event
        ? `event: ${String(event.type)}\n`
        : "";
    response.write(`${name}data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function anthropicTurn(
  response: ServerResponse,
  request: Record<string, unknown>,
  turn: number,
  scenario: PlaybackScenario,
): void {
  const message = {
    id: `msg_playback_${turn}`,
    type: "message",
    role: "assistant",
    model: "hooknostic-playback",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const events: unknown[] = [{ type: "message_start", message }];
  if (turn === 1) {
    const tool = scriptedTool(request, scenario);
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_playback", name: tool.name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: tool.arguments },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 8 },
      },
    );
  } else {
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "playback complete" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    );
  }
  events.push({ type: "message_stop" });
  sse(response, events, true);
}

function responsesTurn(
  response: ServerResponse,
  request: Record<string, unknown>,
  turn: number,
  scenario: PlaybackScenario,
): void {
  const id = `resp_playback_${turn}`;
  const events: unknown[] = [{ type: "response.created", response: { id } }];
  if (turn === 1) {
    const tool = scriptedTool(request, scenario);
    const item = {
      id: "fc_playback",
      call_id: "call_playback",
      type: "function_call",
      name: tool.name,
      arguments: tool.arguments,
      status: "completed",
    };
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: tool.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item },
    );
  } else {
    events.push(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_playback",
          status: "completed",
          content: [{ type: "output_text", text: "playback complete", annotations: [] }],
        },
      },
    );
  }
  events.push({
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 10,
        input_tokens_details: null,
        output_tokens: 3,
        output_tokens_details: null,
        total_tokens: 13,
      },
    },
  });
  sse(response, events);
}

function chatTurn(
  response: ServerResponse,
  request: Record<string, unknown>,
  turn: number,
  scenario: PlaybackScenario,
): void {
  const base = {
    id: `chatcmpl-playback-${turn}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "hooknostic-playback",
  };
  const events: unknown[] = [];
  if (turn === 1) {
    const tool = scriptedTool(request, scenario);
    events.push(
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_playback",
                  type: "function",
                  function: { name: tool.name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: tool.arguments } }] },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    );
  } else {
    events.push(
      {
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant", content: "playback complete" }, finish_reason: null },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    );
  }
  sse(response, events);
}

export async function startModelPlayback(
  protocol: ModelProtocol,
  scenario: PlaybackScenario = "rewrite",
): Promise<ModelPlayback> {
  const requests: unknown[] = [];
  const errors: string[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "hooknostic-playback", object: "model", owned_by: "hooknostic" }],
          }),
        );
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
      requests.push(parsed);
      if (request.url?.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      try {
        // Harnesses may make auxiliary model calls (for example, to title a
        // session). They carry no tools and must not consume an agent-turn
        // playback step.
        const isAgentTurn = requestTools(parsed).length > 0;
        if (isAgentTurn) turn += 1;
        const scriptedTurn = isAgentTurn ? turn : 2;
        if (protocol === "anthropic-messages") {
          anthropicTurn(response, parsed, scriptedTurn, scenario);
        } else if (protocol === "openai-responses") {
          responsesTurn(response, parsed, scriptedTurn, scenario);
        } else {
          chatTurn(response, parsed, scriptedTurn, scenario);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message } }));
      }
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function fixturePairs(fixturesDir: string) {
  const names = (await readdir(fixturesDir))
    .filter((name) => name.endsWith(".input.json"))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const stem = name.slice(0, -".input.json".length);
      return {
        name,
        input: JSON.parse(await readFile(join(fixturesDir, name), "utf8")) as Record<
          string,
          unknown
        >,
        canonical: JSON.parse(
          await readFile(join(fixturesDir, `${stem}.canonical.json`), "utf8"),
        ) as { event: HookEventName },
      };
    }),
  );
}

async function readTrace(path: string): Promise<{ event: HookEventName }[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: HookEventName });
}

export async function traceEvents(path: string): Promise<HookEventName[]> {
  return (await readTrace(path)).map((entry) => entry.event);
}

export async function replayCommandFixtures(
  build: PlaybackBuild,
  fixturesDir: string,
): Promise<void> {
  const pairs = await fixturePairs(fixturesDir);
  for (const fixture of pairs) {
    const result = await runNode([build.runtimePath], {
      cwd: build.artifactDir,
      input: JSON.stringify(fixture.input),
      env: { ...process.env, HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath },
    });
    expect(result.code, `${fixture.name}: ${result.stderr}`).toBe(0);
  }
  expect((await readTrace(build.tracePath)).map((entry) => entry.event)).toEqual(
    pairs.map((fixture) => fixture.canonical.event),
  );
}

export async function replayOpenCodeFixtures(
  build: PlaybackBuild,
  fixturesDir: string,
): Promise<void> {
  const pairs = await fixturePairs(fixturesDir);
  const previousTrace = process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
  process.env["HOOKNOSTIC_PLAYBACK_TRACE"] = build.tracePath;
  try {
    const imported = (await import(`${pathToFileURL(build.runtimePath).href}?playback=1`)) as {
      default: (input: { directory: string; worktree?: string }) => Promise<
        Record<string, (input: unknown, output: unknown) => Promise<void>>
      >;
    };
    for (const fixture of pairs) {
      const native = fixture.input as {
        hook: string;
        directory: string;
        worktree?: string;
        input: unknown;
        output?: unknown;
      };
      const callbacks = await imported.default({
        directory: native.directory,
        ...(native.worktree !== undefined ? { worktree: native.worktree } : {}),
      });
      const callback = callbacks[native.hook];
      expect(callback, `${fixture.name}: generated plugin did not register ${native.hook}`).toBeDefined();
      await callback!(native.input, native.output ?? {});
    }
  } finally {
    if (previousTrace === undefined) delete process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
    else process.env["HOOKNOSTIC_PLAYBACK_TRACE"] = previousTrace;
  }
  expect((await readTrace(build.tracePath)).map((entry) => entry.event)).toEqual(
    pairs.map((fixture) => fixture.canonical.event),
  );
}
