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
import type { CapabilityId, HookEventName } from "@hooknostic/sdk";
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
  urls: string[];
  /** How many agent turns (model requests carrying tools) have been served. */
  readonly turnCount: number;
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

/**
 * Effect behaviors the generated playback artifact wires in, on top of trace
 * observation. All env-gated at runtime so one artifact serves every scenario
 * drive: `HOOKNOSTIC_PLAYBACK_EFFECTS` is a comma-separated list.
 */
export type PlaybackEffect =
  | "context-add" // addContext on every event that has the cell
  | "block-prompt" // prompt.before.block fires on the sentinel prompt
  | "prevent-stop-once" // stop.prevent on the first stop event only
  | "notify" // notify on stop events
  | "block-continuation" // tool.after.blockContinuation on the sentinel marker
  | "request-approval" // tool.before.requestApproval on the sentinel marker
  | "permission-deny" // permission.request.block on any permission prompt
  | "replace-outputs"; // tool.after.output.replace on MCP tool outputs

export const ALL_PLAYBACK_EFFECTS: readonly PlaybackEffect[] = [
  "context-add",
  "block-prompt",
  "prevent-stop-once",
  "notify",
  "block-continuation",
  "request-approval",
  "permission-deny",
  "replace-outputs",
];

function playbackPluginSource(events: readonly HookEventName[]): string {
  const definitions = events.map((event) => {
    const capabilities = [
      event === "tool.before"
        ? `"tool.before.block": "optional",
        "tool.before.input.replace": "optional",
        "tool.before.requestApproval": "optional"`
        : undefined,
      event === "tool.after"
        ? `"tool.after.blockContinuation": "optional",
        "tool.after.output.replace": "optional"`
        : undefined,
      event === "permission.request" ? `"permission.request.block": "optional"` : undefined,
      event === "prompt.before" ? `"prompt.before.block": "optional"` : undefined,
      event === "agent.stop" ? `"agent.stop.prevent": "optional"` : undefined,
      event === "turn.stop" ? `"turn.stop.prevent": "optional"` : undefined,
      // context-add applies to every event with a context.add cell resolved
      // at build time; addContext on an unsupported event is a no-op error,
      // so only declare it where the resolution advertises the capability.
      `"${event}.context.add": "optional"`,
    ].filter(Boolean);
    const capabilityBlock =
      capabilities.length > 0
        ? `capabilities: {
        ${capabilities.join(",\n        ")},
      },`
        : "";

    const extraEffects = `
        const effects = (process.env["HOOKNOSTIC_PLAYBACK_EFFECTS"] ?? "").split(",").filter(Boolean);
        const command = event.tool?.shell?.command;
        if (effects.includes("context-add")) {
          return addContext("hooknostic-context [${event}]");
        }
        if (effects.includes("block-prompt") && "${event}" === "prompt.before" &&
            typeof event.prompt === "string" && event.prompt.includes("hooknostic-block-this-prompt")) {
          return block("prompt blocked by harness playback");
        }
        if (effects.includes("block-continuation") && "${event}" === "tool.after" &&
            typeof event.output === "string" &&
            event.output.includes("hooknostic-block-continuation")) {
          return blockContinuation("continuation blocked by harness playback");
        }
        if (effects.includes("replace-outputs") && "${event}" === "tool.after" &&
            event.tool?.kind === "mcp") {
          return replaceOutput("hooknostic-replaced-tool-output");
        }
        if (effects.includes("request-approval") && "${event}" === "tool.before" &&
            command?.includes("hooknostic-approval")) {
          return requestApproval("approval requested by harness playback");
        }
        if (effects.includes("permission-deny") && "${event}" === "permission.request") {
          return block("permission denied by harness playback");
        }
        if (effects.includes("prevent-stop-once") && ("${event}" === "turn.stop" || "${event}" === "agent.stop") &&
            (event.raw?.stop_hook_active ?? false) !== true) {
          return preventStop("stop prevented once by harness playback");
        }
        if (effects.includes("notify") && ("${event}" === "turn.stop" || "${event}" === "agent.stop")) {
          return notify("hooknostic-notify-marker");
        }
        if (event.event === "tool.before" && command?.includes("hooknostic-blocked")) {
          return block("blocked by harness playback");
        }
        if (event.event === "tool.before" && command?.includes("hooknostic-original")) {
          return updateShell({
            command: command.replace("hooknostic-original", "hooknostic-rewritten"),
          });
        }`;

    return `
    hook(${JSON.stringify(event)}, {
      id: ${JSON.stringify(`playback-${event}`)},
      ${capabilityBlock}
      async run(event) {
        appendFileSync(tracePath, JSON.stringify({
          event: event.event,
          nativeEvent: event.harness.nativeEvent,
          harnessVersion: event.harness.version,
        }) + "\\n");${extraEffects}
      },
    })`;
  });

  return `
import { appendFileSync } from "node:fs";
import {
  addContext,
  block,
  blockContinuation,
  definePlugin,
  hook,
  notify,
  preventStop,
  replaceOutput,
  requestApproval,
  updateShell,
} from "@hooknostic/sdk";

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

  // IR capability declarations must mirror the generated source's `capabilities`
  // blocks: the analyzer validates every returned effect against the declared
  // set, so an effect the source can emit must also be declared here.
  const contextCapabilityFor = (event: HookEventName): string | undefined =>
    `${event}.context.add` in (adapter.capabilities(targetFor(adapter, ".")).matrix ?? {})
      ? `${event}.context.add`
      : undefined;
  const hooks = events.map((event) =>
    hook(event, {
      id: `playback-${event}`,
      ...((): { capabilities: Record<CapabilityId, "optional"> } | Record<string, never> => {
        const declared: Partial<Record<CapabilityId, "optional">> = {};
        if (event === "tool.before") {
          declared["tool.before.block"] = "optional" as const;
          declared["tool.before.input.replace"] = "optional" as const;
          declared["tool.before.requestApproval"] = "optional" as const;
        }
        if (event === "tool.after") {
          declared["tool.after.blockContinuation"] = "optional" as const;
          declared["tool.after.output.replace"] = "optional" as const;
        }
        if (event === "permission.request") {
          declared["permission.request.block"] = "optional" as const;
        }
        if (event === "prompt.before") {
          declared["prompt.before.block"] = "optional" as const;
        }
        if (event === "agent.stop") {
          declared["agent.stop.prevent"] = "optional" as const;
        }
        if (event === "turn.stop") {
          declared["turn.stop.prevent"] = "optional" as const;
        }
        const context = contextCapabilityFor(event);
        if (context !== undefined) declared[context as CapabilityId] = "optional" as const;
        return Object.keys(declared).length > 0
          ? { capabilities: declared as Record<CapabilityId, "optional"> }
          : {};
      })(),
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
  // Codex wraps MCP tools in namespace groups: {type:"namespace", name:
  // "mcp__<server>", tools:[...]}. Track the namespace so a scripted call can
  // emit the fully-qualified routable name `mcp__<server>.<tool>` (verified on
  // codex 0.151.0 -- the router rejects the bare inner name).
  const flatten = (entries: unknown[], namespace?: string): Record<string, unknown>[] =>
    entries.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (record["type"] === "namespace" && Array.isArray(record["tools"])) {
        return flatten(record["tools"] as unknown[], String(record["name"] ?? ""));
      }
      return [namespace ? { ...record, namespace } : record];
    });
  if (Array.isArray(tools)) return flatten(tools);
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
  marker = "hooknostic-tool.txt",
  preferredTool?: string,
): { name: string; namespace?: string; arguments: string } {
  const tools = requestTools(request);
  const tool = preferredTool
    ? tools.find((candidate) => toolName(candidate)?.endsWith(preferredTool))
    : tools.find((candidate) => /bash|shell|exec/i.test(toolName(candidate) ?? ""));
  if (tool === undefined) {
    throw new Error(`playback request exposed no usable tool: ${JSON.stringify(tools)}`);
  }
  const name = toolName(tool)!;
  if (tool["namespace"] !== undefined) {
    // MCP tools route by their flattened identifier `mcp__<server>__<tool>`
    // (the JS-identifier form the router registers; verified formatting in the
    // codex 0.151.0 code-mode docs embedded in the binary). The fixture tool
    // takes no arguments.
    return {
      name: `${String(tool["namespace"])}__${name}`,
      arguments: JSON.stringify({}),
    };
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
  let script: string;
  if (scenario === "rewrite") {
    script = `require('node:fs').writeFileSync('${marker}','hooknostic-original')`;
  } else if (scenario === "block") {
    script = `require('node:fs').writeFileSync('hooknostic-blocked.txt','unexpected-execution')`;
  } else {
    script = "process.stderr.write('hooknostic-intentional-failure');process.exit(17)";
  }
  if (process.env["HOOKNOSTIC_PLAYBACK_FILL"] !== undefined) {
    // Compaction drive: the command emits a huge stdout payload on top of the
    // marker write so each tool result fills the context window and forces the
    // harness to compact. The fill marker in the output lets the test assert
    // the growth reached the model side.
    const fill = "hooknostic-fill ".repeat(6_000);
    script += `;process.stdout.write(process.env['HOOKNOSTIC_PLAYBACK_FILL'])`;
    void fill;
  }
  const command = `node -e "${script}"`;
  const value = properties[key]?.["type"] === "array" ? ["node", "-e", script] : command;
  return {
    // For MCP tools the router expects the ResponseItem's `namespace` field to
    // carry the server id and `name` the bare tool name.
    name: toolName(tool)!,
    ...(tool["namespace"] !== undefined ? { namespace: String(tool["namespace"]) } : {}),
    arguments: JSON.stringify({ [key]: value }),
  };
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

/** True for any URL path serving a model list (models-manager refresh). */
function urlPathToModels(urlPath: string): boolean {
  return /\/v\d+\/models$/.test(urlPath) || urlPath === "/models";
}

/**
 * What the scripted model does on one agent turn. `tool` emits one tool call
 * (the harness's shell tool by default, or `toolName` â€” e.g. the MCP fixture
 * tool â€” when set), `text` completes the conversation with plain text.
 */
export interface TurnAction {
  kind: "tool" | "text";
  /** The disposition of the emitted tool call; only for `kind: "tool"`. */
  disposition?: PlaybackScenario;
  /** Marker filename the tool script writes; only for `kind: "tool"`. */
  marker?: string;
  /** Exact tool name to call (defaults to the first shell-like tool declared). */
  toolName?: string;
  /** Text emitted for `kind: "text"`. */
  text?: string;
}

function anthropicTurn(
  response: ServerResponse,
  request: Record<string, unknown>,
  turn: number,
  action: TurnAction,
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
  if (action.kind === "tool") {
    const tool = scriptedTool(request, action.disposition ?? "rewrite", action.marker, action.toolName);
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
        delta: { type: "text_delta", text: action.text ?? "playback complete" },
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
  action: TurnAction,
): void {
  const id = `resp_playback_${turn}`;
  const events: unknown[] = [{ type: "response.created", response: { id } }];
  if (action.kind === "tool") {
    const tool = scriptedTool(request, action.disposition ?? "rewrite", action.marker, action.toolName);
    const item = {
      id: "fc_playback",
      call_id: "call_playback",
      type: "function_call",
      name: tool.name,
      ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {}),
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
          content: [
            { type: "output_text", text: action.text ?? "playback complete", annotations: [] },
          ],
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
  action: TurnAction,
): void {
  const base = {
    id: `chatcmpl-playback-${turn}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "hooknostic-playback",
  };
  const events: unknown[] = [];
  if (action.kind === "tool") {
    const tool = scriptedTool(request, action.disposition ?? "rewrite", action.marker, action.toolName);
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
          {
            index: 0,
            delta: { role: "assistant", content: action.text ?? "playback complete" },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    );
  }
  sse(response, events);
}

