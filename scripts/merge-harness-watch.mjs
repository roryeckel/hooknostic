// Run only trusted base-branch code. PR contents are compared as text, never executed.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import semver from "semver";

import { harnessLanes } from "./harness-lanes.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { rewriteRollingRecord, ROLLING_WHAT } from "./record-playback-validation.mjs";

const DOC = "docs/harness-support.md";

function rollingRecord(source) {
  const region = source.split("// scheduled-playback:begin")[1]?.split("// scheduled-playback:end")[0];
  const version = region?.match(/version: "([^"]+)"/)?.[1];
  const date = region?.match(/date: "(\d{4}-\d{2}-\d{2})"/)?.[1];
  if (!semver.valid(version) || !date) throw new Error("Missing rolling version/date; manual review required");
  return { version, date };
}

/** Reproduce the recorder's exact change, including its single generated evidence row. */
export function assertValidationOnly({ harness, version, files, beforeProfile, afterProfile, beforeDoc, afterDoc }) {
  const profile = harnessLanes[harness]?.module.slice(3);
  if (!profile || files.length !== 2 || !files.includes(profile) || !files.includes(DOC)) {
    throw new Error("PR must change only its profile and generated support document");
  }
  const previous = rollingRecord(beforeProfile);
  const next = rollingRecord(afterProfile);
  if (next.version !== version || !semver.gt(next.version, previous.version)) {
    throw new Error("PR must advance the verified version");
  }
  if (rewriteRollingRecord(beforeProfile, next) !== afterProfile) {
    throw new Error("Profile contains changes beyond the generated rolling record");
  }
  const row = ({ version, date }) =>
    `| ${version} | ${date} | live-probe | \`.capture/harness-playback\` | ${ROLLING_WHAT} |`;
  // An ambiguous or first-ever row needs human review rather than a guessed section.
  if (beforeDoc.split(row(previous)).length !== 2 || beforeDoc.replace(row(previous), row(next)) !== afterDoc) {
    throw new Error("Document contains changes beyond the generated evidence row");
  }
}

export function assertEvidence(entry, outcome, drift, forceDrift = false) {
  if (!harnessLanes[entry.harness] || !semver.valid(entry.latest)) throw new Error("Unknown harness/version");
  if (outcome?.harness !== entry.harness || outcome.latest !== entry.latest || outcome.outcome !== "pass") {
    throw new Error("Missing matching successful playback outcome");
  }
  if (forceDrift || entry.jump !== "patch" || drift !== undefined) {
    if (
      drift?.harness !== entry.harness ||
      drift.latest !== entry.latest ||
      drift.verdict !== "clean" ||
      String(drift.exitCode) !== "0"
    ) {
      throw new Error("Applicable drift must have a matching clean verdict");
    }
  }
}

async function assertDiff(client, pr, entry) {
  const files = await client.files(pr.number);
  const profile = harnessLanes[entry.harness].module.slice(3);
  // Before updating a stale branch, its diff is relative to the merge base,
  // not today's master (which already contains sibling validation updates).
  const base = await client.mergeBase(pr.base.sha, pr.head.sha);
  const [beforeProfile, afterProfile, beforeDoc, afterDoc] = await Promise.all([
    client.content(profile, base),
    client.content(profile, pr.head.sha),
    client.content(DOC, base),
    client.content(DOC, pr.head.sha),
  ]);
  assertValidationOnly({
    harness: entry.harness,
    version: entry.latest,
    files,
    beforeProfile,
    afterProfile,
    beforeDoc,
    afterDoc,
  });
}

function assertIdentity(pr, entry) {
  if (
    pr.state !== "open" ||
    pr.draft ||
    pr.base.ref !== "master" ||
    pr.head.ref !== `harness-watch/${entry.harness}` ||
    pr.head.repo.full_name !== pr.base.repo.full_name ||
    pr.title !== `harness-watch: ${entry.harness} ${entry.latest} playback validation`
  )
    throw new Error("PR identity changed; manual review required");
}

