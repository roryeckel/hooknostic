import { definePlugin, hook, block, replaceInput } from "@hooknostic/sdk";

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
        const input = event.tool.input as Record<string, unknown>;
        // Portable read. The write-back below still needs the harness's own key.
        const command = event.tool.shell?.command ?? "";

        if (command.includes("rm -rf /")) {
          return block("Refusing destructive root deletion");
        }

        if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
          return replaceInput({ ...input, ["cmd" in input ? "cmd" : "command"]: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});
