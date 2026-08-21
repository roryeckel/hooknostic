import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import { hookAppliesToTarget } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";

export const CODEX_NATIVE_EVENT: Partial<Record<HookEventName, string>> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.before": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "permission.request": "PermissionRequest",
  "context.compact.before": "PreCompact",
  "context.compact.after": "PostCompact",
  "agent.start": "SubagentStart",
  "agent.stop": "SubagentStop",
  "turn.stop": "Stop",
  // tool.error has no Codex equivalent; capability analysis rejects it first.
};

const RUNTIME_PATH = ".codex/hooknostic/hooknostic.mjs";

/**
 * Generate the Codex repo-level artifact ("local" mode): a `.codex/`
 * directory that is copied into the target repository root. Plugin-bundled
 * hooks (`mode: "plugin"`) are not generated because the `plugin_hooks`
 * feature is removed in the validated 0.148 range.
 *
 * Note: repo-level hooks only run for trusted projects, and Codex prompts
 * once per hook for hook trust — generation never touches trust state.
 */
export function generateCodexArtifacts(
  plugin: PluginIR,
  target: TargetSpec,
  bundle: RuntimeBundle,
  options: AdapterCompileOptions,
): GeneratedArtifact[] {
  if (target.mode === "plugin") {
    throw new Error(
      `codex target mode "plugin" is unavailable for the validated range (${target.version}): ` +
        `the plugin_hooks feature is removed in codex-cli 0.148; use mode: "local" (repo .codex directory).`,
    );
  }

  const nativeTimeoutSeconds = Math.ceil(options.runtime.timeoutMs / 1000) + 1;

  const nativeEvents = [
    ...new Set(
      plugin.hooks
        .filter((hook) => hookAppliesToTarget(hook, target.id))
        .map((hook) => CODEX_NATIVE_EVENT[hook.event])
        .filter((name): name is string => name !== undefined),
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
                // Relative to the session cwd (the trusted project root the
                // .codex directory is copied into).
                command: `node ${RUNTIME_PATH}`,
                timeout: nativeTimeoutSeconds,
              },
            ],
          },
        ],
      ]),
    ),
  };

  return [
    { path: ".codex/hooks.json", contents: JSON.stringify(hooksJson, null, 2) + "\n" },
    { path: RUNTIME_PATH, contents: bundle.code },
  ];
}
