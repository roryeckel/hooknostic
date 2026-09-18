import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  targets: {
    claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
    codex: { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
    opencode: { version: ">=1.18 <2", delivery: "package", output: "./dist/opencode" },
  },
  components: {
    root: ".",
    targets: ["claude", "codex", "opencode"],
    runtime: [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "runtime/requirements.txt", into: "runtime/pypi" },
    ],
  },
});
