import { type ChildProcessWithoutNullStreams, spawn, type SpawnOptions } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "vitest";

import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type { HarnessAdapter, ProjectComponentOptions, TargetSpec } from "@hooknostic/core";
import { applyProject, reconcileProject } from "@hooknostic/core";
import { buildPluginIR, bundleRuntime } from "@hooknostic/core";
import type { CapabilityId, EventFieldId, HookEventName } from "@hooknostic/sdk";
import { definePlugin, hook, HOOK_EVENT_NAMES } from "@hooknostic/sdk";

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
  project?: boolean;
  artifactDir: string;
  runtimePath: string;
  tracePath: string;
  events: HookEventName[];
  fields: readonly EventFieldId[];
}

export type ModelProtocol = "anthropic-messages" | "openai-responses" | "openai-chat";
export type PlaybackScenario = "rewrite" | "block" | "fail" | "continuation";
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

/**
 * Overrides for a lane exercising something other than the default boundary.
 *
 * A mode other than the adapter's first is a different delivery path, whose
 * effect channels the default does not evidence (ADR-0011, sixth amendment);
 * such a mode may also be established only above `referenceVersion`, which is
 * why the version travels with it.
 */
export interface PlaybackTargetOverride {
  components?: ProjectComponents;
  componentOptions?: ProjectComponentOptions;
  project?: boolean;
  delivery?: TargetSpec["delivery"];
  version?: string;
  /** Written into every trace line, to tell apart copies sharing one trace file. */
  label?: string;
  /**
   * Give the tool.before hook `match: { kind: "shell" }`, so the generated
   * native matcher (where the adapter emits one) is part of what the drive
   * exercises. The default hook matches every tool and emits no matcher.
   */
  shellMatch?: boolean;
}

