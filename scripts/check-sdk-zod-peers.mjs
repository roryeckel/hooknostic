import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import semver from "semver";

import { runProcess } from "../packages/sdk/dist/index.js";
import { inventory } from "./check-dependencies.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const compiler = resolve(dirname(require.resolve("@typescript/native/package.json")), "bin/tsc");
const range = inventory().find((dep) => dep.depType === "pnpm.catalog.zod-peer" && dep.depName === "zod")?.currentValue;
assert.ok(range, "Zod peer catalog is missing");
const versions = range.split("||").map((part) => {
  const minimum = semver.minVersion(part.trim());
  assert.ok(minimum, `Invalid Zod peer range: ${part}`);
  return minimum.version;
});

const consumer = `import { z } from "zod/v4";
import { effectSchema, toolInvocationSchema } from "@hooknostic/sdk/schemas";

const sdkSchema: z.ZodType = toolInvocationSchema;
const nested = z.object({ tool: toolInvocationSchema.extend({ label: z.string() }), effect: effectSchema });
const value = nested.parse({
  tool: { kind: "other", nativeName: "probe", input: null, label: "ok" },
  effect: { kind: "block", reason: "example" },
});
if (value.tool.label !== "ok" || !sdkSchema.safeParse({ kind: "other", nativeName: "probe", input: null }).success)
  throw new Error("Schema composition changed");
const failed = toolInvocationSchema.safeParse({ kind: "other", nativeName: 1, input: null });
if (failed.success || !(failed.error instanceof z.ZodError) || "errors" in failed.error ||
    failed.error.issues[0]?.code !== "invalid_type") throw new Error("V4 error compatibility changed");
`;

// Hook authoring needs no Zod (ADR-0040): this compiles and runs with no zod installed.
const zodFreeConsumer = `import { block, definePlugin, hook, updateShell } from "@hooknostic/sdk";

const plugin = definePlugin({
  name: "zod-free",
  hooks: [
    hook("tool.before", {
      id: "shell-guard",
      match: { kind: "shell" },
      capabilities: { block: "required", "input.replace": "optional" },
      run({ tool }, ctx) {
        const command = tool.shell?.command ?? "";
        if (command.includes("rm -rf /")) return block("refused");
        if (ctx.capabilities.has("input.replace")) return updateShell({ command: command.replace(/^npm /, "pnpm ") });
      },
    }),
  ],
});
if (plugin.hooks[0]?.capabilities["tool.before.block"] !== "required") throw new Error("Authoring API changed");
`;

async function run(command, args, cwd) {
  const result = await runProcess(command, args, { cwd, timeoutMs: 240_000 });
  if (!result.ok) throw new Error(`${command} failed (${result.exitCode}): ${result.stdout}${result.stderr}`);
  return result;
}

/** Version of the package whose manifest `specifier` names, resolved from `from`. */
function installedVersion(specifier, from) {
  const path = createRequire(join(from, "package.json")).resolve(specifier);
  return { path, version: JSON.parse(readFileSync(path, "utf8")).version };
}

// The consumers live outside the repository, where `pnpm` would otherwise be
// whatever version is installed globally. Naming the repository's own lets
// pnpm switch to it, so a pnpm consumer installs as the pinned pnpm does.
const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.match(packageManager, /^pnpm@/, "the repository must pin pnpm");

/** A consumer project with a strict tsconfig that also checks the SDK's declarations. */
async function consumerProject(parent, dependencies, source) {
  const project = await mkdtemp(join(parent, "consumer-"));
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ private: true, type: "module", packageManager, dependencies }),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "NodeNext", target: "ES2022", outDir: "out", skipLibCheck: false },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(join(project, "consumer.ts"), source);
  return project;
}

/**
 * A project with the basic example's config and hooks, for the packed CLI to
 * check and build. `manifest` adds fields, such as the pinned packageManager
 * for a project pnpm installs.
 */
async function exampleProject(parent, prefix, dependencies, manifest = {}) {
  const project = await mkdtemp(join(parent, prefix));
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ private: true, type: "module", ...manifest, dependencies }),
  );
  await mkdir(join(project, "src"));
  await writeFile(
    join(project, "hooknostic.config.ts"),
    readFileSync(join(root, "examples/basic/hooknostic.config.ts"), "utf8"),
  );
  await writeFile(join(project, "src/hooks.ts"), readFileSync(join(root, "examples/basic/src/hooks.ts"), "utf8"));
  return project;
}