/**
 * A scenario script: one TurnAction per agent turn. Turn 1 runs the shell
 * tool; a final `text` turn completes the conversation; intermediate `tool`
 * turns drive multi-call drives (stop-prevention's second model turn).
 */
export type ScenarioScript = readonly TurnAction[];

export async function startModelPlayback(
  protocol: ModelProtocol,
  scenario: PlaybackScenario = "rewrite",
  script?: ScenarioScript,
): Promise<ModelPlayback> {
  const turns: ScenarioScript =
    script ??
    (scenario === "rewrite" || scenario === "block" || scenario === "fail"
      ? [
          { kind: "tool", disposition: scenario },
          { kind: "text" },
        ]
      : [{ kind: "text", text: "playback complete" }]);
  const requests: unknown[] = [];
  const errors: string[] = [];
  const urls: string[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    urls.push(`${request.method} ${request.url}`);
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Models refresh hits /models, /v1/models, sometimes with a query
      // string. Codex's manager expects `models` as a list of ModelInfo
      // structs (slug, supported_reasoning_levels, ...); other harnesses
      // expect the OpenAI `data` list. Serve both keys with a full struct.
      const urlPath = request.url?.split("?")[0] ?? "";
      if (urlPathToModels(urlPath)) {
        response.writeHead(200, { "content-type": "application/json" });
        const modelInfo = {
          slug: "hooknostic-playback",
          display_name: "Hooknostic Playback",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "minimal", description: "fastest" },
            { effort: "low", description: "low" },
            { effort: "medium", description: "default" },
            { effort: "high", description: "deepest" },
          ],
          shell_type: "default",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          supports_reasoning_summary_parameter: false,
          default_reasoning_summary: "none",
          support_verbosity: false,
          default_verbosity: "medium",
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text",
          truncation_policy: { mode: "tokens", limit: 30_000 },
          supports_image_detail_original: false,
          max_context_window_tokens: 32_768,
          auto_compact_token_limit: 24_576,
          effective_context_window_percent: 100,
          input_modalities: ["text"],
          experimental_supported_tools: [],
          base_instructions: "You are a playback model for hooknostic tests.",
          supports_search_tool: false,
          use_responses_lite: false,
          tool_mode: "unified",
          multi_agent_reasoning_effort: "medium",
          context_window: 32_768,
          max_output_tokens: 4_096,
          supports_parallel_tool_calls: false,
          supports_reasoning_summaries: false,
        };
        response.end(
          JSON.stringify({
            object: "list",
            models: [modelInfo],
            data: [
              { ...modelInfo, object: "model", owned_by: "hooknostic" },
            ],
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
        // Past the script's last turn the model keeps completing with text:
        // a harness that re-prompts (stop prevention) or retries gets a
        // defined response, never a 500.
        const action = turns[Math.min(turn, turns.length) - 1] ?? { kind: "text" as const };
        if (protocol === "anthropic-messages") {
          anthropicTurn(response, parsed, turn, action);
        } else if (protocol === "openai-responses") {
          responsesTurn(response, parsed, turn, action);
        } else {
          chatTurn(response, parsed, turn, action);
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
    urls,
    get turnCount() {
      return turn;
    },
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
