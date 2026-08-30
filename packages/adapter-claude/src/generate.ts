import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import {
  assertNativeTimeoutFits,
  hooksByNativeEvent,
  nativeTimeoutSeconds,
} from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";

/**
 * Native events whose timeout the harness caps regardless of what we ask for.
 *
 * Claude: "SessionEnd hooks of any type share a 1.5-second budget. If your
 * settings set a longer per-hook timeout, Claude Code raises the budget to
 * match, up to 60 seconds." (hooks guide, Limitations.)
 */
export const CLAUDE_NATIVE_TIMEOUT_CEILING_SECONDS: Record<string, number | undefined> = {
  SessionEnd: 60,
};

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
function claudeNativeTimeout(
  nativeEvent: string,
  reaching: Parameters<typeof nativeTimeoutSeconds>[0],
  runtime: Parameters<typeof nativeTimeoutSeconds>[1],
): number {
  const seconds = nativeTimeoutSeconds(reaching, runtime);
  assertNativeTimeoutFits(
    nativeEvent,
    seconds,
    CLAUDE_NATIVE_TIMEOUT_CEILING_SECONDS,
    "Claude Code",
  );
  return seconds;
}

export function generateClaudeArtifacts(
  plugin: PluginIR,
  target: TargetSpec,
  bundle: RuntimeBundle,
  options: AdapterCompileOptions,
): GeneratedArtifact[] {
  const byNativeEvent = hooksByNativeEvent(
    plugin.hooks,
    target.id,
    (event) => CLAUDE_NATIVE_EVENT[event],
  );

  const hooksJson = {
    description: plugin.description ?? `Hooknostic-generated hooks for ${plugin.name}`,
    hooks: Object.fromEntries(
      [...byNativeEvent].map(([nativeEvent, reaching]) => [
        nativeEvent,
        [
          {
            hooks: [
              {
                type: "command",
                command: "node",
                args: [`\${CLAUDE_PLUGIN_ROOT}/${RUNTIME_PATH}`],
                timeout: claudeNativeTimeout(nativeEvent, reaching, options.runtime),
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
