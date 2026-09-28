import { block, definePlugin, hook } from "@hooknostic/sdk";

const isEnvFile = (path: string) => /(^|[\\/])\.env(\.|$)/.test(path);

export default definePlugin({
  // name is required here; version/description are inherited from the Agent
  // Plugins manifest when omitted.
  name: "combined-example",
  hooks: [
    hook("tool.before", {
      id: "marketplace-probe",
      match: { kind: "shell" },
      capabilities: { block: "required" },
      run({ tool }) {
        if (tool.shell?.command.includes("HOOKNOSTIC_BLOCK_PROBE")) {
          return block("Hooknostic marketplace probe blocked.");
        }
      },
    }),
    hook("tool.before", {
      id: "protect-env-files",
      // Reads, and edits too: on Codex and on GPT-like models under OpenCode a
      // file is changed through a patch, which tool.file reads paths out of.
      match: { kind: ["file.read", "file.write", "file.edit"] },
      capabilities: { block: "required" },
      run({ tool }) {
        // tool.file names every targeted file, whatever each harness calls the
        // argument; it is absent for search tools (glob/grep), which take a
        // pattern rather than a file. A shell command that reads .env is a
        // shell call and out of this hook's reach.
        if (tool.file?.paths.some(isEnvFile)) {
          return block(".env files are off limits to this plugin.");
        }
      },
    }),
  ],
});