const temporaryRoot = await realpath(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "hooknostic-zod-peers-"));
assert.equal(dirname(directory), temporaryRoot);
assert.ok(basename(directory).startsWith("hooknostic-zod-peers-"));
try {
  await run("pnpm", ["--filter", "@hooknostic/sdk", "pack", "--pack-destination", directory], root);
  const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const sdk = pathToFileURL(join(directory, tarballs[0])).href;
  for (const version of versions) {
    // One fresh install per peer floor: a cached SDK copy can hide duplicate types.
    const project = await consumerProject(directory, { "@hooknostic/sdk": sdk, zod: version }, consumer);
    await run("pnpm", ["install", "--ignore-scripts"], project);
    await run(process.execPath, [compiler, "-p", join(project, "tsconfig.json")], root);
    await run(process.execPath, [join(project, "out/consumer.js")], project);
    console.log(`Packed SDK with Zod ${version}: types, composition and V4 errors passed`);
  }

  // The SDK alone, its peer not installed, as Yarn or pnpm without auto-installed
  // peers leaves it: the root must type-check with library checking on and
  // run, while the schemas subpath cannot load.
  const zodFree = await consumerProject(directory, { "@hooknostic/sdk": sdk }, zodFreeConsumer);
  await run("pnpm", ["install", "--ignore-scripts", "--config.auto-install-peers=false"], zodFree);
  await run(process.execPath, [compiler, "-p", join(zodFree, "tsconfig.json")], root);
  await run(process.execPath, [join(zodFree, "out/consumer.js")], zodFree);
  const schemas = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", 'await import("@hooknostic/sdk/schemas");'],
    { cwd: zodFree, timeoutMs: 30_000 },
  );
  assert.ok(
    !schemas.ok && schemas.stderr.includes("Cannot find package 'zod'"),
    `Without zod, @hooknostic/sdk/schemas must fail to load: ${schemas.stdout}${schemas.stderr}`,
  );
  console.log("Packed SDK without Zod: root types and authoring API passed; schemas subpath needs Zod");

  // An npm project that declares no Zod but inherits zod@3.25.76 from an
  // unrelated dependency, hoisted beside the SDK (below), so the SDK's schemas
  // can reach it. GHSA-mrhx-c7xc-m3w5
  // affects that release's own v4 entry: the build must bundle an in-range Zod
  // and warn HN109 instead (ADR-0040). The CLI is installed on its own, as a
  // global or `npx` CLI is: in the project's tree its Zod satisfies the SDK's
  // peer edge too, and npm would hoist that one instead.
  await run("pnpm", ["--filter", "hooknostic", "pack", "--pack-destination", directory], root);
  const cliTarball = (await readdir(directory)).find((name) => /^hooknostic-\d.*\.tgz$/.test(name));
  assert.ok(cliTarball, "CLI tarball is missing");
  const tarball = (name) => pathToFileURL(join(directory, name)).href;
  const cliInstall = await mkdtemp(join(directory, "npm-cli-"));
  await writeFile(
    join(cliInstall, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@hooknostic/sdk": sdk, hooknostic: tarball(cliTarball) },
      // The CLI's own SDK dependency is this release; take it from the same tarball.
      overrides: { "@hooknostic/sdk": "$@hooknostic/sdk" },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], cliInstall);
  const pinned = await mkdtemp(join(directory, "pinned-zod-"));
  await writeFile(
    join(pinned, "package.json"),
    JSON.stringify({
      name: "@example/pinned-zod",
      version: "1.0.0",
      main: "index.js",
      dependencies: { zod: "3.25.76" },
    }),
  );
  await writeFile(join(pinned, "index.js"), "module.exports = {};");
  await run("pnpm", ["pack", "--pack-destination", directory], pinned);
  const pinnedTarball = (await readdir(directory)).find((name) => name.startsWith("example-pinned-zod-"));
  assert.ok(pinnedTarball, "pinned-zod tarball is missing");
  const npmProject = await exampleProject(directory, "npm-consumer-", {
    "@example/pinned-zod": tarball(pinnedTarball),
    "@hooknostic/sdk": sdk,
  });
  // npm's default peer handling installs an in-range Zod for the SDK's peer
  // once any Zod is in the tree, nesting the old one. Projects that set
  // legacy-peer-deps (npm 3-6 behaviour, still common in .npmrc) ignore the
  // peer, and npm hoists zod@3.25.76 beside the SDK with no ERESOLVE.
  await run("npm", ["install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"], npmProject);
  // The layout under test, asserted rather than assumed: the old Zod is hoisted
  // and reachable from the SDK, and the CLI's in-range Zod is its own.
  const sdkDirectory = join(npmProject, "node_modules/@hooknostic/sdk");
  const reached = installedVersion("zod/package.json", sdkDirectory);
  assert.equal(reached.version, "3.25.76", `the SDK must reach the hoisted Zod, got ${reached.path}`);
  assert.equal(dirname(reached.path), join(npmProject, "node_modules/zod"));
  const cliZod = installedVersion("zod/package.json", join(cliInstall, "node_modules/hooknostic"));
  assert.ok(semver.satisfies(cliZod.version, range), `the CLI's Zod ${cliZod.version} must satisfy ${range}`);
  const cli = join(cliInstall, "node_modules/hooknostic/bin/hooknostic.mjs");
  const warning = /^HN109 SDK's Zod outside its peer range \[warn\]$/m;

  /**
   * `check` and `build` in `project` must warn HN109 once, naming
   * `zod@<version>` at `foundPath`, and the artifacts must carry the CLI's Zod
   * rather than that one. Returns the reported diagnostic.
   */
  async function assertSubstituted(project, version, foundPath) {
    const named = `the SDK's zod import reached zod@${version} at ${foundPath}`;
    let reported = "";
    for (const command of ["check", "build"]) {
      const output = (await run(process.execPath, [cli, command, "--config", "hooknostic.config.ts"], project)).stdout;
      assert.match(output, warning, `${command} must warn HN109:\n${output}`);
      assert.ok(output.includes(named), `${command}'s HN109 must name the found Zod:\n${output}`);
      assert.ok(output.includes(`Hooknostic's own zod@${cliZod.version}`), `${command} must name the bundled Zod`);
      assert.equal(output.match(/^HN109 /gm).length, 1, `${command} reports HN109 once, not per target`);
      reported = output
        .slice(output.search(warning))
        .split(/\n(?=HN\d{3} |PASS |BUILT |FAIL )/)[0]
        .trim();
    }
    for (const artifact of ["dist/claude/runtime/hooknostic.mjs", "dist/codex/.codex/hooknostic/hooknostic.mjs"]) {
      const code = readFileSync(join(project, artifact), "utf8");
      assert.ok(code.includes(`zod@${cliZod.version}`), `${artifact} must carry the CLI's Zod notice`);
      // pnpm names the SDK's store entry after its linked peer
      // (`@hooknostic+sdk@<v>_zod@3.24.4`), so the SDK's own module paths
      // mention that version. Nothing else may: no notice, no module.
      const withoutSdkPaths = code.replace(/@hooknostic\+sdk@[^/"\s]*_zod@[^/"\s]*\//g, "");
      assert.ok(!withoutSdkPaths.includes(`zod@${version}`), `${artifact} must not bundle zod@${version}`);
      assert.doesNotMatch(
        code,
        /^\/\/ node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?zod\//m,
        `${artifact} must not bundle the project's Zod`,
      );
    }
    return reported;
  }

  const reportedNpm = await assertSubstituted(npmProject, "3.25.76", join(npmProject, "node_modules", "zod"));
  console.log(
    `npm consumer with a hoisted zod@3.25.76: bundled zod@${cliZod.version} and warned HN109\n\n${reportedNpm}`,
  );

  // The documented install, the CLI and the SDK in one project, then a Zod
  // outside the SDK's peer range added to it. npm must refuse with ERESOLVE.
  // While the peer was optional, npm 7.24.2 and later looped here instead,
  // printing "ERESOLVE overriding peer dependency" until killed (#240). A loop
  // trips the output limit or the timeout, and runProcess kills its tree.
  const downgrade = await mkdtemp(join(directory, "npm-downgrade-"));
  await writeFile(
    join(downgrade, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: { "@hooknostic/sdk": sdk, hooknostic: tarball(cliTarball) },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], downgrade);
  // The layout under test: the CLI's in-range Zod, hoisted to the root, is
  // what the replacement must displace, and the CLI's edge to the SDK is
  // served by the hoisted SDK, not a nested copy: that non-root edge into the
  // SDK is one of the loop's three conditions.
  const hoisted = installedVersion("zod/package.json", downgrade);
  assert.equal(dirname(hoisted.path), join(downgrade, "node_modules", "zod"));
  assert.ok(semver.satisfies(hoisted.version, range), `the hoisted Zod ${hoisted.version} must satisfy ${range}`);
  assert.ok(
    !existsSync(join(downgrade, "node_modules", "hooknostic", "node_modules", "@hooknostic", "sdk")),
    "the CLI must share the hoisted SDK, not nest its own",
  );
  const older = "3.23.8";
  assert.ok(!semver.satisfies(older, range), `zod@${older} must fall outside ${range}`);
  const replace = await runProcess(
    "npm",
    ["install", "--save-dev", `zod@${older}`, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: downgrade, timeoutMs: 120_000 },
  );
  const replaceOutput = `${replace.stdout}${replace.stderr}`;
  const overrides = replaceOutput.split("ERESOLVE overriding peer dependency").length - 1;
  assert.equal(
    replace.failure,
    undefined,
    `npm install zod@${older} must end on its own, not loop (#240): ${replace.failure?.message}; ` +
      `${overrides} "overriding peer dependency" warnings`,
  );
  // npm's own error code line, not "could not resolve", which the loop's
  // warnings print as well.
  assert.ok(
    !replace.ok && /^npm error code ERESOLVE$/m.test(replaceOutput),
    `npm install zod@${older} must fail with ERESOLVE (exit ${replace.exitCode}):\n${replaceOutput}`,
  );
  console.log(`npm downgrade to zod@${older}: refused with ERESOLVE (exit ${replace.exitCode}), no loop`);

  // A pnpm project that declares zod@3.24.4 itself: pnpm links it as the SDK's
  // peer with only a warning. That release predates `zod/v4`, so the
  // SDK's import cannot resolve against it, yet the build must still name it
  // in HN109 rather than fall back silently (ADR-0040).
  const pnpmProject = await exampleProject(
    directory,
    "pnpm-consumer-",
    { "@hooknostic/sdk": sdk, zod: "3.24.4" },
    { packageManager },
  );
  await run("pnpm", ["install", "--ignore-scripts"], pnpmProject);
  // pnpm records the version that laid out node_modules in .modules.yaml
  // (JSON content under pnpm 12, which is also YAML).
  const modules = readFileSync(join(pnpmProject, "node_modules/.modules.yaml"), "utf8");
  const installedBy = /^\s*"?packageManager"?\s*:\s*"?(pnpm@[^"\s,]+)/m.exec(modules)?.[1];
  assert.equal(
    installedBy,
    packageManager.split("+")[0],
    "the pnpm consumer must install with the repository's pinned pnpm",
  );
  // The layout under test, asserted rather than assumed: from its real path in
  // pnpm's store, the SDK reaches the project's Zod, which exports no ./v4.
  const pnpmSdk = await realpath(join(pnpmProject, "node_modules/@hooknostic/sdk"));
  const pnpmZod = join(pnpmProject, "node_modules", ".pnpm", "zod@3.24.4", "node_modules", "zod");
  assert.equal(await realpath(join(dirname(dirname(pnpmSdk)), "zod")), pnpmZod, "the SDK must reach the project's Zod");
  const pnpmZodManifest = JSON.parse(readFileSync(join(pnpmZod, "package.json"), "utf8"));
  assert.equal(pnpmZodManifest.version, "3.24.4");
  assert.ok(!("./v4" in pnpmZodManifest.exports), "zod@3.24.4 must not export ./v4");
  const reportedPnpm = await assertSubstituted(pnpmProject, "3.24.4", pnpmZod);
  console.log(`pnpm consumer with zod@3.24.4: bundled zod@${cliZod.version} and warned HN109\n\n${reportedPnpm}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
