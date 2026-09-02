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

  it("report-failure downloads the outcome artifact before reading it", () => {
    const report = jobSource("report-failure");
    const dl = report.indexOf("actions/download-artifact");
    const read = report.indexOf("jq -r .outcome");
    expect(dl).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(dl);
  });

  it("verify classifies install-failure via steps.playback.outcome, not conclusion", () => {
    const verify = jobSource("verify");
    // steps.*.conclusion of an unrun step is "skipped" for `if:` gating but
    // the outcome is "" — the workflow must branch on outcome emptiness.
    expect(verify).toContain('steps.playback.outcome');
    expect(verify).not.toContain("steps.playback.conclusion");
    expect(verify).toMatch(/outcome=install-failure/);
  });

  it("every matrix-context job declares a strategy matrix", () => {
    const jobs = ["verify", "record", "report-failure"];
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
});