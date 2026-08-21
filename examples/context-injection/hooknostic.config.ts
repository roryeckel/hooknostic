import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    // session.start.context.add is exact on claude/codex; opencode has no
    // session-start context channel, so this config intentionally narrows
    // the target set instead of degrading.
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
    codex: { version: ">=0.148 <1", mode: "local", output: "./dist/codex" },
  },
});
