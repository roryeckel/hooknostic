import { definePlugin, hook, addContext } from "@hooknostic/sdk";

/**
 * Context injection at two lifecycle points: session start (repo context)
 * and before every shell tool call (a working-directory reminder).
 */
export default definePlugin({
  name: "context-injection",
  version: "0.1.0",
  description: "Inject repository context into the model's view",
  hooks: [
    hook("session.start", {
      id: "repo-context",
      capabilities: { "session.start.context.add": "required" },
      async run(event) {
        return addContext(
          [
            `Working directory: ${event.session.cwd}`,
            "House rules: pnpm (not npm), conventional commits, tests before push.",
          ].join("\n"),
        );
      },
    }),

    hook("tool.before", {
      id: "cwd-reminder",
      match: { kind: "shell" },
      capabilities: { "tool.before.context.add": "optional" },
      async run(event, ctx) {
        if (!ctx.capabilities.has("tool.before.context.add")) return;
        // Normalized read with a raw fallback: where the shape is uncaptured
        // (`shell` undefined), a guard must not fail open on an empty string.
        const raw = (event.tool.input as { command?: unknown }).command;
        const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
        if (command.startsWith("cd ")) {
          return addContext("Reminder: prefer absolute paths over cd for tooling commands.");
        }
      },
    }),
  ],
});
