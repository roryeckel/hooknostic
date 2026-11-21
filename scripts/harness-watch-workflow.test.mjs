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
//   4. verify must classify both skipped and absent playback steps as an
//      installation/toolchain failure; neither exercised the harness.
//
// The YAML is parsed with the `yaml` package if present; otherwise a
// line-based fallback is used. All assertions work on plain text/structure
// either way.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKFLOW = new URL("../.github/workflows/harness-watch.yml", import.meta.url);
const source = readFileSync(fileURLToPath(WORKFLOW), "utf8");

/** Extract a top-level job's raw YAML text by scanning at column 2. */
function jobSource(name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {2}\w[\w-]*:$/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

describe("harness-watch workflow structure", () => {
  it("rehearses free drift without running any writer job", () => {
    expect(source).toContain("      dry_run:");
    for (const name of ["record", "report-failure", "publish-verdict", "automerge"]) {
      const job = jobSource(name);
      expect(job.match(/^ {4}if:.*$/m)?.[0], name).toContain("inputs.dry_run != 'true'");
    }
    const gate = jobSource("drift").split("- name: Gate on drift relevance")[1].split("- uses:")[0];
    expect(gate).toContain('[ "${{ inputs.dry_run }}" = "true" ]');
    expect(jobSource("drift")).toContain(
      'if [ "${{ inputs.force_llm }}" = "true" ]; then TRANSPORT=llm; else TRANSPORT=playback; fi',
    );
  });

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
    expect(record).toMatch(
      /strategy:\s*\n\s*fail-fast: false\s*\n\s*matrix:\s*\n\s*include: \$\{\{ fromJson\(needs\.detect\.outputs\.matrix\)\.include \}\}/,
    );
    // The gate must download the outcome artifact before anything that uses
    // matrix.harness, and skip legs without it.
    expect(record).toContain("watch-outcome-${{ matrix.harness }}");
    expect(record).toContain("steps.gate.outputs.skip");
  });

  it("record still runs its per-harness artifact gates after a verify matrix leg fails", () => {
    const record = jobSource("record");
    expect(record).toMatch(
      /if: \$\{\{ always\(\) && needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0' && inputs\.dry_run != 'true' \}\}/,
    );
  });

  it("builds profile runtime dependencies before recording playback validation", () => {
    const record = jobSource("record");
    const build = record.indexOf("pnpm --filter @hooknostic/agent-plugin run bundle");
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(
      record.indexOf("node --experimental-strip-types scripts/record-playback-validation.mjs"),
    );
    const step = record.slice(record.lastIndexOf("- name:", build), build);
    expect(step).toContain("if: steps.gate.outputs.skip == 'false' && steps.pr.outputs.skip == 'false'");
  });

  it("never expands a matrix when detect was skipped or failed", () => {
    for (const job of ["record", "report-failure"]) {
      expect(jobSource(job)).toMatch(/needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0'/);
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
    // Only an explicitly failed playback step is a playback failure.
    expect(verify).toContain("steps.playback.outcome");
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
        expect(src, `${job} matrix source`).toContain("fromJson(needs.detect.outputs.matrix).include");
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
    expect(drive).toContain("--init --user node");
    expect(drive).toContain("export npm_config_prefix=/tmp/hooknostic-harness");
    expect(drive).toContain('export PATH="$npm_config_prefix/bin:$PATH"');
    expect(drive).toContain("dst=/workspace,readonly");
    expect(drive).toContain("--security-opt no-new-privileges");
    expect(drive).toContain('PLAYBACK_NODE="$(cat .github/node/playback/.node-version)"');
    expect(drive).toContain('"node:${PLAYBACK_NODE}-bookworm"');
    expect(drive).toContain(
      'opencode|opencode-v1|opencode-v2) node "$(npm root --global)/${{ matrix.pkg }}/${{ matrix.bootstrap }}"',
    );
    expect(drive.indexOf("npm install --global --ignore-scripts")).toBeLessThan(
      drive.indexOf("${{ matrix.pkg }}/${{ matrix.bootstrap }}"),
    );
    expect(drive.indexOf("${{ matrix.pkg }}/${{ matrix.bootstrap }}")).toBeLessThan(
      drive.indexOf('HOOKNOSTIC_PLAYBACK_VERSION="$2"'),
    );
    expect(drive).toContain('HOOKNOSTIC_PLAYBACK_VERSION="$2"');
    expect(drive.indexOf('HOOKNOSTIC_PLAYBACK_VERSION="$2"')).toBeLessThan(
      drive.indexOf("exec node --experimental-strip-types"),
    );
    expect(drive.indexOf("${{ matrix.pkg }}/${{ matrix.bootstrap }}")).toBeLessThan(
      drive.indexOf("exec node --experimental-strip-types"),
    );
    const sidecar = drift.slice(
      drift.indexOf("Install LiteLLM sidecar"),
      drift.indexOf("Run the drift capture-compare"),
    );
    expect(sidecar).toContain("Keep the upstream secret out of dependency installation too.");
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

  it("verify runs the newer build's playback without network, after preparing what it fetches", () => {
    const verify = jobSource("verify");
    const steps = verify.split(/\r?\n {6}- /).slice(1);
    const step = (name) => steps.find((candidate) => candidate.split(/\r?\n/)[0] === `name: ${name}`);
    const field = (body, key) => body?.match(new RegExp(`^ {8}${key}: (.+?)\\r?$`, "m"))?.[1];
    const prepare = step("Prepare offline playback prerequisites");
    const playback = step("Model-free playback against the newer build");
    expect(field(prepare, "run")).toBe(
      "node --experimental-strip-types scripts/prepare-offline-playback.mjs '${{ matrix.harness }}' --version '${{ matrix.latest }}' --check-online",
    );
    expect(field(playback, "id")).toBe("playback");
    expect(field(playback, "run")).toBe(
      "scripts/without-network.sh pnpm exec vitest run packages/cli/test/harness-playback.test.ts packages/cli/test/opencode-v2-playback.test.ts",
    );
    expect(field(playback, " {2}HKN_NO_NETWORK_REQUIRE_ENV")).toBe(
      "HOOKNOSTIC_PLAYBACK,HOOKNOSTIC_PLAYBACK_VERSION,HKN_RIPGREP_DIR",
    );
    expect(field(playback, " {2}HKN_RIPGREP_DIR")).toBe(field(prepare, " {2}HKN_RIPGREP_DIR"));
    const order = [
      "Install newer harness build",
      "Bundle compiler and dependencies",
      "Cache the OpenCode v2 tools drive's pinned ripgrep",
      "Prepare offline playback prerequisites",
      "Model-free playback against the newer build",
    ].map((name) => steps.indexOf(step(name)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("drift's playback drive runs with --network none, with everything phase 1 fetched", () => {
    const drift = jobSource("drift");
    const drive = drift.slice(
      drift.indexOf("Run the drift capture-compare"),
      drift.indexOf("Write the verdict artifact"),
    );
    const playback = drive.slice(drive.indexOf("# The playback transport is offline by intent"));
    const phase1 = playback.slice(0, playback.indexOf("# Phase 2"));
    const phase2 = playback.slice(playback.indexOf("# Phase 2"));
    expect(phase1).toContain('docker run --network bridge "${COMMON[@]}" "${DRIFT_ENVS[@]}"');
    expect(phase1).toContain('scripts/prepare-offline-playback.mjs "$3" --version "$2" --check-online');
    // The marker that tells a failed prepare from a failed install (run in
    // the container, so the executed step tests stub it): after the install,
    // before the prepare.
    const marker = phase1.indexOf(": > /drift/installed");
    expect(marker).toBeGreaterThan(phase1.indexOf('"$INSTALL"'));
    expect(marker).toBeLessThan(phase1.indexOf("scripts/prepare-offline-playback.mjs"));
    // A lookup fails at once, as in scripts/without-network.sh: musl (codex)
    // otherwise waits 5 s a lookup.
    expect(phase2).toContain("docker run --network none --dns-option timeout:0 --dns-option attempts:1 \\");
    expect(phase2).toContain('"${COMMON[@]}" "${DRIFT_ENVS[@]}"');
    // The drive needs phase 1's prefix and ripgrep, or it would fetch them offline.
    expect(playback).toContain(
      "DRIFT_ENVS=(-e npm_config_prefix=/drift/prefix -e npm_config_cache=/drift/npm-cache -e HKN_RIPGREP_DIR=/drift/ripgrep)",
    );
    expect(phase2).toContain('export PATH="$npm_config_prefix/bin:$PATH"');
    // Docker writes a --dns-option unchecked, so the check proves it took effect.
    expect(phase2).toMatch(
      /node scripts\/assert-no-network\.mjs --offline --require-env HOOKNOSTIC_PLAYBACK_VERSION,HKN_RIPGREP_DIR --dns-timeout 0\r?\n/,
    );
    expect(phase2.indexOf("assert-no-network.mjs --offline")).toBeLessThan(phase2.indexOf("drive-capture-session.mjs"));
    expect(phase2).toContain("-e HKN_NO_NETWORK_UID=1000 -e HOOKNOSTIC_PLAYBACK_NETWORK=none");
    expect(phase2).not.toContain("--network bridge");
  });

  it("publish-verdict is the single final writer gated on detect", () => {
    const publish = jobSource("publish-verdict");
    expect(publish).toMatch(/needs: \[detect, record, report-failure, drift\]/);
    expect(publish).toMatch(
      /if: \$\{\{ always\(\) && needs\.detect\.result == 'success' && needs\.detect\.outputs\.count != '0' && inputs\.dry_run != 'true' \}\}/,
    );
    expect(publish).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write\s*\n\s*pull-requests: write/);
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

  it("routes drift for an out-of-range build to its open range-extension issue", () => {
    // record files the range-extension issue in the same run (publish-verdict
    // needs record), so a drift verdict without a PR or failure issue must
    // land there instead of opening a second thread for the same version.
    const rangeTitle =
      'TITLE="harness-watch: ${{ matrix.harness }} ${{ matrix.latest }} is outside every profile range"';
    expect(jobSource("record")).toContain(rangeTitle);
    const publish = jobSource("publish-verdict");
    const destination = publish.slice(
      publish.indexOf("Locate the conversation destination"),
      publish.indexOf("File a deduped report issue"),
    );
    expect(destination).toContain(rangeTitle.replace('TITLE="', 'RANGE_TITLE="'));
    // Exact-title match: gh's --search is fuzzy and also matches bodies.
    expect(destination).toContain(`jq -r --arg t "$RANGE_TITLE" 'map(select(.title == $t)) | .[0].number // ""'`);
    const failure = destination.indexOf("failed model-free playback");
    const range = destination.indexOf("RANGE_TITLE=");
    expect(failure).toBeGreaterThan(-1);
    expect(range).toBeGreaterThan(failure);
  });

  it("drift report issue names the verdict's real transport", () => {
    const publish = jobSource("publish-verdict");
    const report = publish.slice(
      publish.indexOf("File a deduped report issue"),
      publish.indexOf("Comment the verdict on the destination"),
    );
    expect(report).not.toContain("'see artifact'");
    expect(report).toContain('TRANSPORT="$(jq -r .transport drift-verdict-${{ matrix.harness }}.json)"');
    expect(report).toContain("(transport: \\`$TRANSPORT\\`");
  });

  it("escapes every backtick inside unquoted heredocs", () => {
    // An unquoted heredoc runs command substitution, so a bare `path` in an
    // issue body executes the path and posts an empty string in its place.
    const lines = source.split(/\r?\n/);
    const bodies = [];
    for (let i = 0; i < lines.length; i++) {
      const open = /<<-?\s*([A-Za-z_]+)\b/.exec(lines[i]);
      if (!open) continue;
      const end = lines.findIndex((l, j) => j > i && l.trim() === open[1]);
      bodies.push({ at: i + 1, text: lines.slice(i + 1, end) });
      i = end;
    }
    expect(bodies.length).toBeGreaterThan(0);
    for (const { at, text } of bodies) {
      for (const line of text)
        expect(line.replace(/\$\([^)]*\)/g, ""), `heredoc at line ${at}`).not.toMatch(/(^|[^\\])`/);
    }
  });

  it("merges in one trusted coordinator after verification and drift publishing", () => {
    expect(jobSource("record")).not.toContain("gh pr merge");
    const merge = jobSource("automerge");
    expect(merge).toContain("needs: [detect, verify, record, drift, publish-verdict]");
    expect(merge).toContain("needs.publish-verdict.result == 'success'");
    expect(merge).toContain("vars.HARNESS_WATCH_AUTOMERGE == 'true'");
    expect(merge).not.toContain("strategy:");
    expect(merge).toContain("ref: ${{ github.sha }}");
    expect(merge).toContain("persist-credentials: false");
    expect(merge).toContain("GH_TOKEN: ${{ secrets.HARNESS_WATCH_PAT }}");
    expect(merge).toContain("pattern: watch-outcome-*");
    expect(merge).toContain("pattern: drift-verdict-*");
    expect(merge).toContain("WATCH_FORCE_DRIFT: ${{ inputs.force_llm }}");
    expect(merge).toContain("node scripts/merge-harness-watch.mjs watch-evidence");
  });

  it("preserves the recorder's independent date for later coordinator retries", () => {
    const record = jobSource("record");
    expect(record).toContain('DATE="$(date -u +%F)"');
    expect(record).toContain('echo "date=$DATE" >> "$GITHUB_OUTPUT"');
    expect(record).toContain('--date "$DATE"');
    const evidence = record.slice(record.indexOf("Save trusted recorder evidence"));
    expect(evidence).toContain("steps.record.outputs.outcome == 'wrote'");
    expect(evidence).toContain('--arg date "${{ steps.record.outputs.date }}"');
    expect(evidence).toContain("name: watch-record-${{ matrix.harness }}-${{ matrix.latest }}");
    expect(evidence).toContain("retention-days: 90");
    const merge = jobSource("automerge");
    expect(merge).toContain("actions: read");
    expect(merge).toContain("WATCH_EVIDENCE_TOKEN: ${{ github.token }}");
  });
});
