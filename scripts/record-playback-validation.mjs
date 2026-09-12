// Rewrite the rolling scheduled-playback validation record in an adapter
// profile (harness-watch workflow, issue #1). One mutable record per adapter,
// delimited by the scheduled-playback markers; everything else in the profile
// is untouched. Policy: ADR-0009; the workflow contract is
// docs/harness-watch.md.
//
//   node --experimental-strip-types scripts/record-playback-validation.mjs \
//     <claude|codex|opencode> <version> [--date YYYY-MM-DD]
//
// Exit codes:
//   0  success (record written, or same-version no-op)
//   2  bad usage / bad semver
//   3  version outside every profile range (range extension needs real
//      captured evidence via the harness-capture skill -- the workflow files
//      a deduped issue instead of recording)
//   4  version does not advance the playback baseline (already recorded,
//      older, or redundant with referenceVersion)
//   1  structural (markers missing/duplicated, harness unknown)
//
// Guards intentionally baseline on max(referenceVersion, rolling record)
// ONLY: other validatedOn records (a router-log, a scoped live-probe) never
// raise the baseline, or one narrow probe would permanently suppress full
// scheduled playback of that build. referenceVersion is always included so a
// pinned in-range OLDER build with an empty marker region is a no-op (exit 4)
// rather than a redundant record.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const adapters = {
  claude: {
    profileModule: "../packages/adapter-claude/src/profile.ts",
    profileExport: "claudeCapabilityProfiles",
    profilePath: "packages/adapter-claude/src/profile.ts",
  },
  codex: {
    profileModule: "../packages/adapter-codex/src/profile.ts",
    profileExport: "codexCapabilityProfiles",
    profilePath: "packages/adapter-codex/src/profile.ts",
  },
  opencode: {
    profileModule: "../packages/adapter-opencode/src/profile.ts",
    profileExport: "opencodeCapabilityProfiles",
    profilePath: "packages/adapter-opencode/src/profile.ts",
  },
};

export const ROLLING_WHAT =
  "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified";

const BEGIN = "// scheduled-playback:begin";
const END = "// scheduled-playback:end";

const RECORD_TEMPLATE = (version, date) =>
  [
    "        {",
    `          version: "${version}",`,
    `          date: "${date}",`,
    '          method: "live-probe",',
    '          artifact: ".capture/harness-playback",',
    "          what:",
    `            "${ROLLING_WHAT}",`,
    "        },",
  ].join("\n");

/**
 * Rewrite (or insert) the rolling record between the markers. Pure function
 * over the source string; throws on missing or duplicated markers. Byte
 * identical outside the marker region. The region between the markers holds
 * only the record; policy comments live above the begin marker so a rewrite
 * can replace the region wholesale.
 */
export function rewriteRollingRecord(source, { version, date }) {
  const beginCount = source.split(BEGIN).length - 1;
  const endCount = source.split(END).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`expected exactly one ${BEGIN} and one ${END} pair, found ${beginCount}/${endCount}`);
  }
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  if (endIdx < beginIdx) throw new Error("scheduled-playback:end precedes begin");

  const before = source.slice(0, beginIdx + BEGIN.length);
  const after = source.slice(endIdx);
  // Preserve the newline style of the file.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const record = RECORD_TEMPLATE(version, date).replace(/\n/g, eol);
  // Layout: "...begin<eol>record<eol>        // scheduled-playback:end..." —
  // the 8-space indent before the end marker is supplied here.
  return `${before}${eol}${record}${eol}        ${after}`;
}

function parseArgs(argv) {
  const positional = [];
  let date;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--date") {
      date = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, date };
}

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main() {
  const { positional, date: dateArg } = parseArgs(process.argv.slice(2));
  const [harness, version] = positional;
  const entry = adapters[harness];
  if (entry === undefined || version === undefined) {
    fail(
      `usage: node --experimental-strip-types scripts/record-playback-validation.mjs <${Object.keys(adapters).join("|")}> <version> [--date YYYY-MM-DD]`,
      2,
    );
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`not a semver: ${version}`, 2);
  }
  const date = dateArg ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(`not an ISO date: ${date}`, 2);
  }

  // strip-types import of the unbuilt TS profile (same pattern as
  // harness-playback-version.mjs).
  const imported = await import(new URL(entry.profileModule, import.meta.url));
  const profiles = imported[entry.profileExport];
  if (!Array.isArray(profiles) || profiles.length === 0) {
    fail(`${harness}: profile module has no profiles`, 1);
  }

  // Guard 1: version must satisfy at least one profile range.
  const semver = await import("semver");
  const inRange = profiles.some((p) => semver.satisfies(version, p.range));
  if (!inRange) {
    fail(
      `${version} is outside every ${harness} profile range (${profiles.map((p) => p.range).join(", ")}) -- range extension needs real captured evidence via the harness-capture skill; file an issue, do not record`,
      3,
    );
  }

  // Guard 2: baseline = max(referenceVersion, rolling record), nothing else.
  const harnessModule = await import(new URL(entry.profileModule.replace("profile.ts", "harness.ts"), import.meta.url));
  const harnessExport = Object.values(harnessModule).find(
    (v) => v !== null && typeof v === "object" && "referenceVersion" in v,
  );
  if (harnessExport === undefined) {
    fail(`${harness}: harness metadata not found`, 1);
  }
  const referenceVersion = harnessExport.referenceVersion;

  const source = readFileSync(resolve(ROOT, entry.profilePath), "utf8");
  const existing = extractRollingRecord(source);
  let baseline = referenceVersion;
  if (existing !== undefined && semver.gt(existing.version, baseline)) {
    baseline = existing.version;
  }

  // Same-version no-op (idempotent rerun). Machine-readable outcome line:
  // the harness-watch record job greps `outcome=noop` to skip the commit
  // leg cleanly instead of failing on an empty index.
  if (existing !== undefined && existing.version === version) {
    process.stdout.write(`${harness}: rolling record already at ${version} -- no-op\noutcome=noop\n`);
    process.exit(0);
  }
  // Strictly advancing guard: equal-to-reference with empty region is a
  // redundant record; lower is backwards.
  if (semver.gte(baseline, version)) {
    fail(
      `${version} does not advance the playback baseline (reference ${referenceVersion}, rolling ${existing?.version ?? "none"}); nothing to record`,
      4,
    );
  }

  const next = rewriteRollingRecord(source, { version, date });
  if (next === source) {
    fail(`${harness}: rewrite produced no change`, 1);
  }
  writeFileSync(resolve(ROOT, entry.profilePath), next, "utf8");
  process.stdout.write(
    `WROTE ${harness} rolling record -> ${version} (${date})\noutcome=wrote\n` +
      `next: pnpm build && node scripts/generate-harness-support.mjs && pnpm lint && pnpm test\n`,
  );
}

// ESM top-level await, guarded so the pure helpers stay importable from the
// test (same CLI guard as release-notes.mjs).
export function isMainModule(moduleUrl, argv1) {
  return argv1 !== undefined && fileURLToPath(moduleUrl) === resolve(argv1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main();
}

/** Pull the version/date out of the marker region, if a record is present. */
function extractRollingRecord(source) {
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) return undefined;
  const between = source.slice(beginIdx, endIdx);
  const version = between.match(/version: "([^"]+)"/)?.[1];
  if (version === undefined) return undefined;
  const date = between.match(/date: "([^"]+)"/)?.[1] ?? "";
  return { version, date };
}
