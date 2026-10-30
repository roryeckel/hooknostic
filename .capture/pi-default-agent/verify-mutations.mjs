// Run `pnpm run bundle` first. Each deliberate defect must fail the test that
// pins it. Sources are always restored; reports stay in ignored captured/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".capture/pi-default-agent/captured/mutations");
mkdirSync(output, { recursive: true });
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const unit = "packages/core/src/default-only-agent.test.ts";
const core = "packages/core/src/build.ts";
const pi = "packages/adapter-pi/src/project.ts";
const cases = [
  [
    "default-pruned-with-definitions",
    core,
    'definitionRoute || !isDeliveredDefault(agent) || agent.mode !== "primary"',
    "true",
    unit,
    "delivers the fixed default|removes an owned append",
  ],
  [
    "default-lost-after-unsupported-delegation",
    core,
    ".filter(isDeliveredDefault)",
    ".filter(() => false)",
    unit,
    "reports every other selected|delegation half",
  ],
  [
    "unnamed-omissions",
    core,
    "names.map((name) => ({ component, name, reason }))",
    "names.map(() => ({ component, reason }))",
    unit,
    "reports every other selected",
  ],
  [
    "all-default-silently-loses-delegation",
    core,
    'agent.mode !== "primary",',
    "!servesAsPrimary(agent.mode),",
    unit,
    "delegation half",
  ],
  [
    "native-fields-falsely-supported",
    pi,
    '"agents.native": { level: "unsupported"',
    '"agents.native": { level: "exact"',
    unit,
    "keeps native Pi fields",
  ],
  [
    "overwrite-authored-append",
    "packages/core/src/project-files.ts",
    "        before &&\n        (!oldWhole ||",
    '        path !== ".pi/APPEND_SYSTEM.md" && before &&\n        (!oldWhole ||',
    unit,
    "refuses an",
  ],
  [
    "deselected-default-still-counted",
    core,
    "const defaultAgent = agents?.some((agent) => agent.name === source?.defaultAgent) ? source?.defaultAgent : undefined;",
    "const defaultAgent = source?.defaultAgent;",
    unit,
    "removes an owned append",
  ],
  [
    "pi-scoped-hooks-falsely-supported",
    "packages/adapter-pi/src/profile.ts",
    "    matrix: {",
    '    matrix: {\n      "tool.before.agent.identity": { level: "exact" },',
    "packages/core/src/agent-scope.test.ts",
    "refuses Pi agent scopes",
  ],
  [
    "generated-default-pruned",
    core,
    'definitionRoute || !isDeliveredDefault(agent) || agent.mode !== "primary"',
    "true",
    "packages/cli/test/pi-default-agent-playback.test.ts",
    "delivers the native append",
  ],
];
const results = [];
for (const [name, file, before, after, test, pattern] of cases) {
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  assert.equal(original.split(before).length, 2, `${name}: mutation anchor must be unique`);
  const report = join(output, `${name}.json`);
  try {
    writeFileSync(path, original.replace(before, after));
    const result = spawnSync(
      process.execPath,
      [vitest, "run", test, "-t", pattern, "--reporter=json", `--outputFile=${report}`],
      { cwd: root, encoding: "utf8", env: { ...process.env, HOOKNOSTIC_PLAYBACK: "pi" }, timeout: 300_000 },
    );
    writeFileSync(join(output, `${name}.log`), result.stdout + result.stderr);
    assert.equal(result.status, 1, `${name}: expected a failed test, got ${result.status}\n${result.stderr}`);
    const summary = JSON.parse(readFileSync(report, "utf8"));
    assert.ok(summary.numFailedTests > 0, `${name}: no failed assertions`);
    results.push({ name, test, failed: summary.numFailedTests });
    console.log(`${name}: ${summary.numFailedTests} test(s) failed as expected`);
  } finally {
    writeFileSync(path, original);
  }
}
writeFileSync(join(output, "summary.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`Verified ${results.length} regression mutants; all source bytes restored.`);
