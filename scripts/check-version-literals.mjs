// Pins doc-prose version ranges to the adapter metadata. Any line in a
// tracked markdown file or example config that names a real adapter AND
// carries a semver-range literal must use that adapter's recommended range or
// one of its validated profile ranges -- the drift this catches is exactly the
// stale-range-in-docs failure that has already happened once.
//
// Deliberately scoped: patch-version literals (2.1.250 etc.) are provenance
// about past observations and never go stale, so they are not scanned; ranges
// are present-tense claims, so they are. Illustrative examples must use fake
// harness names (see AGENTS.md), which keeps this scan low-noise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { defaultAdapterRegistry } = await import(
  new URL("../packages/cli/dist/index.js", import.meta.url).href
);

const registry = defaultAdapterRegistry();
const allowed = new Map(
  Object.values(registry).map((adapter) => [
    adapter.id,
    new Set([adapter.harness.recommendedRange, ...adapter.supportedHarnessVersions()]),
  ]),
);

// Generated or deliberately version-dated files are exempt.
const EXEMPT = [
  /^docs\/harness-support\.md$/,
  /^docs\/baseline-.*\.md$/,
];

const files = execFileSync("git", ["ls-files", "*.md", "examples/*/hooknostic.config.ts"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((file) => !EXEMPT.some((pattern) => pattern.test(file)));

const RANGE = /"(>=[^"]+)"|`(>=[^`]+)`/g;
const failures = [];
for (const file of files) {
  const lines = readFileSync(resolve(ROOT, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    const ids = [...allowed.keys()].filter((id) => line.toLowerCase().includes(id));
    if (ids.length === 0) return;
    for (const match of line.matchAll(RANGE)) {
      const range = match[1] ?? match[2];
      if (!ids.some((id) => allowed.get(id).has(range))) {
        failures.push(
          `${file}:${index + 1}: range "${range}" does not match any current ` +
            `range for ${ids.join("/")} (recommended or validated); update it or ` +
            `switch the example to a fake harness name`,
        );
      }
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`version-literal check: ${files.length} files clean`);
