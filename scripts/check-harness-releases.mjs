// Harness release detection for the harness-watch workflow (issue #1).
// Compares each harness package's npm dist-tag `latest` against the playback
// baseline -- max(referenceVersion, rolling scheduled-playback record) -- and
// classifies the jump. The rolling record is identified by its `what` marker
// string (ADR-0009); unrelated narrow records (router-log, scoped live-probe)
// deliberately never raise the baseline: one narrow probe must not suppress a
// full scheduled playback run.
//
//   node --experimental-strip-types scripts/check-harness-releases.mjs \
//     [<harness>] [--version <v>] [--force] [--matrix]
//
// --matrix emits a GitHub Actions matrix.include array (dispatch wiring):
// entries with newerAvailable are included; a quiet week is {"include":[]}.
// A pinned --version or --force dispatch keeps its entry even when nothing
// is newer — the human asked for that leg explicitly.
//
// The npm lookup is CLI-only; `assessRelease` is pure and unit-tested.
import { execFileSync } from "node:child_process";

const packages = {
  claude: {
    pkg: "@anthropic-ai/claude-code",
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
  opencode: {
    pkg: "opencode-ai",
    module: "../packages/adapter-opencode/src/profile.ts",
    profileExport: "opencodeCapabilityProfiles",
    harnessExport: "opencodeHarness",
  },
};

/** Fold semver.diff to the coarse classes the workflow branches on. */
export function classifyJump(from, to, semver) {
  const d = semver.diff(from, to);
  if (d === null) return null;
  if (d === "major") return "major";
  if (d === "minor" || d === "premajor" || d === "preminor") return "minor";
  return "patch";
}

/**
 * Pull the rolling scheduled-playback record's version out of a profile
 * module's source. The marker region holds at most one record (ADR-0009);
 * absent markers or an empty region yield undefined.
 */
export function rollingPlaybackVersion(profileSource) {
  const begin = profileSource.indexOf("// scheduled-playback:begin");
  const end = profileSource.indexOf("// scheduled-playback:end");
  if (begin < 0 || end < 0 || end < begin) return undefined;
  const between = profileSource.slice(begin, end);
  return between.match(/version: "([^"]+)"/)?.[1];
}

/**
 * Pure core: assess one harness. `latest` is the npm dist-tag (or a pinned
 * dispatch override); `referenceVersion` and `validatedOn` come from adapter
 * metadata. The baseline ignores everything but referenceVersion and the
 * rolling record.
 */
export function assessRelease({
  harness,
  pkg,
  referenceVersion,
  rollingVersion,
  latest,
  semver,
}) {
  const playbackBaseline =
    rollingVersion !== undefined && semver.gt(rollingVersion, referenceVersion)
      ? rollingVersion
      : referenceVersion;
  const newerAvailable = semver.gt(latest, playbackBaseline);
  return {
    harness,
    pkg,
    referenceVersion,
    playbackBaseline,
    latest,
    newerAvailable,
    jump: classifyJump(playbackBaseline, latest, semver),
  };
}

/** Dist-tag lookup, isolated for tests to stub. Windows spawn needs shell. */
export function fetchLatestDistTag(pkg, execFile = execFileSync) {
  const out = execFile("npm", ["view", pkg, "dist-tags.latest"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return String(out).trim();
}

/**
 * Matrix inclusion predicate. A quiet week is `{"include":[]}`; dispatches
 * that pin a version or force the LLM lane keep their entry even when
 * nothing is newer (the human asked for that leg explicitly).
 */
export function shouldInclude(assessment, { force, pinned } = {}) {
  if (pinned || force) return true;
  return assessment.newerAvailable;
}

function parseArgs(argv) {
  const opts = { harness: undefined, version: undefined, force: false, matrix: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--version") {
      opts.version = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--force") {
      opts.force = true;
    } else if (argv[i] === "--matrix") {
      opts.matrix = true;
    } else {
      opts.harness = argv[i];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const semver = await import("semver");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");

  const selected = Object.entries(packages).filter(
    ([id]) => opts.harness === undefined || opts.harness === id,
  );
  if (selected.length === 0) {
    process.stderr.write(
      `usage: node --experimental-strip-types ${process.argv[1]} [<${Object.keys(packages).join("|")}>] [--version <v>] [--force] [--matrix]\n`,
    );
    process.exit(2);
  }

  const entries = [];
  for (const [id, entry] of selected) {
    // strip-types import of unbuilt TS (same pattern as
    // harness-playback-version.mjs / record-playback-validation.mjs).
    const harnessMod = await import(
      new URL(entry.module.replace("profile.ts", "harness.ts"), import.meta.url)
    );
    const metadata = harnessMod[entry.harnessExport];
    if (metadata === undefined) {
      process.stderr.write(`${id}: harness export ${entry.harnessExport} not found\n`);
      process.exit(1);
    }
    const profileSource = readFileSync(
      fileURLToPath(new URL(entry.module, import.meta.url)),
      "utf8",
    );
    const latest = opts.version ?? fetchLatestDistTag(entry.pkg);
    const assessment = assessRelease({
      harness: id,
      pkg: entry.pkg,
      referenceVersion: metadata.referenceVersion,
      rollingVersion: rollingPlaybackVersion(profileSource),
      latest,
      semver,
    });
    // A quiet week emits {"include":[]}; every matrix job then gates on
    // count == '0' and skips. Pinned (--version) or forced (--force)
    // dispatches keep their entry even when nothing is newer — the human
    // asked for that leg explicitly.
    if (shouldInclude(assessment, { force: opts.force, pinned: opts.version !== undefined })) {
      entries.push(assessment);
    }
  }

  if (opts.matrix) {
    process.stdout.write(`${JSON.stringify({ include: entries })}\n`);
    process.exit(0);
  }
  for (const e of entries) {
    process.stdout.write(
      `${e.harness}: ${e.pkg} latest ${e.latest} vs playback baseline ${e.playbackBaseline}` +
        ` (reference ${e.referenceVersion}) -- ${e.newerAvailable ? `NEWER, jump ${e.jump}` : "no newer build to verify"}\n`,
    );
  }
  process.exit(0);
}

// Same CLI guard as release-notes.mjs: pure helpers stay importable.
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  await main();
}