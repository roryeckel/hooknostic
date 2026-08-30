import { definePlugin, hook, block } from "@hooknostic/sdk";

/**
 * Minimal portable plugin: one guard on shell tools, one session observer.
 * `hooknostic check` resolves both hooks against every configured target
 * before any artifact exists.
 */
export default definePlugin({
  name: "basic-example",
  version: "0.1.0",
  description: "Minimal hooknostic example",
  hooks: [
    hook("tool.before", {
      id: "no-force-push",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
      },
      async run(event) {
        // Normalized read with a raw fallback: where the shape is uncaptured
        // (`shell` undefined), a guard must not fail open on an empty string.
        const raw = (event.tool.input as { command?: unknown }).command;
        const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
        if (/git\s+push\s+.*--force(?!-with-lease)/.test(command)) {
          return block("Use --force-with-lease instead of --force.");
        }
      },
    }),

    hook("session.end", {
      id: "observe-session-end",
      // Session teardown is capped by the harness itself -- codex-cli clamps
      // SessionEnd to 3 seconds and Claude Code to 60 -- so this budget is
      // sized to fit the tightest of them. Without it the build fails rather
      // than emitting a manifest asking for time the harness will not grant.
      timeoutMs: 2_000,
      async run(event) {
        // Observation only: no effect means continue.
        void event.reason;
      },
    }),
  ],
});
