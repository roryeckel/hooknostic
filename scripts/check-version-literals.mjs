// Pins doc-prose version ranges to the adapter metadata. Any line in a
// tracked markdown file or example config that names a real adapter AND
// carries a semver-range literal must use that adapter's recommended range,
// a validated profile, or a complete union of complementary split profiles.
// The drift this catches is exactly the
// stale-range-in-docs failure that has already happened once.
//
// Deliberately scoped: patch-version literals (2.1.250 etc.) are provenance
// about past observations and never go stale, so they are not scanned; ranges
// are present-tense claims, so they are. Illustrative examples must use fake
// harness names (see AGENTS.md), which keeps this scan low-noise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function matchesDeclaredRanges(range, declared) {
  if (declared.has(range)) return true;
  if (semver.validRange(range) === null) return false;
  const clauses = [...declared].flatMap((value) => new semver.Range(value).set);
  // A capability threshold can partition one authored profile into <v and
  // >=v. Rejoin complementary clauses with identical remaining bounds;
  // neither a gap nor an arbitrary new boundary becomes declared coverage.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < clauses.length && !merged; i++) {
      for (let j = i + 1; j < clauses.length && !merged; j++) {
        const left = clauses[i].filter((a) => !clauses[j].some((b) => a.value === b.value));
        const right = clauses[j].filter((b) => !clauses[i].some((a) => a.value === b.value));
        if (left.length !== 1 || right.length !== 1) continue;
        const a = left[0],
          b = right[0];
        if (a.semver.version !== b.semver.version || a.semver.prerelease?.length !== 0) continue;
        if (
          ![
            [">=", "<"],
            ["<", ">="],
            [">", "<="],
            ["<=", ">"],
          ].some(([x, y]) => a.operator === x && b.operator === y)
        )
          continue;
        const common = clauses[i].filter((c) => c.value !== a.value);
        clauses.splice(j, 1);
        clauses.splice(i, 1, common);
        merged = true;
      }
    }
  }
  const contained = clauses
    .map((clause) => clause.map((c) => c.value).join(" ") || "*")
    .filter((candidate) => semver.subset(candidate, range));
  return contained.length > 0 && semver.subset(range, contained.join(" || "));
}

async function main() {
  const { defaultAdapterRegistry } = await import(new URL("../packages/cli/dist/index.js", import.meta.url).href);

  const registry = defaultAdapterRegistry();
  const allowed = new Map(
    Object.values(registry).map((adapter) => [
      adapter.id,
      new Set([
        adapter.harness.recommendedRange,
        ...(adapter.harnessFamilies ?? []).flatMap((harness) => {
          const selected = adapter.resolveTarget?.({
            id: adapter.id,
            version: harness.recommendedRange,
            delivery: "package",
            output: ".",
          }).adapter;
          return [
            harness.recommendedRange,
            ...(selected?.agentPluginProjector?.profiles ?? []).map((profile) => profile.range),
          ];
        }),
        ...adapter.supportedHarnessVersions(),
        // Projector profiles are validated ranges too, and they can be narrower
        // than the hook profile: Codex delivers plugin hooks only from 0.153,
        // while its wire fixtures are 0.148. An example exercising projection has
        // to name the narrower range, and that is accuracy rather than drift.
        ...(adapter.agentPluginProjector?.profiles ?? []).map((profile) => profile.range),
      ]),
    ]),
  );

  // Generated or deliberately version-dated files are exempt.
  const EXEMPT = [/^docs\/harness-support\.md$/, /^docs\/baseline-.*\.md$/];

  const files = execFileSync("git", ["ls-files", "*.md", "examples/*/hooknostic.config.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    // ls-files reports index entries, which include files deleted in the
    // working tree but not yet committed.
    .filter((file) => existsSync(resolve(ROOT, file)))
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
        if (!ids.some((id) => matchesDeclaredRanges(range, allowed.get(id)))) {
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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
