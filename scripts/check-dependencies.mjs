import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

// Reuse the workspace's existing YAML parser; this script runs after install.
const { parse } = createRequire(new URL("../packages/agent-plugin/package.json", import.meta.url))("yaml");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
export const nodeFiles = Object.fromEntries(
  ["ci", "playback", "publishing"].map((role) => [role, `.github/node/${role}/.node-version`]),
);

export function checkEngines(manifests) {
  const requirement = manifests["package.json"]?.engines?.node;
  if (!requirement) throw new Error("Root Node engine requirement is missing");
  for (const [path, pkg] of Object.entries(manifests)) {
    if (pkg.engines?.node !== requirement) throw new Error(`${path}: Node engine must agree with root ${requirement}`);
  }
}

export function inventory(root = repoRoot) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const paths = [
    "package.json",
    ...["packages", "examples"].flatMap((dir) =>
      readdirSync(resolve(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${dir}/${entry.name}/package.json`),
    ),
  ];
  const manifests = Object.fromEntries(paths.map((path) => [path, JSON.parse(read(path))]));
  checkEngines(manifests);
  const workspace = parse(read("pnpm-workspace.yaml"));
  const catalogs = { default: workspace.catalog, ...workspace.catalogs };
  const expected = [];
  const add = (manager, packageFile, depName, currentValue, depType = "") =>
    expected.push({ manager, packageFile, depName, currentValue, depType });
  for (const [name, dependencies] of Object.entries(catalogs)) {
    for (const [dep, range] of Object.entries(dependencies))
      add("npm", "pnpm-workspace.yaml", dep, range, `pnpm.catalog.${name}`);
  }
  for (const [path, pkg] of Object.entries(manifests)) {
    for (const section of dependencySections) {
      for (const [dep, ref] of Object.entries(pkg[section] ?? {})) {
        if (ref.startsWith("workspace:")) continue;
        if (!ref.startsWith("catalog:") || !catalogs[ref.slice(8) || "default"]?.[dep]) {
          throw new Error(`${path}: ${dep} must resolve through a workspace catalog`);
        }
      }
    }
  }
  // This standalone, installable runtime uses npm's native manifest/lock pair,
  // not pnpm workspace/catalog protocols. Renovate must discover it separately.
  const runtimePath = "examples/agent-plugin/runtime/package.json";
  const runtime = JSON.parse(read(runtimePath));
  const runtimeLock = JSON.parse(read("examples/agent-plugin/runtime/package-lock.json"));
  for (const section of dependencySections) {
    for (const [dep, value] of Object.entries(runtime[section] ?? {})) {
      if (/^(catalog:|workspace:)/.test(value) || runtimeLock.packages?.[""]?.[section]?.[dep] !== value) {
        throw new Error(`Standalone runtime requirement/lock mismatch: ${dep}`);
      }
      add("npm", runtimePath, dep, value, section);
    }
  }
  const pin = manifests["package.json"].packageManager;
  if (!/^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\..+)?$/.test(pin)) throw new Error("Root pnpm pin is missing");
  add("npm", "package.json", "pnpm", pin.slice(5).split("+")[0], "packageManager");
  for (const path of Object.values(nodeFiles)) {
    const value = read(path).trim();
    if (!/^\d+(?:\.\d+\.\d+)?$/.test(value)) throw new Error(`${path}: invalid Node version`);
    add("nodenv", path, "node", value);
  }
  const workflowDir = ".github/workflows";
  for (const name of readdirSync(resolve(root, workflowDir)).filter((name) => /\.ya?ml$/.test(name))) {
    const path = `${workflowDir}/${name}`;
    const source = read(path);
    if (/node:\d|litellm\[proxy\]==\d/.test(source)) throw new Error(`${path}: embedded tooling pin`);
    const workflow = parse(source);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (job.container?.image) {
        const image = /^(.*):([^:]+)$/.exec(job.container.image);
        if (!image) throw new Error(`${path}: unversioned tooling container`);
        add("github-actions", path, image[1], image[2], "container");
      }
      const role =
        name === "release-publish.yml"
          ? "publishing"
          : ["harness-playback", "verify", "drift"].includes(jobName)
            ? "playback"
            : "ci";
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith("./")) continue;
        const [dep, value] = step.uses.split("@");
        if (!value) throw new Error(`${path}: unversioned Action`);
        add("github-actions", path, dep, value, "action");
        if (
          dep === "actions/setup-node" &&
          (step.with?.["node-version-file"] !== nodeFiles[role] || "node-version" in (step.with ?? {}))
        ) {
          throw new Error(`${path}/${jobName}: use the ${role} Node version file`);
        }
        if (dep === "pnpm/action-setup" && step.with?.version !== undefined)
          throw new Error(`${path}: duplicated pnpm pin`);
      }
    }
  }
  const watch = read(".github/workflows/harness-watch.yml");
  if (
    !watch.includes("$(cat .github/requirements/litellm.txt)") ||
    !watch.includes("$(cat .github/node/playback/.node-version)") ||
    !watch.includes('"node:${PLAYBACK_NODE}-bookworm"')
  )
    throw new Error("Relocated tooling files are not consumed");
  const requirement = read(".github/requirements/litellm.txt").trim();
  const match = /^litellm\[proxy\](==\d+\.\d+\.\d+)$/.exec(requirement);
  if (!match) throw new Error("Expected one pinned LiteLLM proxy requirement");
  add("pip_requirements", ".github/requirements/litellm.txt", "litellm", match[1]);
  return expected;
}

export function checkExtraction(expected, packageFiles) {
  const key = (dep) => JSON.stringify([dep.manager, dep.packageFile, dep.depName, dep.currentValue, dep.depType ?? ""]);
  const wanted = new Set(expected.map(key));
  const found = new Set();
  const allowedFiles = new Set([...expected.map((dep) => dep.packageFile)]);
  for (const [manager, files] of Object.entries(packageFiles)) {
    for (const file of files) {
      // npm emits references and manual engines for workspace manifests too;
      // their own package version is release data, never an updatable dep.
      if (
        !allowedFiles.has(file.packageFile) &&
        !(manager === "npm" && /^(packages|examples)\/[^/]+\/package\.json$/.test(file.packageFile))
      ) {
        throw new Error(`Unexpected extracted file: ${file.packageFile}`);
      }
      for (const dep of file.deps) {
        if (manager === "npm" && (dep.depType === "engines" || /^(catalog:|workspace:)/.test(dep.currentValue)))
          continue;
        if (manager === "github-actions" && dep.depType === "github-runner" && dep.currentValue === "latest") continue;
        const record = { ...dep, manager, packageFile: file.packageFile };
        if (!wanted.has(key(record))) throw new Error(`Unexpected extracted dependency: ${key(record)}`);
        // Token-free extraction still discovers Action refs. Lookups require
        // the hosted app's GitHub token; no token is needed to prove discovery.
        if (dep.skipReason && dep.skipReason !== "github-token-required")
          throw new Error(`Skipped dependency: ${key(record)}`);
        found.add(key(record));
      }
    }
  }
  for (const dep of wanted) if (!found.has(dep)) throw new Error(`Missing extracted dependency: ${dep}`);
  return { dependencies: found.size, managers: [...new Set(expected.map((dep) => dep.manager))] };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const expected = inventory();
  if (process.argv[2]) {
    const logs = readFileSync(process.argv[2], "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const files = logs.filter((entry) => entry.packageFiles).at(-1)?.packageFiles;
    if (!files) throw new Error("Renovate extraction log contains no packageFiles");
    console.log(checkExtraction(expected, files));
  } else console.log(`Dependency ownership and engines agree; ${expected.length} maintained references inventoried.`);
}
