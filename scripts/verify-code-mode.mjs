import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

/**
 * The Codex build Code Mode hook dispatch was captured on, read from the
 * profile's own `captured` record (.capture/codex-code-mode). The Code Mode
 * playback drives run against it or newer; `referenceVersion` predates it, so
 * the ordinary playback lane skips them.
 */
export function codeModeReferenceVersion(adapter) {
  const records = adapter
    .supportedHarnessVersions()
    .flatMap(
      (range) =>
        adapter.capabilities({ id: adapter.id, version: range, delivery: "project", output: "." }).profilesUsed,
    )
    .flatMap((profile) => profile.source.validatedOn);
  const record = records.find((entry) => entry.artifact === ".capture/codex-code-mode" && entry.method === "captured");
  if (!record) throw new Error(`${adapter.id}: missing Code Mode capture evidence`);
  return record.version;
}

/**
 * Every test the gate exists to run, by exact title. A title filter alone lets
 * the gate pass on the version check while no drive matched -- a renamed drive
 * must fail it, loudly, not shrink it.
 */
export const CODE_MODE_GATE_TESTS = [
  "uses exactly the captured reference harness version",
  "denies a nested exec_command inside a Code Mode exec",
  "rewrites a nested exec_command inside a Code Mode exec",
];

/** Throws unless every gate test ran and passed, given a Vitest JSON report. */
export function requireGateCoverage(report) {
  const statuses = new Map(
    (report.testResults ?? []).flatMap((file) =>
      (file.assertionResults ?? []).map((result) => [result.title, result.status]),
    ),
  );
  const missing = CODE_MODE_GATE_TESTS.filter((title) => statuses.get(title) !== "passed");
  if (missing.length > 0) {
    throw new Error(
      `Code Mode gate: not run and passed: ${missing.map((title) => `"${title}" (${statuses.get(title) ?? "absent"})`).join(", ")}`,
    );
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--print-version")) {
    process.stderr.write("usage: verify-code-mode.mjs [--print-version]\n");
    process.exit(2);
  }
  const { defaultAdapterRegistry } = await import("../packages/cli/dist/index.js");
  const version = codeModeReferenceVersion(defaultAdapterRegistry().codex);
  if (args.includes("--print-version")) console.log(version);
  else {
    const reportDir = mkdtempSync(join(tmpdir(), "hooknostic-code-mode-gate-"));
    const reportPath = join(reportDir, "report.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs"),
          "run",
          "packages/cli/test/harness-playback.test.ts",
          "-t",
          CODE_MODE_GATE_TESTS.join("|"),
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${reportPath}`,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          stdio: "inherit",
          env: {
            ...process.env,
            HOOKNOSTIC_PLAYBACK: "codex",
            HOOKNOSTIC_PLAYBACK_VERSION: process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? version,
            // Below the baseline the drives fail instead of skipping, so this
            // gate cannot pass with nothing exercised.
            HOOKNOSTIC_REQUIRE_CODE_MODE: "1",
            HOOKNOSTIC_SMOKE: "",
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            OPENAI_API_KEY: "",
            OPENROUTER_API_KEY: "",
          },
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
      } else {
        requireGateCoverage(JSON.parse(readFileSync(reportPath, "utf8")));
      }
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }
}
