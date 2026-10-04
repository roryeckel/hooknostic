import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

import { expect, it } from "vitest";

it("routes bot updates through readiness while humans, forks, and master pushes keep full CI", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const gate = ci.split("  renovate-ready:")[1].split(/\r?\n {2}\S/)[0];
  const expression = gate.split("if: >-")[1].split("runs-on:")[0].trim();
  const github = {
    event_name: "pull_request",
    repository: "owner/repo",
    event: {
      pull_request: {
        user: { login: "renovate[bot]", type: "Bot" },
        head: { repo: { full_name: "owner/repo" }, ref: "renovate/update" },
      },
    },
  };
  const evaluate = (context) =>
    new Script(expression).runInNewContext({ github: context, startsWith: (s, prefix) => s.startsWith(prefix) });
  expect(evaluate(github)).toBe(true);
  for (const mutate of [
    (g) => {
      g.event_name = "push";
      g.event = {};
    },
    (g) => {
      g.event.pull_request.user.login = "human";
    },
    (g) => {
      g.event.pull_request.user.type = "User";
    },
    (g) => {
      g.event.pull_request.head.repo.full_name = "fork/repo";
    },
    (g) => {
      g.event.pull_request.head.ref = "feature/update";
    },
  ]) {
    const context = globalThis.structuredClone(github);
    mutate(context);
    expect(evaluate(context)).toBe(false);
  }
  for (const job of ["dependency-policy", "test", "node-compatibility", "harness-playback", "code-mode"]) {
    const body = ci.split(`  ${job}:`)[1].split(/\r?\n {2}\S/)[0];
    // GitHub permits hyphens in property names; JavaScript needs brackets.
    const condition = body
      .match(/if: \$\{\{(.*?)\}\}/)[1]
      .replaceAll("needs.renovate-ready", 'needs["renovate-ready"]');
    for (const result of ["success", "skipped", "failure", "cancelled"]) {
      for (const cancelled of [false, true]) {
        expect(
          new Script(condition).runInNewContext({
            needs: { "renovate-ready": { result } },
            cancelled: () => cancelled,
          }),
        ).toBe(!cancelled && ["success", "skipped"].includes(result));
      }
    }
  }
});

it("makes every full CI lane wait for Renovate artifact readiness", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const job of ["dependency-policy", "test", "node-compatibility", "harness-playback", "code-mode"]) {
    const body = ci.split(`  ${job}:`)[1].split(/\r?\n {2}\S/)[0];
    expect(body).toContain("needs: renovate-ready");
    expect(body).toContain("!cancelled()");
    expect(body).toContain("needs.renovate-ready.result == 'success'");
    expect(body).toContain("needs.renovate-ready.result == 'skipped'");
  }
  const gate = ci.split("  renovate-ready:")[1].split(/\r?\n {2}\S/)[0];
  expect(gate).toContain("github.event_name == 'pull_request'");
  expect(gate).toContain("github.event.pull_request.user.login == 'renovate[bot]'");
  expect(gate).toContain("github.event.pull_request.user.type == 'Bot'");
  expect(gate).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  expect(gate).toContain("startsWith(github.event.pull_request.head.ref, 'renovate/')");
  expect(gate).toContain("persist-credentials: false");
  expect(gate).not.toContain("secrets.");
  expect(ci).toMatch(/push:\s+branches: \[master\]/);
});

it.each([" M example", "?? example", " D example"])(
  "stops Renovate CI before the matrix when generation leaves %s",
  (status) => {
    runWatchStep(
      "Require current generated artifacts",
      {},
      `pnpm() { :; }\ngit() { if [[ "$1" == status ]]; then echo '${status}'; fi; }`,
      "ci",
      1,
    );
  },
);

it("allows the matrix for clean Renovate artifacts but fails closed on build or git errors", () => {
  runWatchStep("Require current generated artifacts", {}, "pnpm() { :; }\ngit() { :; }", "ci");
  runWatchStep("Require current generated artifacts", {}, "pnpm() { return 23; }", "ci", 23);
  runWatchStep("Require current generated artifacts", {}, "pnpm() { :; }\ngit() { return 24; }", "ci", 24);
});

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
      timeout: 60_000,
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

// download-artifact can extract files before failing its digest check. File
// presence alone must never authorize a record, report, or reconciliation.
it.each([
  ["Gate on pass", "skip=true", "skip=false"],
  ["Resolve verify outcome", "failed=false", "failed=true"],
  ["Gate on drift relevance", "run=false", "run=true"],
  ["Resolve verdict", "publish=false", "publish=true"],
  ["Reconcile failure issues after a passing run", "", ""],
])("%s ignores files left by a failed download and accepts successful downloads", (step, declined, accepted) => {
  for (const outcome of ["failure", "skipped", "", "success"]) {
    const result = runWatchStep(
      step,
      {
        "steps.artifact.outcome": outcome,
        "steps.outcome.outcome": outcome,
        "steps.verdict.outcome": outcome,
        "matrix.harness": "codex",
        "matrix.latest": "0.0.0-readiness-probe",
        "matrix.jump": "patch",
        "inputs.force_llm": "false",
        "inputs.dry_run": "false",
        "github.server_url": "https://github.com",
        "github.repository": "owner/project",
        "github.run_id": "123",
      },
      `printf '{"outcome":"pass"}' > watch-outcome-codex.json
      printf '{"verdict":"drift"}' > drift-verdict-codex.json
      jq() {
        echo ARTIFACT_READ >&2
        if [[ "$1" == "-r" ]]; then echo install-failure; fi
      }
      gh() { echo EXTERNAL_CALL >&2; }
      trap 'if [[ -f "$GITHUB_OUTPUT" ]]; then cat "$GITHUB_OUTPUT"; fi' EXIT`,
    );
    if (outcome !== "success") {
      expect(result.stderr).not.toContain("ARTIFACT_READ");
      expect(result.stderr).not.toContain("EXTERNAL_CALL");
      if (declined) expect(result.stdout).toContain(declined);
    } else {
      expect(result.stderr).toContain("ARTIFACT_READ");
      if (accepted) expect(result.stdout).toContain(accepted);
    }
  }
});
