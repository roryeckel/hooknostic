import { definePlugin, hook, block, updateShell } from "@hooknostic/sdk";

/**
 * The design document's Appendix A example: block destructive shell commands
 * everywhere; rewrite npm → pnpm where the target supports input rewriting
 * (feature-detected at runtime, so targets without the optional capability
 * still get the guard).
 */
export default definePlugin({
  name: "rewrite-shell",
  version: "0.1.0",
  description: "Protect and normalize shell commands",
  hooks: [
    hook("tool.before", {
      id: "protect-and-normalize-shell",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const command = event.tool.shell?.command ?? "";

        if (command.includes("rm -rf /")) {
          return block("Refusing destructive root deletion");
        }

        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          event.tool.shell !== undefined &&
          command.startsWith("npm ")
        ) {
          // Portable write-back: the rewrite lands under whichever key this
          // harness uses (`command` on Claude/OpenCode, `cmd` on Codex's
          // exec_command), with every sibling input field preserved.
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});
