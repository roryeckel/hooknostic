import { AGENT_PLUGIN_MANIFEST_SCHEMA } from "@hooknostic/agent-plugin";
import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import { hooksByNativeEvent, nativeTimeoutSeconds } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";

/**
 * Canonical event → the camelCase native event a hook entry is registered for.
 *
 * Total on purpose: a new SDK event cannot be forgotten here without a type
 * error. `model.request.before` has no Copilot hook between prompt assembly and
 * the model request, and capability analysis rejects a hook on it first
 * (HN202); `context.compact.after` has no native event at all.
 */
export const COPILOT_NATIVE_EVENT: Record<HookEventName, string | undefined> = {
  "session.start": "sessionStart",
  "session.end": "sessionEnd",
  "prompt.before": "userPromptSubmitted",
  "tool.before": "preToolUse",
  "tool.after": "postToolUse",
  "tool.error": "postToolUseFailure",
  "permission.request": "permissionRequest",
  "context.compact.before": "preCompact",
  "context.compact.after": undefined,
  "agent.start": "subagentStart",
  "agent.stop": "subagentStop",
  "turn.stop": "agentStop",
  "model.request.before": undefined,
};

const RUNTIME_PATH = "runtime/hooknostic.mjs";
const PROJECT_HOOKS_PATH = "hooks/hooknostic.json";
const PACKAGE_HOOKS_PATH = "com.github.copilot/hooks/hooks.json";

/** Where `compile()` writes the hook runtime, on both deliveries. */
export function copilotHookRuntimePath(): string {
  return RUNTIME_PATH;
}

/** The generated hook document's path in this delivery's output. */
export function copilotHooksPath(delivery: TargetSpec["delivery"]): string {
  return delivery === "package" ? PACKAGE_HOOKS_PATH : PROJECT_HOOKS_PATH;
}

/**
 * Generate the Copilot CLI hook artifact. One native command-hook entry per
 * lifecycle event, started with `exec`/`args` rather than a shell string so no
 * path is ever interpolated into a shell. The event's camelCase name is passed
 * as the first argument because those payloads do not name their own event;
 * the shim uses it to decode and never copies it into `raw`.
 *
 * No native `matcher` is emitted: its regex applies to the runtime tool name,
 * and a hook that matches an MCP tool by its runtime name has no fixed name to
 * enumerate. The dispatcher is started for every tool call and filters there,
 * which is correct for a tool vocabulary the adapter cannot fully name.
 */
export function generateCopilotArtifacts(
  plugin: PluginIR,
  target: TargetSpec,
  bundle: RuntimeBundle,
  options: AdapterCompileOptions,
): GeneratedArtifact[] {
  const byNativeEvent = hooksByNativeEvent(plugin.hooks, target.id, (event) => COPILOT_NATIVE_EVENT[event]);
  const runtimeArg = target.delivery === "package" ? `\${PLUGIN_ROOT}/${RUNTIME_PATH}` : RUNTIME_PATH;

  const hooks = Object.fromEntries(
    [...byNativeEvent].map(([nativeEvent, reaching]) => [
      nativeEvent,
      [
        {
          type: "command",
          exec: "node",
          args: [runtimeArg, nativeEvent],
          timeoutSec: nativeTimeoutSeconds(reaching, options.runtime),
        },
      ],
    ]),
  );
  const hooksJson = { version: 1, hooks };

  const artifacts: GeneratedArtifact[] = [
    { path: copilotHooksPath(target.delivery), contents: `${JSON.stringify(hooksJson, null, 2)}\n` },
    { path: RUNTIME_PATH, contents: bundle.code },
  ];
  if (target.delivery === "package") {
    artifacts.unshift({
      path: "plugin.json",
      contents: `${JSON.stringify(
        {
          $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
          name: plugin.name,
          ...(plugin.version !== undefined ? { version: plugin.version } : {}),
          ...(plugin.description !== undefined ? { description: plugin.description } : {}),
        },
        null,
        2,
      )}\n`,
    });
  }
  return artifacts;
}
