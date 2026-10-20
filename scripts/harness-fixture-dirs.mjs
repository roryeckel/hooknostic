// Each drift-checked harness's reference fixture directory, read from its
// adapter's harness metadata, the one home for harness version facts
// (ADR-0008). The metadata modules are TypeScript with type-only imports, so
// importing them needs Node's type stripping (default on the supported Node
// lines; `--experimental-strip-types` before them).

/** [fixture directory under fixtures/, metadata module under packages/, export] */
const SOURCES = {
  pi: ["pi", "adapter-pi/src/harness.ts", "piHarness"],
  claude: ["claude", "adapter-claude/src/harness.ts", "claudeHarness"],
  codex: ["codex", "adapter-codex/src/harness.ts", "codexHarness"],
  opencode: ["opencode", "adapter-opencode/src/harness.ts", "opencodeHarness"],
  "opencode-v1": ["opencode", "adapter-opencode/src/harness.ts", "opencodeHarness"],
  "opencode-v2": ["opencode", "adapter-opencode/src/v2/harness.ts", "opencodeV2Harness"],
};

/** `fixtures/<harness>/<fixtureDir>` for each harness, relative to the repository root. */
export async function harnessFixtureDirs() {
  const packages = new URL("../packages/", import.meta.url);
  const entries = await Promise.all(
    Object.entries(SOURCES).map(async ([harness, [dir, module, name]]) => {
      const metadata = (await import(new URL(module, packages).href))[name];
      return [harness, `fixtures/${dir}/${metadata.fixtureDir}`];
    }),
  );
  return Object.fromEntries(entries);
}
