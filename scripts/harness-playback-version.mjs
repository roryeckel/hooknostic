const harnesses = {
  claude: {
    module: "../packages/adapter-claude/src/harness.ts",
    exportName: "claudeHarness",
  },
  codex: {
    module: "../packages/adapter-codex/src/harness.ts",
    exportName: "codexHarness",
  },
  opencode: {
    module: "../packages/adapter-opencode/src/harness.ts",
    exportName: "opencodeHarness",
  },
};

const id = process.argv[2];
const entry = harnesses[id];
if (entry === undefined) {
  process.stderr.write(
    `usage: node --experimental-strip-types ${process.argv[1]} <${Object.keys(harnesses).join("|")}>\n`,
  );
  process.exit(2);
}

const imported = await import(new URL(entry.module, import.meta.url));
const metadata = imported[entry.exportName];
if (metadata === undefined || typeof metadata.referenceVersion !== "string") {
  throw new Error(`${id}: harness metadata has no referenceVersion`);
}
process.stdout.write(`${metadata.referenceVersion}\n`);
