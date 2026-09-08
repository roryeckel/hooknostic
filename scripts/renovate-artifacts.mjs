import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

export const outputRoots = ["examples/rewrite-shell/dist", "examples/agent-plugin/dist"];
export const manifestLimit = 32 * 1024 * 1024;
export const artifactName = "renovate-example-artifacts";
export const workflowPath = ".github/workflows/renovate-artifacts.yml";

export function assertOutputPath(path) {
  if (typeof path !== "string" || path.length > 500 ||
      !outputRoots.some((root) => path.startsWith(`${root}/`)) ||
      !path.split("/").every((part) => /^[A-Za-z0-9_.@+-]+$/.test(part) &&
        ![".", "..", ".git"].includes(part.toLowerCase()) && !part.endsWith(".") &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Disallowed output path: ${String(path)}`);
  }
}

export function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{40}$/.test(manifest.headSha) ||
      !Number.isSafeInteger(manifest.pr) || manifest.pr < 1 ||
      !Array.isArray(manifest.files) || manifest.files.length > 500) {
    throw new Error("Malformed artifact manifest");
  }
  const names = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    assertOutputPath(file.path);
    const name = file.path.toLowerCase();
    if (names.has(name)) throw new Error("Duplicate output path");
    names.add(name);
    if (typeof file.content !== "string" ||
        Buffer.from(file.content, "base64").toString("base64") !== file.content) {
      throw new Error("Malformed base64 content");
    }
    bytes += file.content.length;
    if (bytes > manifestLimit) throw new Error("Artifact manifest is too large");
  }
  for (const name of names) {
    const parts = name.split("/");
    while (parts.pop() && parts.length) {
      if (names.has(parts.join("/"))) throw new Error("Conflicting output paths");
    }
  }
  return manifest;
}

export function collectManifest(root, headSha, pr) {
  const files = [];
  function visit(path) {
    const info = lstatSync(resolve(root, path));
    if (info.isDirectory()) {
      for (const name of readdirSync(resolve(root, path)).sort()) visit(`${path}/${name}`);
    } else {
      assertOutputPath(path);
      if (!info.isFile()) throw new Error(`Output must be a regular file: ${path}`);
      files.push({ path, content: readFileSync(resolve(root, path)).toString("base64") });
    }
  }
  for (const path of outputRoots) visit(path);
  return validateManifest({ format: 1, headSha, pr, files });
}

export function verifyOrigin({ repository, run, workflow, jobs, pr, manifest }) {
  validateManifest(manifest);
  if (workflow.path !== workflowPath || run.workflow_id !== workflow.id ||
      run.path !== workflowPath || run.event !== "pull_request" ||
      run.status !== "completed" || run.conclusion !== "success" ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.head_sha !== manifest.headSha ||
      !run.pull_requests?.some((item) => item.number === manifest.pr) ||
      !jobs.some((job) => job.name === "generate" && job.status === "completed" && job.conclusion === "success")) {
    throw new Error("Untrusted or unsuccessful originating workflow");
  }
  if (pr.number !== manifest.pr || pr.user?.login !== "renovate[bot]" || pr.user?.type !== "Bot" ||
      pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository ||
      !/^renovate\/[A-Za-z0-9_./-]+$/.test(pr.head?.ref ?? "") ||
      pr.head.ref !== run.head_branch) {
    throw new Error("Not a same-repository Renovate PR and branch");
  }
  // Closed PRs and new heads are normal races, not write failures.
  return pr.state === "open" && pr.head.sha === manifest.headSha;
}

export function gitBlobSha(content) {
  const bytes = Buffer.from(content, "base64");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function planChanges(manifest, tree) {
  validateManifest(manifest);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Incomplete git tree");
  const current = new Map();
  for (const entry of tree.tree) {
    // Also reject symlink/gitlink ancestors of the permitted output roots.
    if (outputRoots.some((root) => root === entry.path || root.startsWith(`${entry.path}/`)) &&
        entry.type !== "tree") throw new Error("Non-directory output ancestor");
    if (!outputRoots.some((root) => entry.path.startsWith(`${root}/`))) continue;
    assertOutputPath(entry.path);
    if (entry.type === "tree") continue;
    if (entry.type !== "blob" || entry.mode !== "100644") throw new Error("Non-regular output in git tree");
    current.set(entry.path, entry.sha);
  }
  const additions = [];
  for (const file of manifest.files) {
    if (current.get(file.path) !== gitBlobSha(file.content)) additions.push({ path: file.path, contents: file.content });
    current.delete(file.path);
  }
  const deletions = [...current.keys()].map((path) => ({ path }));
  return { additions, deletions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, headSha, number] = process.argv.slice(2);
  const root = fileURLToPath(new URL("../", import.meta.url));
  writeFileSync(destination, `${JSON.stringify(collectManifest(root, headSha, Number(number)))}\n`);
}
