import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

import { isMainModule } from "./is-main-module.mjs";

/** Select only the latest push run of CI on the requested commit, including reruns. */
export function ciState(runs, sha) {
  const run = runs
    .filter((run) => run.head_sha === sha && run.event === "push" && run.path === ".github/workflows/ci.yml")
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt || b.id - a.id)[0];
  if (!run || run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "success" : "failed";
}

export async function waitForCI({
  repo,
  sha,
  attempts = 40,
  intervalMs = 30_000,
  query = queryRuns,
  sleep = setTimeout,
  log = console.log,
}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = ciState(await query(repo, sha), sha);
    log(`CI at ${sha}: ${state} (${attempt + 1}/${attempts})`);
    if (state === "success") return;
    if (state === "failed") throw new Error(`CI failed at ${sha}; rerun CI successfully before retrying the draft.`);
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for CI at ${sha}`);
}

function queryRuns(repo, sha) {
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=100`,
      ],
      { encoding: "utf8" },
    ),
  );
  return pages.flatMap((page) => page.workflow_runs);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [repo, sha] = process.argv.slice(2);
  if (!repo || !sha) throw new Error("usage: wait-for-ci.mjs owner/repo sha");
  await waitForCI({ repo, sha });
}
