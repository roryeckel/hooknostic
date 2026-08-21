import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import { hookAppliesToTarget } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";

export const CLAUDE_NATIVE_EVENT: Record<HookEventName, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.before": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "tool.error": "PostToolUseFailure",
  "permission.request": "PermissionRequest",
  "context.compact.before": "PreCompact",
  "context.compact.after": "PostCompact",
  "agent.start": "SubagentStart",
  "agent.stop": "SubagentStop",
  "turn.stop": "Stop",
};

const RUNTIME_PATH = "runtime/hooknostic.mjs";

/**
 * Generate the self-contained Claude Code plugin artifact:
 * one native command-hook entry (exec form, no shell) per lifecycle event the
 * plugin uses; all matcher/handler composition happens inside the bundled
 * dispatcher (ADR-0003).
 */
export function generateClaudeArtifacts(
  plugin: PluginIR,
  target: TargetSpec,
  bundle: RuntimeBundle,
  options: AdapterCompileOptions,
): GeneratedArtifact[] {
  const nativeTimeoutSeconds = Math.ceil(options.runtime.timeoutMs / 1000) + 1;
  const nativeEvents = [
    ...new Set(
      plugin.hooks
        .filter((hook) => hookAppliesToTarget(hook, target.id))
        .map((hook) => CLAUDE_NATIVE_EVENT[hook.event]),
    ),
  ];

  const hooksJson = {
    description: plugin.description ?? `Hooknostic-generated hooks for ${plugin.name}`,
    hooks: Object.fromEntries(
      nativeEvents.map((nativeEvent) => [
        nativeEvent,
        [
          {
            hooks: [
              {
                type: "command",
                command: "node",
                args: [`\${CLAUDE_PLUGIN_ROOT}/${RUNTIME_PATH}`],
                timeout: nativeTimeoutSeconds,
              },
            ],
          },
        ],
      ]),
    ),
  };

  const pluginJson = {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
  };

  return [
    { path: ".claude-plugin/plugin.json", contents: JSON.stringify(pluginJson, null, 2) + "\n" },
    { path: "hooks/hooks.json", contents: JSON.stringify(hooksJson, null, 2) + "\n" },
    { path: RUNTIME_PATH, contents: bundle.code },
  ];
}
