import { defineConfig } from "@hooknostic/sdk";
export default defineConfig({
  project: { root: "." },
  entry: "./hooks.ts",
  components: { skills: ["./skills"], mcp: "./mcp.json", agents: ["./agents"] },
  targets: {
    claude: { version: ">=2.1 <3", delivery: "project", output: ".hooknostic/artifacts/claude" },
    codex: { version: ">=0.148 <1", delivery: "project", output: ".hooknostic/artifacts/codex" },
    opencode: { version: ">=1.18 <2", delivery: "project", output: ".hooknostic/artifacts/opencode" },
  },
});
