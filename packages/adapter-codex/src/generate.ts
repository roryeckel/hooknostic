import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import {
  assertNativeTimeoutFits,
  hooksByNativeEvent,
  nativeTimeoutSeconds,
} from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";

/**
 * Native events whose timeout codex-cli caps regardless of the configured
 * value. `SessionEnd` is clamped to SESSION_END_MAX_TIMEOUT_SEC = 3 in
 * codex-rs/hooks/src/events/session_end.rs (rust-v0.148.0); every other event
 * treats the configured value as a floor with no cap.
 */
export const CODEX_NATIVE_TIMEOUT_CEILING_SECONDS: Record<string, number | undefined> = {
  SessionEnd: 3,
};

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

/** Plugin-root-relative paths the native `.codex-plugin/plugin.json` points at. */
export const CODEX_PLUGIN_HOOKS_PATH = "hooks.json";
export const CODEX_PLUGIN_RUNTIME_PATH = "hooknostic/hooknostic.mjs";

/**
 * Generate Codex hook artifacts, in one of two shapes.
 *
 * - `local`: a `.codex/` directory copied to a repository root, whose command
 *   is relative to the session cwd — that root.
 * - `plugin`: `hooks.json` and the runtime at the plugin root, reached through
 *   the native `.codex-plugin/plugin.json` `hooks` key the projector writes.
 *
 * The commands differ because a relative one does NOT work inside a plugin: it
 * resolves against the session cwd rather than the install cache and silently
 * finds nothing. `${PLUGIN_ROOT}` is the only anchor observed to resolve there
 * (`.capture/codex-plugin-hooks`).
 *
 * Note: repo-level hooks only run for trusted projects, and Codex prompts
 * once per hook for hook trust — generation never touches trust state.
 */
function codexNativeTimeout(
  nativeEvent: string,
  reaching: Parameters<typeof nativeTimeoutSeconds>[0],
  runtime: Parameters<typeof nativeTimeoutSeconds>[1],
): number {
  const seconds = nativeTimeoutSeconds(reaching, runtime);
  assertNativeTimeoutFits(
    nativeEvent,
    seconds,
    CODEX_NATIVE_TIMEOUT_CEILING_SECONDS,
    "codex-cli",
  );
  return seconds;
}

export function generateCodexArtifacts(
  plugin: PluginIR,
  target: TargetSpec,
  bundle: RuntimeBundle,
  options: AdapterCompileOptions,
): GeneratedArtifact[] {
  const bundled = target.mode === "plugin";
  const hooksPath = bundled ? CODEX_PLUGIN_HOOKS_PATH : ".codex/hooks.json";
  const runtimePath = bundled ? CODEX_PLUGIN_RUNTIME_PATH : RUNTIME_PATH;
  const command = bundled
    ? `node \${PLUGIN_ROOT}/${runtimePath}`
    : `node ${runtimePath}`;

  const byNativeEvent = hooksByNativeEvent(
    plugin.hooks,
    target.id,
    (event) => CODEX_NATIVE_EVENT[event],
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
                command,
                timeout: codexNativeTimeout(nativeEvent, reaching, options.runtime),
              },
            ],
          },
        ],
      ]),
    ),
  };

  return [
    { path: hooksPath, contents: JSON.stringify(hooksJson, null, 2) + "\n" },
    { path: runtimePath, contents: bundle.code },
  ];
}
