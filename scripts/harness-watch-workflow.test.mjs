// Structural lint over .github/workflows/harness-watch.yml. This file
// previously shipped four bugs that YAML parsing cannot catch (they parse
// fine, then fail or misreport at run time); these tests pin the corrected
// shapes so a refactor that reintroduces them fails here, not on a live
// scheduled run:
//
//   1. detect's step had an invalid self-referencing env mapping
//      (env: COUNT: ${{ steps.detect.outputs.count }} — an expression
//      referencing its own step id).
//   2. record consumed matrix.harness/matrix.latest without a strategy
//      matrix (the leg ran once, not per harness).
//   3. report-failure read watch-outcome-<harness>.json without ever
//      downloading the artifact that carries it.
//   4. verify's install-failure detection read steps.playback.conclusion
//      (`skipped` / empty) instead of steps.playback.outcome — the empty
//      case is outcome == "", and `skipped` happens only on `if:` gating,
//      not on an earlier step's failure.
//
// The YAML is parsed with the `yaml` package if present; otherwise a
// line-based fallback is used. All assertions work on plain text/structure
// either way.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = new URL("../.github/workflows/harness-watch.yml", import.meta.url);
const source = readFileSync(fileURLToPath(WORKFLOW), "utf8");

/** Extract a top-level job's raw YAML text by scanning at column 2. */
function jobSource(name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (l, i) => i > start && /^ {2}\w[\w-]*:$/.test(l),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

describe("harness-watch workflow structure", () => {
  it("detect has no self-referencing env on the detect step", () => {
    const detect = jobSource("detect");
    // The bug: an env block under the step setting COUNT from
    // steps.detect.outputs.count. Output wiring must go through
    // GITHUB_OUTPUT only.
    expect(detect).not.toMatch(/env:\s*\n\s*COUNT:\s*\$\{\{ steps\.detect\.outputs\.count \}\}/);
    expect(detect).toContain('echo "count=$COUNT"');
  });

  it("record re-runs the detect matrix with a leading artifact gate", () => {
    const record = jobSource("record");
    expect(record).toMatch(/strategy:\s*\n\s*fail-fast: false\s*\n\s*matrix:\s*\n\s*include: \$\{\{ fromJson\(needs\.detect\.outputs\.matrix\)\.include \}\}/);
    // The gate must download the outcome artifact before anything that uses
    // matrix.harness, and skip legs without it.
    expect(record).toContain("watch-outcome-${{ matrix.harness }}");
    expect(record).toContain("steps.gate.outputs.skip");
  });

  it("record still runs its per-harness artifact gates after a verify matrix leg fails", () => {
    const record = jobSource("record");
    expect(record).toMatch(/if: \$\{\{ always\(\) && needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0' \}\}/);
  });

  it("never expands a matrix when detect was skipped or failed", () => {
    for (const job of ["record", "report-failure"]) {
      expect(jobSource(job)).toMatch(
        /needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0'/,
      );
    }
  });

  it("keeps credentials and issue permission for record writes", () => {
    const record = jobSource("record");
    expect(record).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
    expect(record).toContain("persist-credentials: true");
    const labelStep = record.slice(
      record.indexOf("Ensure harness-watch label exists"),
      record.indexOf("Idempotency — skip if the open PR"),
    );
    expect(labelStep).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("report-failure downloads the outcome artifact before reading it", () => {
    const report = jobSource("report-failure");
    const dl = report.indexOf("actions/download-artifact");
    const read = report.indexOf("jq -r .outcome");
    expect(dl).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(dl);
    expect(report).toContain("Ensure harness-watch label exists");
  });

  it("verify classifies install-failure via steps.playback.outcome, not conclusion", () => {
    const verify = jobSource("verify");
    // steps.*.conclusion of an unrun step is "skipped" for `if:` gating but
    // the outcome is "" — the workflow must branch on outcome emptiness.
    expect(verify).toContain('steps.playback.outcome');
    expect(verify).not.toContain("steps.playback.conclusion");
    expect(verify).toMatch(/outcome=install-failure/);
  });

  it("publishes declared inconclusive scenarios instead of hiding skipped drivers", () => {
    const verify = jobSource("verify");
    expect(verify).toContain("HOOKNOSTIC_PLAYBACK_INCONCLUSIVE_PATH");
    expect(verify).toContain("Publish inconclusive scenario outcomes");
    expect(verify).toContain("#### Inconclusive scenarios");
    expect(verify).toContain("GITHUB_STEP_SUMMARY");
    expect(verify.indexOf("Publish inconclusive scenario outcomes")).toBeGreaterThan(
      verify.indexOf("Model-free playback against the newer build"),
    );
  });

  it("every matrix-context job declares a strategy matrix", () => {
    const jobs = ["verify", "record", "report-failure", "drift", "publish-verdict"];
    for (const job of jobs) {
      const src = jobSource(job);
      const usesMatrix = /\$\{\{ matrix\./.test(src);
      if (usesMatrix) {
        expect(src, `${job} uses matrix context`).toMatch(/strategy:/);
        expect(src, `${job} matrix source`).toContain(
          "fromJson(needs.detect.outputs.matrix).include",
        );
      }
    }
  });

  it("drift is read-only and never propagates expected non-clean exits", () => {
    const drift = jobSource("drift");
    // Posts nothing — publish-verdict owns all writes — and it executes
    // third-party harness code, so read-only scopes only.
    expect(drift).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
    expect(drift).not.toContain("issues: write");
    expect(drift).not.toContain("pull-requests: write");
    // Exits 4/5/6 are reportable outcomes; the step must not fail the job.
    expect(drift).toContain("continue-on-error: true");
    expect(drift).toContain("drift-verdict-${{ matrix.harness }}");
    expect(drift).toContain("drift-report-${{ matrix.harness }}.log");
    const drive = drift.slice(
      drift.indexOf("Run the drift capture-compare"),
      drift.indexOf("Write the verdict artifact"),
    );
    expect(drive).not.toContain("HARNESS_LLM_API_KEY: ${{ secrets.HARNESS_LLM_API_KEY }}");
    expect(drive).toContain("docker run --rm --network bridge");
    expect(drive).toContain("dst=/workspace,readonly");
    expect(drive).toContain("--security-opt no-new-privileges");
    expect(drive).toContain('PLAYBACK_NODE="$(cat .github/node/playback/.node-version)"');
    expect(drive).toContain('"node:${PLAYBACK_NODE}-bookworm"');
    expect(drive).toContain('opencode) node "$(npm root --global)/opencode-ai/postinstall.mjs"');
    expect(drive.indexOf("npm install --global --ignore-scripts")).toBeLessThan(
      drive.indexOf("opencode-ai/postinstall.mjs"),
    );
    expect(drive.indexOf("opencode-ai/postinstall.mjs")).toBeLessThan(
      drive.indexOf('HOOKNOSTIC_PLAYBACK_VERSION="$2"'),
    );
    expect(drive).toContain('HOOKNOSTIC_PLAYBACK_VERSION="$2"');
    expect(drive.indexOf('HOOKNOSTIC_PLAYBACK_VERSION="$2"')).toBeLessThan(
      drive.indexOf("exec node --experimental-strip-types"),
    );
    expect(drive.indexOf("opencode-ai/postinstall.mjs")).toBeLessThan(
      drive.indexOf("exec node --experimental-strip-types"),
    );
    const sidecar = drift.slice(
      drift.indexOf("Install LiteLLM sidecar"),
      drift.indexOf("Run the drift capture-compare"),
    );
    expect(sidecar).toContain(
      "Keep the upstream secret out of dependency installation too.",
    );
    expect(sidecar.indexOf("pipx install")).toBeLessThan(
      sidecar.indexOf("HARNESS_LLM_API_KEY: ${{ secrets.HARNESS_LLM_API_KEY }}"),
    );
    expect(sidecar).toContain('OPENAI_API_KEY="$HARNESS_LLM_API_KEY"');
    expect(sidecar).not.toContain('--api_key "$HARNESS_LLM_API_KEY"');
    expect(sidecar).toContain("SIDECAR_PID=$!");
    expect(sidecar).toContain('if [ "$SIDECAR_READY" != true ]; then');
    // The paid llm transport runs only on force_llm.
    expect(drift).toMatch(/inputs\.force_llm == 'true'/);
  });

  it("publish-verdict is the single final writer gated on detect", () => {
    const publish = jobSource("publish-verdict");
    expect(publish).toMatch(
      /needs: \[detect, record, report-failure, drift\]/,
    );
    expect(publish).toMatch(
      /if: \$\{\{ always\(\) && needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0' \}\}/,
    );
    expect(publish).toMatch(
      /permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n\s*pull-requests: write/,
    );
    // Every verdict gets a durable destination even with no PR/issue.
    const summary = publish.indexOf("GITHUB_STEP_SUMMARY");
    const comment = publish.indexOf("Comment the verdict on the destination");
    expect(summary).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(summary);
  });

  it("publish-verdict keeps gh's repository context for reconciliation without a drift verdict", () => {
    const publish = jobSource("publish-verdict");
    expect(publish).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
    // Patch-pass runs gate drift off, which also skips checkout. GH_REPO keeps
    // the reconciliation gh calls targeted at this repository in that path.
    expect(publish).toContain("GH_REPO: ${{ github.repository }}");
    expect(publish).toContain("watch-outcome-${{ matrix.harness }}");
    const reconcile = publish.slice(publish.indexOf("Reconcile failure issues after a passing run"));
    expect(reconcile).toContain("if: always()");
    expect(reconcile).not.toContain("steps.resolve.outputs.publish");
    expect(reconcile).toContain("jq -e '.outcome == \"pass\"'");
    expect(reconcile).toContain("EXPECTED_PR_TITLE");
  });

  it("routes verdicts only to a PR for the matrix version", () => {
    const publish = jobSource("publish-verdict");
    const destination = publish.slice(
      publish.indexOf("Locate the conversation destination"),
      publish.indexOf("File a deduped report issue"),
    );
    expect(destination).toContain("EXPECTED_PR_TITLE");
    expect(destination).toContain('[ "$PR_TITLE" = "$EXPECTED_PR_TITLE" ]');
  });
});