function targetFor(adapter: HarnessAdapter, output: string, override: PlaybackTargetOverride = {}) {
  return {
    id: adapter.id,
    version: override.version ?? adapter.harness.referenceVersion,
    delivery: override.delivery ?? adapter.supportedDeliveries()[0]!,
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
 * Events whose `context.add` cell resolves at the adapter's referenceVersion.
 * The single source of truth for both the IR declarations and the generated
 * plugin source: `addContext` on an event outside this set is an HN401
 * unsupported-effect error at runtime (fail-open, unasserted), so both views
 * must limit the effect to this set.
 */
export function contextAddEvents(adapter: HarnessAdapter): ReadonlySet<HookEventName> {
  const target = targetFor(adapter, ".");
  const matrix = adapter.capabilities(target).matrix ?? {};
  return new Set(
    HOOK_EVENT_NAMES.filter((event) => matrix[`${event}.context.add` as keyof typeof matrix] !== undefined),
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
  | "replace-outputs"; // tool.after.output.replace

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

function playbackPluginSource(
  events: readonly HookEventName[],
  contextAdd: ReadonlySet<HookEventName>,
  fields: readonly EventFieldId[],
  label?: string,
  shellMatch = false,
): string {
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
      event === "agent.stop"
        ? `"agent.stop.prevent": "optional",
        "agent.stop.notify": "optional"`
        : undefined,
      event === "turn.stop"
        ? `"turn.stop.prevent": "optional",
        "turn.stop.notify": "optional"`
        : undefined,
      // context-add is declared and emitted only on events whose context.add
      // cell resolved at build time — exactly the IR's declaration set. It
      // must mirror contextAddEvents(): addContext on an unsupported event is
      // an HN401 unsupported-effect error at runtime (fail-open), so a
      // declared-but-unresolved cell would produce unasserted dispatch noise.
      contextAdd.has(event) ? `"${event}.context.add": "optional"` : undefined,
    ].filter(Boolean);
    // ADR-0027: declare only fields this target rates. Pi observes these
    // events without claiming their optional turn id or last-message fields.
    const eventFields = fields.filter((field) => field.startsWith(`${event}.`));
    const turnFields = eventFields.length > 0 ? `fields: ${JSON.stringify(eventFields)},\n      ` : "";
    const capabilityBlock =
      capabilities.length > 0
        ? `capabilities: {
        ${capabilities.join(",\n        ")},
      },`
        : "";

    const contextAddBranch = contextAdd.has(event)
      ? `
        if (effects.includes("context-add")) {
          return addContext("hooknostic-context [${event}]");
        }`
      : "";

    const extraEffects = `
        const effects = (process.env["HOOKNOSTIC_PLAYBACK_EFFECTS"] ?? "").split(",").filter(Boolean);
        const command = event.tool?.shell?.command;${contextAddBranch}
        if (effects.includes("block-prompt") && "${event}" === "prompt.before" &&
            typeof event.prompt === "string" && event.prompt.includes("hooknostic-block-this-prompt")) {
          return block("prompt blocked by harness playback");
        }
        if (effects.includes("block-continuation") && "${event}" === "tool.after") {
          const outputText =
            typeof event.output === "string"
              ? event.output
              : typeof event.output === "object" && event.output !== null &&
                  typeof (event.output as { stdout?: unknown }).stdout === "string"
                ? (event.output as { stdout: string }).stdout
                : "";
          if (outputText.includes("hooknostic-block-continuation")) {
            return blockContinuation("continuation blocked by harness playback");
          }
        }
        if (effects.includes("replace-outputs") && "${event}" === "tool.after") {
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
            (event.raw?.stop_hook_active ?? false) !== true && !preventedSessions.has(event.session.id ?? "")) {
          preventedSessions.add(event.session.id ?? "");
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
      id: ${JSON.stringify(`playback-${event}`)},${shellMatch && event === "tool.before" ? `\n      match: { kind: "shell" },` : ""}
      ${turnFields}${capabilityBlock}
      async run(event) {
        appendFileSync(tracePath, JSON.stringify({
          event: event.event,
          nativeEvent: event.harness.nativeEvent,
          harnessVersion: event.harness.version,
          toolKind: event.tool?.kind,
          toolNativeName: event.tool?.nativeName,
          lastMessage: event.lastMessage,
          turnId: event.correlation.turnId,${label === undefined ? "" : `\n          label: ${JSON.stringify(label)},`}
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
// OpenCode has no stop_hook_active flag and runs hooks in-process; command-hook
// harnesses start a fresh process per dispatch, where this stays empty.
const preventedSessions = new Set();

export default definePlugin({
  name: "harness-playback",
  version: "0.0.0",
  hooks: [${definitions.join(",")}
  ],
});
`;
}

export async function buildPlaybackArtifact(
  adapter: HarnessAdapter,
  artifactDir: string,
  override: PlaybackTargetOverride = {},
): Promise<PlaybackBuild> {
  if (adapter.shimEntry === undefined || adapter.shimAliases === undefined) {
    throw new Error(`${adapter.id}: playback requires a generated shim entry and aliases`);
  }

  const events = observedEvents(adapter);
  const contextAdd = contextAddEvents(adapter);
  const target = targetFor(adapter, artifactDir, override);
  const resolution = adapter.capabilities(target);
  const fields = (
    ["prompt.before.correlation.turnId", "turn.stop.lastMessage", "turn.stop.correlation.turnId"] as const
  ).filter((field) => {
    const level = resolution.fields?.[field]?.level;
    return level !== undefined && level !== "unsupported";
  });
  const entryPath = join(artifactDir, "playback-hooks.ts");
  const tracePath = join(artifactDir, "hook-trace.jsonl");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    entryPath,
    playbackPluginSource(events, contextAdd, fields, override.label, override.shellMatch),
    "utf8",
  );

  // IR capability declarations must mirror the generated source's `capabilities`
  // blocks: the analyzer validates every returned effect against the declared
  // set, so an effect the source can emit must also be declared here. Both
  // views take their context.add set from the same contextAddEvents()
  // resolution.
  const contextCapabilityFor = (event: HookEventName): string | undefined =>
    contextAdd.has(event) ? `${event}.context.add` : undefined;
  // `event` spans the whole union here, so no single typed capability map fits
  // `hook()`; the full-id declarations go straight onto the erased definition,
  // which is the form hook() itself produces.
  const hooks = events.map((event) => {
    const definition = hook(event, {
      id: `playback-${event}`,
      ...(override.shellMatch && event === "tool.before" ? { match: { kind: "shell" as const } } : {}),
      async run() {},
    });
    definition.fields = fields.filter((field) => field.startsWith(`${event}.`));
    definition.capabilities = ((): Partial<Record<CapabilityId, "optional">> => {
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
        declared["agent.stop.notify"] = "optional" as const;
      }
      if (event === "turn.stop") {
        declared["turn.stop.prevent"] = "optional" as const;
        declared["turn.stop.notify"] = "optional" as const;
      }
      const context = contextCapabilityFor(event);
      if (context !== undefined) declared[context as CapabilityId] = "optional" as const;
      return declared;
    })();
    return definition;
  });
  const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "harness-playback", version: "0.0.0", hooks }));
  if (ir === undefined) {
    throw new Error(
      `${adapter.id}: could not build playback IR: ${diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
    );
  }

  const capabilities = Object.fromEntries(
    Object.entries(resolution.matrix ?? {}).map(([id, entry]) => [id, entry.level]),
  );
  const bundle = await bundleRuntime({
    source: adapter.shimEntry({
      entryImportPath: entryPath.replaceAll("\\", "/"),
      capabilities,
      minimumCapabilityLevel: "approximate",
      policy: RUNTIME_POLICY,
      harnessVersion: override.version ?? adapter.harness.referenceVersion,
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
  const prefix = override.project ? `.hooknostic/artifacts/${adapter.id}` : "";
  if (override.project) {
    if (!adapter.projectIntegration) throw new Error("missing project integrator");
    const integration = adapter.projectIntegration(artifacts, prefix, "hooknostic.config.ts");
    if (override.components) {
      if (!adapter.projectComponents) throw new Error("missing project component integrator");
      const components = await adapter.projectComponents(
        override.components,
        artifactDir,
        prefix,
        "hooknostic.config.ts",
        override.componentOptions ?? {},
      );
      integration.files.push(...components.files);
      integration.entries.push(...components.entries);
      if (components.absent) integration.absent = components.absent;
    }
    integration.files.push(...artifacts.map((file) => ({ ...file, path: `${prefix}/${file.path}` })));
    const plan = await reconcileProject(artifactDir, "hooknostic.config.ts", integration);
    await applyProject(artifactDir, "hooknostic.config.ts", plan);
  }
  for (const artifact of override.project ? [] : artifacts) {
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
  return {
    artifactDir,
    runtimePath: join(artifactDir, prefix, runtime.path),
    tracePath,
    events,
    fields,
    ...(override.project ? { project: true } : {}),
  };
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

const crossSpawn = require("cross-spawn") as {
  _parse(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): { command: string; args: string[]; options: SpawnOptions; file?: string };
};
const cmdEscape = require("cross-spawn/lib/util/escape.js") as {
  command(value: string): string;
  argument(value: string, doubleEscape: boolean): string;
};

/**
 * Spawn without a shell splitting arguments. On Windows a harness CLI is usually
 * an npm `.cmd` shim, which cross-spawn resolves through cmd.exe; global shims
 * forward `%*` too, so they get the double escape the MCP launcher applies.
 */
function spawnIntact(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessWithoutNullStreams {
  const parsed = crossSpawn._parse(command, args, options);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(parsed.file ?? "")) {
    const line = [cmdEscape.command(normalize(parsed.file!)), ...args.map((arg) => cmdEscape.argument(arg, true))].join(
      " ",
    );
    parsed.args = ["/d", "/s", "/c", `"${line}"`];
  }
  return spawn(parsed.command, parsed.args, parsed.options) as ChildProcessWithoutNullStreams;
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
    const child = spawnIntact(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" || child.pid === undefined) {
        child.kill();
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      rejectPromise(new Error(`${command} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs ?? 60_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.on("error", (error) => {
      // A harness may exit before consuming stdin; that is not a playback
      // failure, but Node otherwise reports the resulting EPIPE as unhandled.
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Prepares the project-local dependency OpenCode installs before loading a
 * plugin. OpenCode's internal installer can remain pending indefinitely in a
 * fresh non-interactive container, so playback makes the same install
 * explicit before starting the harness. The dependency remains confined to
 * the throwaway playback project.
 */
export function openCodePlaybackConfigHome(projectDir: string): string {
  return join(projectDir, ".opencode-config");
}

export async function prepareOpenCodePluginDependency(projectDir: string, harnessVersion: string): Promise<void> {
  const dependencyDirs = [join(projectDir, ".opencode"), join(openCodePlaybackConfigHome(projectDir), "opencode")];
  for (const dependencyDir of dependencyDirs) {
    const result = await runProcess(
      "npm",
      [
        "install",
        "--prefix",
        dependencyDir,
        "--ignore-scripts",
        "--no-fund",
        "--no-audit",
        "--save-exact",
        `@opencode-ai/plugin@${harnessVersion}`,
      ],
      { cwd: projectDir, env: process.env, timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new Error(
        `OpenCode plugin dependency install exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
  }
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

/**
 * The tools a model request advertised: name, wire type, and the argument keys
 * its schema declares. Capture drives read this from a discovery turn to script
 * calls against the harness's own live schemas instead of remembered ones.
 */
export function describeTools(
  request: Record<string, unknown>,
): { name: string; type?: string; namespace?: string; properties: string[] }[] {
  return requestTools(request).flatMap((tool) => {
    const name = toolName(tool);
    if (name === undefined) return [];
    const schema = jsonSchemaForTool(tool);
    const properties =
      schema["properties"] !== null && typeof schema["properties"] === "object"
        ? Object.keys(schema["properties"] as object)
        : [];
    return [
      {
        name,
        ...(typeof tool["type"] === "string" ? { type: tool["type"] } : {}),
        ...(tool["namespace"] !== undefined ? { namespace: String(tool["namespace"]) } : {}),
        properties,
      },
    ];
  });
}

function scriptedNodeScript(scenario: PlaybackScenario, marker: string): string {
  let script: string;
  if (scenario === "rewrite") {
    script = `require('node:fs').writeFileSync('${marker}','hooknostic-original')`;
  } else if (scenario === "block") {
    script = `require('node:fs').writeFileSync('hooknostic-blocked.txt','unexpected-execution')`;
  } else if (scenario === "continuation") {
    script = `process.stdout.write('hooknostic-block-continuation')`;
  } else {
    script = "process.stderr.write('hooknostic-intentional-failure');process.exit(17)";
  }
  if (process.env["HOOKNOSTIC_PLAYBACK_FILL"] !== undefined) {
    // Compaction drive: the command emits a huge stdout payload on top of the
    // marker write so each tool result fills the context window and forces the
    // harness to compact. The fill marker in the output lets the test assert
    // the growth reached the model side.
    script += `;process.stdout.write(process.env['HOOKNOSTIC_PLAYBACK_FILL'])`;
  }
  return script;
}

function scriptedShellCommand(scenario: PlaybackScenario, marker: string): string {
  return `node -e "${scriptedNodeScript(scenario, marker)}"`;
}

export function scriptedTool(
  request: Record<string, unknown>,
  scenario: PlaybackScenario,
  marker = "hooknostic-tool.txt",
  preferredTool?: string,
  explicitArguments?: Record<string, unknown>,
): { name: string; namespace?: string; arguments: string } {
  const tools = requestTools(request);
  // Exact name first: a bare suffix match would resolve `Edit` to whichever of
  // `Edit`, `MultiEdit` or `NotebookEdit` the harness happened to list first.
  const tool = preferredTool
    ? (tools.find((candidate) => toolName(candidate) === preferredTool) ??
      tools.find((candidate) => toolName(candidate)?.endsWith(preferredTool)))
    : tools.find((candidate) => /bash|shell|exec/i.test(toolName(candidate) ?? ""));
  if (tool === undefined) {
    throw new Error(`playback request exposed no usable tool: ${JSON.stringify(tools)}`);
  }
  const name = toolName(tool)!;
  // Namespace tools (Codex MCP groups, multi_agent_v1) resolve by the exact
  // {namespace, name} pair; the pair emission is the same for every payload,
  // so compute it once and branch only on the arguments below.
  const namespaceEmission =
    tool["namespace"] !== undefined
      ? {
          // The namespace tool spec the model sees carries name
          // "mcp__<server>", and the callable emission mirrors it verbatim:
          // name = bare inner tool name, namespace = the container name
          // ("mcp__<server>", no trailing underscores). The flattened-name form
          // (`mcp__<server>__<tool>` in `name` alone) and the trailing-__
          // namespace variant both fail the exact match with "unsupported
          // call" on codex 0.151.0 (verified live; upstream openai/codex#33263
          // records the same resolution failure for proxy-flattened calls).
          name,
          namespace: String(tool["namespace"]),
        }
      : { name };
  // A capture script names the exact arguments; the harness's own validation
  // then decides whether the call reaches its hooks at all.
  if (explicitArguments !== undefined) return { ...namespaceEmission, arguments: JSON.stringify(explicitArguments) };
  const schema = jsonSchemaForTool(tool);
  const properties =
    schema["properties"] !== null && typeof schema["properties"] === "object"
      ? (schema["properties"] as Record<string, Record<string, unknown>>)
      : {};
  const key = ["command", "cmd"].find((candidate) => properties[candidate] !== undefined);
  if (key === undefined) {
    // Agent tools (Claude `Agent`, Codex `spawn_agent`) take a prompt, not a
    // command. The subagent drive emits a minimal call; the harness's own
    // router validates it against the live tool schema. `run_in_background:
    // false` keeps the subagent synchronous so SubagentStart/SubagentStop
    // both dispatch inside the turn.
    // Codex 0.151.0's spawn_agent names the task `message` ("Use either
    // message or items"); Claude's Agent uses `prompt`. `description` last:
    // some schemas carry one, and emitting it alone fails the harness's own
    // "one of: message or items" validation (observed live on 0.151.0).
    const promptKey = ["message", "prompt", "task", "description"].find(
      (candidate) => properties[candidate] !== undefined,
    );
    if (promptKey !== undefined) {
      return {
        ...namespaceEmission,
        arguments: JSON.stringify({
          ...(properties["description"] !== undefined ? { description: "Playback subagent probe" } : {}),
          [promptKey]: "Say the single word ready, then stop.",
          ...(properties["subagent_type"] !== undefined ? { subagent_type: "general-purpose" } : {}),
          ...(properties["run_in_background"] !== undefined ? { run_in_background: false } : {}),
        }),
      };
    }
    // No prompt key either: a namespace tool taking no arguments (the MCP
    // fixture tool).
    return { ...namespaceEmission, arguments: JSON.stringify({}) };
  }
  const script = scriptedNodeScript(scenario, marker);
  const command = `node -e "${script}"`;
  const value = properties[key]?.["type"] === "array" ? ["node", "-e", script] : command;
  // Emit `description` when the tool schema declares one (Claude's Bash does;
  // fixtures carry it in tool_input). Without it a live capture reads as
  // shape drift against the committed fixtures for purely scripted reasons.
  return {
    ...namespaceEmission,
    arguments: JSON.stringify({
      [key]: value,
      ...(properties["description"] !== undefined ? { description: "Playback probe command" } : {}),
    }),
  };
}

function sse(response: ServerResponse, events: unknown[], namedEvents = false): void {
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
 * (the harness's shell tool by default, or `toolName` — e.g. the MCP fixture
 * tool — when set), `text` completes the conversation with plain text, and
 * `code` emits one Codex Code Mode `exec` custom tool call whose JavaScript
 * calls the nested `tools.exec_command` (OpenAI Responses only).
 */
export interface TurnAction {
  kind: "tool" | "text" | "code";
  /** The disposition of the emitted tool call; only for `kind: "tool"` / `"code"`. */
  disposition?: PlaybackScenario;
  /** Marker filename the tool script writes; only for `kind: "tool"` / `"code"`. */
  marker?: string;
  /** Exact tool name to call (defaults to the first shell-like tool declared). */
  toolName?: string;
  /** Exact JSON arguments for the call, replacing the shell-probe builder. */
  arguments?: Record<string, unknown>;
  /**
   * Raw input for a freeform (grammar) tool such as Codex's `apply_patch`,
   * emitted as a Responses `custom_tool_call`. `openai-responses` only.
   */
  freeformInput?: string;
  /** Text emitted for `kind: "text"`. */
  text?: string;
  /** Extra nested `exec_command` arguments beside `cmd`; only for `kind: "code"`. */
  codeArgs?: Record<string, unknown>;
}

/**
 * The Code Mode `exec` source for one scripted nested shell call. The shape
 * copies the live gpt-5.6-luna emission recorded in
 * `.capture/codex-code-mode/README.md` (`await tools.exec_command({cmd, ...})`
 * then `text(r.output)`); under `code_mode_only` the nested `exec_command` is
 * not declared in the request's `tools`, so there is no schema to read the key
 * from.
 */
export function scriptedCodeModeSource(
  scenario: PlaybackScenario,
  marker = "hooknostic-tool.txt",
  codeArgs: Record<string, unknown> = {},
): string {
  const args = { cmd: scriptedShellCommand(scenario, marker), ...codeArgs };
  return `const r = await tools.exec_command(${JSON.stringify(args)});\ntext(r.output);\n`;
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
    const tool = scriptedTool(
      request,
      action.disposition ?? "rewrite",
      action.marker,
      action.toolName,
      action.arguments,
    );
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: `toolu_playback_${turn}`, name: tool.name, input: {} },
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
  if (action.kind === "code") {
    // Code Mode's `exec` is a Responses freeform (custom) tool, so the call is
    // a `custom_tool_call` item carrying raw JavaScript in `input`, streamed
    // through `response.custom_tool_call_input.delta` -- the item shape the
    // live gpt-5.6-luna rollout recorded (.capture/codex-code-mode).
    if (!requestTools(request).some((tool) => toolName(tool) === "exec" && tool["type"] === "custom")) {
      throw new Error(`playback request advertised no Code Mode exec tool: ${JSON.stringify(requestTools(request))}`);
    }
    const input = scriptedCodeModeSource(action.disposition ?? "rewrite", action.marker, action.codeArgs);
    const item = {
      id: "ctc_playback",
      call_id: "call_playback",
      type: "custom_tool_call",
      name: "exec",
      input,
      status: "completed",
    };
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "", status: "in_progress" } },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: item.id,
        call_id: item.call_id,
        output_index: 0,
        delta: input,
      },
      { type: "response.output_item.done", output_index: 0, item },
    );
  } else if (action.kind === "tool" && action.freeformInput !== undefined) {
    // A grammar tool takes raw text, not JSON arguments: the Responses wire
    // carries it as a custom_tool_call whose `input` is the text itself.
    const name = action.toolName ?? "apply_patch";
    if (!requestTools(request).some((candidate) => toolName(candidate) === name)) {
      throw new Error(`playback request exposed no freeform tool named ${name}`);
    }
    const item = {
      id: `ctc_playback_${turn}`,
      call_id: `call_playback_${turn}`,
      type: "custom_tool_call",
      name,
      input: action.freeformInput,
      status: "completed",
    };
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: 0, delta: item.input },
      { type: "response.custom_tool_call_input.done", item_id: item.id, output_index: 0, input: item.input },
      { type: "response.output_item.done", output_index: 0, item },
    );
  } else if (action.kind === "tool") {
    const tool = scriptedTool(
      request,
      action.disposition ?? "rewrite",
      action.marker,
      action.toolName,
      action.arguments,
    );
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
    const text = action.text ?? "playback complete";
    const item = { type: "message", role: "assistant", id: "msg_playback", status: "in_progress", content: [] };
    const part = { type: "output_text", text, annotations: [] };
    events.push(
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: "" },
      },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part },
    );
    events.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_playback",
        status: "completed",
        content: [{ type: "output_text", text: action.text ?? "playback complete", annotations: [] }],
      },
    });
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

