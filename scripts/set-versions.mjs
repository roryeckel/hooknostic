// Lockstep version bump for the whole workspace. The internal packages are
// bundled into the CLI, so independent numbers would carry zero information
// while creating real ambiguity -- one release version everywhere.
//
//   node scripts/set-versions.mjs 0.2.0          # rewrite
//   node scripts/set-versions.mjs --check 0.2.0  # assert, change nothing
//
// Rewrites: the root and every packages/*/package.json "version", all
// inlined adapterVersion literals, and HOOKNOSTIC_VERSION in core/build.ts.
// Never touches examples/ (their versions are example content, not release
// versions) or workspace:* specifiers (pnpm rewrites those at pack time).
// versions.test.ts is the gate that catches a carrier this script missed.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = check ? args[1] : args[0];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
if (version === undefined || !SEMVER.test(version)) {
  console.error(
    `usage: set-versions.mjs [--check] <semver>\n` +
      `got: ${version ?? "<missing>"} (no leading "v"; MAJOR.MINOR.PATCH[-PRERELEASE])`,
  );
  process.exit(2);
}

const failures = [];
let rewrites = 0;

function handle(path, current, next) {
  if (current === next) return;
  if (check) {
    failures.push(`${path}: ${current}`);
  } else {
    writeFileSync(path, next, "utf8");
    rewrites += 1;
    console.log(`rewrote ${path}`);
  }
}

// package.json manifests
const manifestDirs = [
  ROOT,
  ...readdirSync(resolve(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(ROOT, "packages", entry.name)),
];
for (const dir of manifestDirs) {
  const path = resolve(dir, "package.json");
  const src = readFileSync(path, "utf8");
  const next = src.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  const currentVersion = JSON.parse(src).version;
  if (check && currentVersion !== version) failures.push(`${path}: ${currentVersion}`);
  else if (!check) handle(path, src, next);
}

// inlined source literals
const sourceCarriers = [
  ["packages/core/src/build.ts", /(export const HOOKNOSTIC_VERSION = ")[^"]+(")/],
  ["packages/adapter-claude/src/index.ts", /(adapterVersion: ")[^"]+(")/],
  ["packages/adapter-codex/src/index.ts", /(adapterVersion: ")[^"]+(")/],
  ["packages/adapter-opencode/src/index.ts", /(adapterVersion: ")[^"]+(")/],
  ["packages/adapter-opencode/src/v2/index.ts", /(adapterVersion: ")[^"]+(")/],
];
for (const [rel, pattern] of sourceCarriers) {
  const path = resolve(ROOT, rel);
  const src = readFileSync(path, "utf8");
  const match = src.match(pattern);
  if (!match) {
    console.error(`${rel}: version carrier pattern not found -- update set-versions.mjs`);
    process.exit(1);
  }
  const current = src.match(new RegExp(pattern.source.replace(/\(|\)/g, "")))?.[0];
  const next = src.replace(pattern, `$1${version}$2`);
  if (check && next !== src) failures.push(`${rel}: ${current}`);
  else if (!check) handle(path, src, next);
}

if (check) {
  if (failures.length > 0) {
    console.error(`version mismatch, expected ${version}:\n` + failures.join("\n"));
    process.exit(1);
  }
  console.log(`all version carriers agree on ${version}`);
} else {
  console.log(rewrites > 0 ? `${rewrites} files rewritten to ${version}` : `already at ${version}`);
  console.log("next: pnpm install --lockfile-only, then pnpm build:examples from the repo root");
}
