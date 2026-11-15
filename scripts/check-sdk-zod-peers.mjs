import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  const result = await runProcess(command, args, { cwd, timeoutMs: 120_000 });
  if (!result.ok) throw new Error(`${command} failed (${result.exitCode}): ${result.stdout}${result.stderr}`);
}

/** A consumer project with a strict tsconfig that also checks the SDK's declarations. */
async function consumerProject(parent, dependencies, source) {
  const project = await mkdtemp(join(parent, "consumer-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
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

  // The SDK alone, its optional peer not installed: the root must type-check
  // with library checking on and run, while the schemas subpath cannot load.
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
} finally {
  await rm(directory, { recursive: true, force: true });
}
