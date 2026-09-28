import { addContext, definePlugin, hook } from "@hooknostic/sdk";

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
      capabilities: { "context.add": "required" },
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
      capabilities: { "context.add": "optional" },
      run({ tool }, ctx) {
        if (!ctx.capabilities.has("context.add")) return;
        // Advice, not a guard: where the shape is uncaptured there is nothing
        // to advise on, so this hook simply stays quiet (fails open).
        if (tool.shell?.command.startsWith("cd ")) {
          return addContext("Reminder: prefer absolute paths over cd for tooling commands.");
        }
      },
    }),
  ],
});
