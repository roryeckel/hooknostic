import { block, definePlugin, hook } from "@hooknostic/sdk";
export default definePlugin({
  name: "sample-project",
  hooks: [
    hook("tool.before", {
      id: "sample-guard",
      match: { kind: "shell" },
      capabilities: { block: "required" },
      run({ tool }) {
        if (tool.shell?.command.includes("sample-forbidden-command")) return block("Synthetic example guard.");
      },
    }),
  ],
});
