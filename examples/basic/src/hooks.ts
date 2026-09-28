import { block, definePlugin, hook } from "@hooknostic/sdk";

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
      capabilities: { block: "required" },
      run({ tool }) {
        // Undefined only where the tool's shape is uncaptured: a guard refuses
        // what it cannot read rather than letting it through unchecked.
        const command = tool.shell?.command;
        if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
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
