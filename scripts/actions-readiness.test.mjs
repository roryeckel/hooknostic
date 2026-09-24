import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

function runWatchStep(name, expressions, prelude = "", workflow = "harness-watch", status = 0) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), "utf8");
  const step = source
    .split(/\r?\n {6}- /)
    .find((step) => step.startsWith(`name: ${name}\n`) || step.startsWith(`name: ${name}\r\n`));
  const body = step
    .split(/\r?\n {8}run: \|\r?\n/)[1]
    .split(/\r?\n(?=\S| {2}\S)/)[0]
    .split(/\r?\n/)
    .map((line) => line.slice(10))
    .join("\n")
    .replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key) => {
      if (!(key in expressions)) throw new Error(`Missing expression: ${key}`);
      return expressions[key];
    });
  const directory = mkdtempSync(join(tmpdir(), "hooknostic-actions-"));
  const bash =
    process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe") : "bash";
  try {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail"], {
      input: `${prelude}\n${body}`,
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "outputs.txt", RUNNER_TEMP: "." },
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(["", "skipped"])("reports an unrun playback step (%s) as an install failure", (outcome) => {
  const result = runWatchStep("Capture outcome", {
    "steps.playback.outcome": outcome,
    "matrix.harness": "claude",
    "matrix.latest": "2.1.250",
  });
  expect(JSON.parse(result.stdout).outcome).toBe("install-failure");
});

it("does not suppress validation because a closed PR names the same version", () => {
  const result = runWatchStep(
    "Idempotency — skip if the open PR already names this version",
    {
      "matrix.harness": "claude",
      "matrix.latest": "2.1.250",
    },
    `gh() {
    if [[ "$*" == *"pr view"* ]]; then
      echo 'harness-watch: claude 2.1.250 playback validation'
    elif [[ "$*" != *"--state open"* ]]; then
      return 1
    fi
  }
  trap 'cat "$GITHUB_OUTPUT"' EXIT`,
  );
  expect(result.stdout).toContain("skip=false");
});

it("preserves the downloaded outcome through failure issue creation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/harness-watch.yml", import.meta.url), "utf8");
  const report = workflow.slice(workflow.indexOf("  report-failure:"), workflow.indexOf("  drift:"));
  const download = report.indexOf("uses: actions/download-artifact@");
  const issue = report.indexOf("name: Deduped failure issue");
  expect(download).toBeGreaterThan(0);
  expect(issue).toBeGreaterThan(download);
  // Checkout's default clean removes untracked downloaded artifacts. Reproduce
  // that boundary before running the actual issue-writing shell body.
  const cleansOutcome = report.slice(download, issue).includes("uses: actions/checkout@");
  const result = runWatchStep(
    "Deduped failure issue",
    {
      "matrix.harness": "codex",
      "matrix.latest": "0.0.0-readiness-probe",
      "github.server_url": "https://github.com",
      "github.repository": "owner/project",
      "github.run_id": "123",
    },
    `printf '{"outcome":"install-failure"}' > watch-outcome-codex.json
    ${cleansOutcome ? "rm watch-outcome-codex.json" : ":"}
    jq() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).outcome)' "$3"; }
    gh() { if [[ "$1 $2" == "issue create" ]]; then printf '%s\\n' "$@"; fi; }`,
  );
  expect(result.stdout).toContain("Outcome: `install-failure`");
  expect(report).toContain("GH_REPO: ${{ github.repository }}");
});

it.each([401, 403, 500])("release duplicate checks stop on HTTP %s instead of treating it as absence", (status) => {
  runWatchStep(
    "Guard duplicates",
    { "github.repository": "owner/project" },
    `
    VERSION=0.2.0
    gh() { printf 'HTTP/2.0 ${status} Error\\n\\n{}\\n'; return 1; }
  `,
    "release-prepare",
    1,
  );
});

it("release cleanup cannot delete a branch rejected by the duplicate guard", () => {
  const source = readFileSync(new URL("../.github/workflows/release-prepare.yml", import.meta.url), "utf8");
  const cleanup = source.slice(source.indexOf("- name: Cleanup on failure"));
  expect(cleanup).toContain("steps.pr.outputs.branch_created == 'true'");
});

it("release duplicate checks accept confirmed missing refs", () => {
  runWatchStep(
    "Guard duplicates",
    { "github.repository": "owner/project" },
    `
    VERSION=0.2.0
    gh() { printf 'HTTP/2.0 404 Not Found\\n\\n{}\\n'; return 1; }
  `,
    "release-prepare",
  );
});

it.each(["@hooknostic/sdk", "@hooknostic/agent-plugin", "hooknostic (CLI)"])(
  "does not attempt to publish %s when its registry lookup fails authentication",
  (name) => {
    const result = runWatchStep(
      `Publish ${name}`,
      {},
      `
      RELEASE_TAG=v0.2.0
      npm() { printf '{"error":{"code":"E401"}}\\n'; return 1; }
      pnpm() { echo UNEXPECTED_PUBLICATION; }
    `,
      "release-publish",
      1,
    );
    expect(result.stdout).not.toContain("UNEXPECTED_PUBLICATION");
  },
);

it("a confirmed missing prerelease reaches the simulated next-tag publication", () => {
  const result = runWatchStep(
    "Publish @hooknostic/sdk",
    {},
    `
    RELEASE_TAG=v0.2.0-rc.1
    npm() { printf '{"error":{"code":"E404"}}\\n'; return 1; }
    pnpm() { printf 'SIMULATED: %s\\n' "$*"; }
  `,
    "release-publish",
  );
  expect(result.stdout).toContain("SIMULATED: publish --no-git-checks --access public --tag next");
});

it("an already published version never reaches publication", () => {
  const result = runWatchStep(
    "Publish @hooknostic/sdk",
    {},
    `
    RELEASE_TAG=v0.2.0
    npm() { printf '"0.2.0"\\n'; }
    pnpm() { echo UNEXPECTED_PUBLICATION; }
  `,
    "release-publish",
  );
  expect(result.stdout).toContain("already on the registry; skipping");
  expect(result.stdout).not.toContain("UNEXPECTED_PUBLICATION");
});