function chatTurn(response: ServerResponse, request: Record<string, unknown>, turn: number, action: TurnAction): void {
  const base = {
    id: `chatcmpl-playback-${turn}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "hooknostic-playback",
  };
  const events: unknown[] = [];
  if (action.kind === "tool") {
    const tool = scriptedTool(
      request,
      action.disposition ?? "rewrite",
      action.marker,
      action.toolName,
      action.arguments,
    );
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

/**
 * The playback model's ModelInfo struct, with `overrides` merged over it.
 *
 * The default advertises no Code Mode: `tool_mode: "unified"` is not a Codex
 * ToolMode, which codex-rs deserializes as omitted (Direct unless a feature
 * flag says otherwise). Codex never refreshes `/models` for this
 * unauthenticated custom provider, so an override reaches it only through a
 * static `model_catalog_json` built from this struct -- a Code Mode drive
 * passes `tool_mode: "code_mode_only"`, the value the real gpt-5.6-luna catalog
 * entry carries (.capture/codex-code-mode).
 */
export function playbackModelInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

export async function startModelPlayback(
  protocol: ModelProtocol,
  scenario: PlaybackScenario = "rewrite",
  script?: ScenarioScript,
): Promise<ModelPlayback> {
  const turns: ScenarioScript =
    script ??
    (scenario === "rewrite" || scenario === "block" || scenario === "fail" || scenario === "continuation"
      ? [{ kind: "tool", disposition: scenario }, { kind: "text" }]
      : [{ kind: "text", text: "playback complete" }]);
  const auxiliaryAction: TurnAction = [...turns].reverse().find((action) => action.kind === "text") ?? { kind: "text" };
  const requests: unknown[] = [];
  const errors: string[] = [];
  const urls: string[] = [];
  let turn = 0;
  const sockets = new Set<Socket>();
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
        const modelInfo = playbackModelInfo();
        response.end(
          JSON.stringify({
            object: "list",
            models: [modelInfo],
            data: [{ ...modelInfo, object: "model", owned_by: "hooknostic" }],
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
        const action = isAgentTurn ? (turns[Math.min(turn, turns.length) - 1] ?? auxiliaryAction) : auxiliaryAction;
        if (action.kind === "code" && protocol !== "openai-responses") {
          throw new Error(`Code Mode turns are only scripted for openai-responses, not ${protocol}`);
        }
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
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
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
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
        for (const socket of sockets) socket.destroy();
      }),
  };
}

async function fixturePairs(fixturesDir: string) {
  const names = (await readdir(fixturesDir)).filter((name) => name.endsWith(".input.json")).sort();
  return Promise.all(
    names.map(async (name) => {
      const stem = name.slice(0, -".input.json".length);
      return {
        name,
        input: JSON.parse(await readFile(join(fixturesDir, name), "utf8")) as Record<string, unknown>,
        canonical: JSON.parse(await readFile(join(fixturesDir, `${stem}.canonical.json`), "utf8")) as {
          event: HookEventName;
        },
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

export async function replayCommandFixtures(build: PlaybackBuild, fixturesDir: string): Promise<void> {
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

export async function replayOpenCodeFixtures(build: PlaybackBuild, fixturesDir: string): Promise<void> {
  const pairs = await fixturePairs(fixturesDir);
  const previousTrace = process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
  process.env["HOOKNOSTIC_PLAYBACK_TRACE"] = build.tracePath;
  try {
    const imported = (await import(`${pathToFileURL(build.runtimePath).href}?playback=1`)) as {
      default: (input: {
        directory: string;
        worktree?: string;
      }) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>>;
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

/**
 * Replay pi fixture invocations through the generated production artifact.
 * pi's shim exports an extension factory, not a callback map: the factory is
 * driven through a recording ExtensionAPI double that routes each native
 * event to the subscription pi would have registered.
 */
export async function replayPiFixtures(build: PlaybackBuild, fixturesDir: string): Promise<void> {
  const pairs = await fixturePairs(fixturesDir);
  const previousTrace = process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
  process.env["HOOKNOSTIC_PLAYBACK_TRACE"] = build.tracePath;
  try {
    const imported = (await import(`${pathToFileURL(build.runtimePath).href}?playback=1`)) as {
      default: (pi: {
        on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => void;
      }) => void;
    };
    const subscriptions = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>();
    imported.default({
      on: (event, handler) => {
        const list = subscriptions.get(event) ?? [];
        list.push(handler);
        subscriptions.set(event, list);
      },
    });
    for (const fixture of pairs) {
      const native = fixture.input as {
        event: { type?: unknown };
        ctx: { cwd: string; mode?: string };
      };
      const type = native.event.type;
      expect(typeof type, `${fixture.name}: fixture has no event type`).toBe("string");
      const handlers = subscriptions.get(type as string);
      expect(handlers, `${fixture.name}: generated extension did not register ${type}`).toBeDefined();
      await handlers![0]!(native.event, { cwd: native.ctx.cwd, ...(native.ctx.mode ? { mode: native.ctx.mode } : {}) });
    }
  } finally {
    if (previousTrace === undefined) delete process.env["HOOKNOSTIC_PLAYBACK_TRACE"];
    else process.env["HOOKNOSTIC_PLAYBACK_TRACE"] = previousTrace;
  }
  expect((await readTrace(build.tracePath)).map((entry) => entry.event)).toEqual(
    pairs.map((fixture) => fixture.canonical.event),
  );
}

/**
 * The playback provider extension for pi: registers an openai-completions
 * provider pointing at the loopback model server, so the drive needs no
 * credentials and spends nothing. Same mechanism as .capture/pi's
 * provider-ollama.ts (verified live against 0.84.4).
 */
export async function writePiProviderExtension(
  artifactDir: string,
  baseUrl: string,
  options: { provider?: string; model?: string; apiKey?: string } = {},
): Promise<string> {
  const provider = options.provider ?? "hooknostic-playback";
  const model = options.model ?? "hooknostic-playback";
  const apiKey = options.apiKey ?? "playback";
  const path = join(artifactDir, "playback-provider.js");
  await writeFile(
    path,
    `export default function (pi) {
  pi.registerProvider(${JSON.stringify(provider)}, {
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: ${JSON.stringify(apiKey)},
    api: "openai-completions",
    models: [
      {
        id: ${JSON.stringify(model)},
        name: ${JSON.stringify(model)},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
}
`,
    "utf8",
  );
  return path;
}
