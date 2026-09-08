import type { AdapterCompileOptions, GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";
import {
  assertNativeTimeoutFits,
  hooksByNativeEvent,
  nativeTimeoutSeconds,
  rangeWithin,
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
export const CODEX_PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";
/** Versions where an installed plugin is known to run its hooks. */
export const CODEX_PLUGIN_MODE_RANGE = ">=0.153 <1";

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
  // Plugin hook delivery is established on 0.153.2 only. It was read as REMOVED
  // from the 0.148.0 binary, and that reading is not re-testable
  // (.capture/codex-plugin-hooks), so the versions between are a channel nobody
  // has watched work -- declined rather than guessed.
  if (bundled && !rangeWithin(target.version, CODEX_PLUGIN_MODE_RANGE)) {
    throw new Error(
      `codex target mode "plugin" requires harness ${CODEX_PLUGIN_MODE_RANGE}; hook delivery from an installed plugin is only established on 0.153.2, and the 0.148.0 binary was read as having removed it.`,
    );
  }
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

  const manifest = {
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    hooks: `./${CODEX_PLUGIN_HOOKS_PATH}`,
  };

  return [
    // Without a manifest the tree is not a plugin: `codex plugin add` cannot
    // discover it, and the ${PLUGIN_ROOT} the hook command needs only resolves
    // inside an installed one. A projected target replaces this with a fuller
    // manifest that also carries the package's skills and MCP servers.
    ...(bundled
      ? [
          {
            path: CODEX_PLUGIN_MANIFEST_PATH,
            contents: JSON.stringify(manifest, null, 2) + "\n",
          },
        ]
      : []),
    { path: hooksPath, contents: JSON.stringify(hooksJson, null, 2) + "\n" },
    { path: runtimePath, contents: bundle.code },
  ];
}