/** Bounded sequential merges preserve strict branch protection as master advances. */
export async function mergeCandidate({ entry, client, attempts = 40, intervalMs = 15_000, sleep = setTimeout }) {
  const prs = await client.find(entry.harness);
  if (prs.length !== 1) throw new Error("Expected exactly one open harness-watch PR");
  const number = prs[0].number;
  let expectedHead;
  let updatingFrom;
  let updates = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pr = await client.pr(number);
    if (pr.merged) return `#${number} already merged`;
    assertIdentity(pr, entry);
    if (updatingFrom) {
      // GitHub's update-branch endpoint is asynchronous (202 Accepted).
      if (pr.head.sha === updatingFrom) {
        if (attempt + 1 < attempts) await sleep(intervalMs);
        continue;
      }
      const commit = await client.commit(pr.head.sha);
      if (commit.parents.length !== 2 || commit.parents[0]?.sha !== updatingFrom) {
        throw new Error("Unexpected head after branch update");
      }
      expectedHead = pr.head.sha;
      updatingFrom = undefined;
    }
    if (expectedHead && pr.head.sha !== expectedHead) throw new Error("PR head changed during verification");
    await assertDiff(client, pr, entry);
    expectedHead = pr.head.sha;
    if (pr.mergeable_state === "dirty") throw new Error("PR has merge conflicts");
    if (pr.mergeable_state === "behind") {
      if (++updates > 3) throw new Error("Base kept moving; retry on the next run");
      await client.update(number, expectedHead);
      // Only our own merge commit may replace the head; it must have the old head
      // as its first parent. A concurrent contributor push is held for review.
      updatingFrom = expectedHead;
    } else if (pr.mergeable_state !== "unknown") {
      const checks = await client.checks(number);
      const failed = checks.some(
        (check) =>
          ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"].includes(check.state) ||
          (check.state === "SKIPPED" && check.name !== "Renovate artifact readiness"),
      );
      if (failed) throw new Error("Required checks failed or were unexpectedly skipped");
      if (checks.length > 0 && checks.every((check) => ["SUCCESS", "SKIPPED"].includes(check.state))) {
        const final = await client.pr(number);
        assertIdentity(final, entry);
        if (final.head.sha !== expectedHead) throw new Error("PR head changed before merge");
        if (final.base.sha !== pr.base.sha || (await client.base()) !== pr.base.sha) {
          // A different merge advanced master during the checks. Revisit branch update.
          continue;
        }
        await assertDiff(client, final, entry);
        const result = await client.merge(number, expectedHead);
        if (!result.merged) throw new Error("GitHub declined the protected merge");
        return `#${number} merged at ${result.sha}`;
      }
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for current required checks");
}

export function githubClient(repo, run = execFileSync) {
  const gh = (args, input, allowCheckExit = false) => {
    let output;
    try {
      output = run("gh", args, { encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input) });
    } catch (error) {
      if (!allowCheckExit || ![1, 8].includes(error.status) || !error.stdout) throw error;
      output = error.stdout;
    }
    return JSON.parse(output);
  };
  const api = (path, method = "GET", body) =>
    gh(["api", `repos/${repo}/${path}`, "--method", method, ...(body ? ["--input", "-"] : [])], body);
  return {
    find: (harness) =>
      api(`pulls?state=open&base=master&head=${encodeURIComponent(`${repo.split("/")[0]}:harness-watch/${harness}`)}`),
    pr: (number) => api(`pulls/${number}`),
    // --paginate handles unexpectedly broad manual edits too; no truncated allowlist.
    files: (number) =>
      gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`])
        .flat()
        .map((file) => file.filename),
    content: (path, sha) => Buffer.from(api(`contents/${path}?ref=${sha}`).content, "base64").toString("utf8"),
    commit: (sha) => api(`commits/${sha}`),
    mergeBase: (base, head) => api(`compare/${base}...${head}`).merge_base_commit.sha,
    base: () => api("git/ref/heads/master").object.sha,
    checks: (number) =>
      gh(["pr", "checks", String(number), "--repo", repo, "--required", "--json", "name,state"], undefined, true),
    update: (number, sha) => api(`pulls/${number}/update-branch`, "PUT", { expected_head_sha: sha }),
    merge: (number, sha) => api(`pulls/${number}/merge`, "PUT", { sha, merge_method: "squash" }),
  };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const repo = process.env.GH_REPO;
  const matrix = JSON.parse(process.env.WATCH_MATRIX);
  const artifacts = process.argv[2];
  if (!repo || !artifacts || !Array.isArray(matrix.include))
    throw new Error("usage: merge-harness-watch.mjs artifacts-directory (GH_REPO, WATCH_MATRIX required)");
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(artifacts, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  for (const entry of matrix.include) {
    let result;
    try {
      assertEvidence(
        entry,
        read(`watch-outcome-${entry.harness}.json`),
        read(`drift-verdict-${entry.harness}.json`),
        process.env.WATCH_FORCE_DRIFT === "true",
      );
      result = await mergeCandidate({ entry, client: githubClient(repo) });
    } catch (error) {
      result = `held for manual review: ${error.message}`;
    }
    const line = `${entry.harness} ${entry.latest}: ${result}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  }
}
