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

/**
 * Generate the Codex repo-level artifact ("local" mode): a `.codex/`
 * directory that is copied into the target repository root.
 *
 * Plugin-bundled hooks are unimplemented, not impossible: an installed plugin's
 * hook does run on 0.153.2, but only from a native `.codex-plugin/plugin.json`
 * `hooks` key, which a portable Agent Plugins manifest displaces
 * (`.capture/codex-plugin-hooks`). Emitting one would forfeit the portable
 * manifest, so it is a separate artifact shape rather than a flag.
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
  if (target.mode === "plugin") {
    throw new Error(
      `codex target mode "plugin" is not implemented for the validated range (${target.version}): ` +
        `Codex loads plugin hooks only from a native .codex-plugin/plugin.json, which a portable ` +
        `Agent Plugins manifest displaces; use mode: "local" (repo .codex directory).`,
    );
  }

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
                // Relative to the session cwd (the trusted project root the
                // .codex directory is copied into).
                command: `node ${RUNTIME_PATH}`,
                timeout: codexNativeTimeout(nativeEvent, reaching, options.runtime),
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
