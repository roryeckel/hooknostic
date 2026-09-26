/** Installation and evidence locations for independently maintained playback lanes. */
export const harnessLanes = {
  claude: {
    pkg: "@anthropic-ai/claude-code",
    bootstrap: "install.cjs",
    module: "../packages/adapter-claude/src/profile.ts",
    profileExport: "claudeCapabilityProfiles",
    harnessExport: "claudeHarness",
  },
  codex: {
    pkg: "@openai/codex",
    module: "../packages/adapter-codex/src/profile.ts",
    profileExport: "codexCapabilityProfiles",
    harnessExport: "codexHarness",
  },
  "opencode-v1": {
    pkg: "opencode-ai",
    bootstrap: "postinstall.mjs",
    module: "../packages/adapter-opencode/src/profile.ts",
    profileExport: "opencodeCapabilityProfiles",
    harnessExport: "opencodeHarness",
  },
  "opencode-v2": {
    pkg: "@opencode/cli",
    bootstrap: "postinstall.mjs",
    module: "../packages/adapter-opencode/src/v2/profile.ts",
    profileExport: "opencodeV2CapabilityProfiles",
    harnessExport: "opencodeV2Harness",
  },
};

/** Preserve the old explicit automation selector as a v1 alias. */
export const harnessLaneId = (id) => (id === "opencode" ? "opencode-v1" : id);
