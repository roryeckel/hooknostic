import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactName,
  manifestLimit,
  planChanges,
  validateManifest,
  verifyOrigin,
  workflowPath,
} from "./renovate-artifacts.mjs";

// Read one bounded JSON member without extracting any archive paths. Neither
// the downloaded payload nor any code/configuration from the PR is executed.
export function readArchive(archive) {
  if (archive.length > manifestLimit) throw new Error("Artifact archive is too large");
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != "manifest.json" or entries[0].file_size > ${manifestLimit}:
        raise ValueError("Malformed artifact archive")
    sys.stdout.buffer.write(archive.read(entries[0]))
`,
      ],
      { input: archive, maxBuffer: manifestLimit, stdio: ["pipe", "pipe", "pipe"] },
    ).toString("utf8"),
  );
}

export async function applyArtifacts({ repository, runId, attempt, api, download }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(runId) ||
    !Number.isSafeInteger(attempt)
  )
    throw new Error("Invalid workflow identity");
  const repo = `/repos/${repository}`;
  const run = await api(`${repo}/actions/runs/${runId}`);
  if (run.run_attempt !== attempt) return "stale attempt";
  const workflow = await api(`${repo}/actions/workflows/${workflowPath.split("/").at(-1)}`);
  // Establish the run before downloading; verifyOrigin repeats these checks
  // with the payload, PR association, and job result before any mutation.
  if (
    run.workflow_id !== workflow.id ||
    run.path !== workflowPath ||
    run.event !== "pull_request" ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  )
    throw new Error("Untrusted originating workflow");
  const jobs = await api(`${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  if (jobs.total_count > 100) throw new Error("Incomplete job list");
  const artifacts = await api(`${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.artifacts.filter((item) => item.name === artifactName && !item.expired);
  if (artifacts.total_count > 100 || matches.length !== 1 || matches[0].size_in_bytes > manifestLimit) {
    throw new Error("Missing, ambiguous, or oversized artifact");
  }
  const manifest = validateManifest(await download(`${repo}/actions/artifacts/${matches[0].id}/zip`));
  const prPath = `${repo}/pulls/${manifest.pr}`;
  const pr = await api(prPath);
  const origin = { repository, run, workflow, jobs: jobs.jobs, pr, manifest };
  if (!verifyOrigin(origin)) return "stale head or closed PR";
  const tree = await api(`${repo}/git/trees/${manifest.headSha}?recursive=1`);
  const fileChanges = planChanges(manifest, tree);
  if (!fileChanges.additions.length && !fileChanges.deletions.length) return "no changes";
  if (!verifyOrigin({ ...origin, pr: await api(prPath) })) return "stale head or closed PR";
  try {
    // expectedHeadOid is an atomic compare-and-swap. A newer Renovate push
    // cannot be overwritten between the last head check and this mutation.
    await api("/graphql", {
      query: `mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repository, branchName: pr.head.ref },
          expectedHeadOid: manifest.headSha,
          message: { headline: "chore: refresh committed example artifacts" },
          fileChanges,
        },
      },
    });
  } catch (error) {
    if (!verifyOrigin({ ...origin, pr: await api(prPath) })) return "stale head or closed PR";
    throw error;
  }
  return "committed example artifacts";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  async function request(path, body) {
    // The read-only workflow token reads Actions artifacts. Only the final
    // commit API receives the dedicated repository-scoped write credential.
    const token = body ? process.env.RENOVATE_ARTIFACTS_TOKEN : process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Required workflow credential is missing; see docs/dependencies.md");
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`);
    return response;
  }
  const api = async (path, body) => {
    const json = await (await request(path, body)).json();
    if (json.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(json.errors)}`);
    return json;
  };
  const download = async (path) => {
    const response = await request(path);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > manifestLimit) throw new Error("Artifact download is too large");
      chunks.push(chunk);
    }
    return readArchive(Buffer.concat(chunks));
  };
  console.log(
    await applyArtifacts({
      repository: process.env.GITHUB_REPOSITORY,
      runId: event.workflow_run.id,
      attempt: event.workflow_run.run_attempt,
      api,
      download,
    }),
  );
}
