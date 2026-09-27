import { block, definePlugin, hook } from "@hooknostic/sdk";

export default definePlugin({
  // name is required here; version/description are inherited from the Agent
  // Plugins manifest when omitted.
  name: "combined-example",
  hooks: [
    hook("tool.before", {
      id: "marketplace-probe",
      match: { kind: "shell" },
      capabilities: { "tool.before.block": "required" },
      run(event) {
        if (event.tool.shell?.command.includes("HOOKNOSTIC_BLOCK_PROBE")) {
          return block("Hooknostic marketplace probe blocked.");
        }
      },
    }),
    hook("tool.before", {
      id: "protect-env-files",
      match: { kind: "file.read" },
      capabilities: { "tool.before.block": "required" },
      async run(event) {
        const { file_path: filePath = "" } = event.tool.input as { file_path?: string };
        if (/\.env(\.|$)/.test(filePath)) {
          return block("Reading .env files is not allowed by this plugin.");
        }
      },
    }),
  ],
});
