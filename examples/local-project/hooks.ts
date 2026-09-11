import { block, definePlugin, hook } from "@hooknostic/sdk";
export default definePlugin({ name: "sample-project", hooks: [
  hook("tool.before", {
    id: "sample-guard", match: { kind: "shell" },
    capabilities: { "tool.before.block": "required" },
    async run(event) {
      if (event.tool.shell?.command.includes("sample-forbidden-command")) return block("Synthetic example guard.");
    },
  }),
] });
