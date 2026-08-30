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
        const command = event.tool.shell?.command ?? "";
        if (command.startsWith("cd ")) {
          return addContext("Reminder: prefer absolute paths over cd for tooling commands.");
        }
      },
    }),
  ],
});
