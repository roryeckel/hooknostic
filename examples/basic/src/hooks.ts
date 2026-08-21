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
        const { command = "" } = event.tool.input as { command?: string };
        if (/git\s+push\s+.*--force(?!-with-lease)/.test(command)) {
          return block("Use --force-with-lease instead of --force.");
        }
      },
    }),

    hook("session.end", {
      id: "observe-session-end",
      async run(event) {
        // Observation only: no effect means continue.
        void event.reason;
      },
    }),
  ],
});
