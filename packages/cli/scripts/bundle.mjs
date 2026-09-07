#!/usr/bin/env node
/**
 * Build the publishable `hooknostic` package.
 *
 * The adapters/core/runtime remain internal, so the CLI must be self-contained:
 *
 *   dist/index.js         programmatic API with core + adapters inlined
 *                         (esbuild stays external: it runs at build time)
 *   dist/hooknostic.mjs   the binary, importing ./index.js (no duplicate bundle)
 *   dist/shims/<id>.mjs   each adapter's runtime shim with @hooknostic/runtime
 *                         inlined and @hooknostic/sdk external, so a built
 *                         artifact carries exactly one SDK/zod copy
 *   dist/types/**         declarations for this package plus the workspace
 *                         sources its API exposes, with internal specifiers
 *                         rewritten to relative paths; dist/index.d.ts
 *                         re-exports the CLI entry
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const dist = join(packageDir, "dist");
const require = createRequire(import.meta.url);
const agentPluginRequire = createRequire(resolve(packageDir, "../agent-plugin/package.json"));
const yamlBrowser = resolve(
  dirname(agentPluginRequire.resolve("yaml/package.json")),
  "browser/index.js",
);

/** Adapters whose shims ship inside the CLI; `defaultAdapterRegistry()` routes to them. */
const SHIMS = {
  claude: resolve(packageDir, "../adapter-claude/src/shim.ts"),
  codex: resolve(packageDir, "../adapter-codex/src/shim.ts"),
  opencode: resolve(packageDir, "../adapter-opencode/src/shim.ts"),
};

/** Bare specifiers of workspace packages that are not published. */
const internalSpecifier = () => /(["'])@hooknostic\/(agent-plugin|core|runtime|adapter-[a-z]+)(\/[^"']*)?\1/g;

function fail(message) {
  console.error(`hooknostic bundle: ${message}`);
  process.exit(1);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

const node = { format: "esm", platform: "node", target: "node22", logLevel: "warning" };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Programmatic entry: everything imported is inlined except esbuild.
//    cross-spawn is a registry dependency resolved by the projector at build
//    time and bundled into its emitted MCP launcher, not into this entry.
//    Inlined CommonJS
//    dependencies (npm-package-arg and its tree) `require` Node builtins; in
//    ESM output esbuild routes those through a `__require` shim that throws
//    unless a top-level `require` exists, so the banner provides one.
await build({
  ...node,
  bundle: true,
  entryPoints: [join(packageDir, "src/index.ts")],
  outfile: join(dist, "index.js"),
  external: ["esbuild"],
  alias: { yaml: yamlBrowser },
  banner: {
    js: 'import { createRequire as __hooknosticCreateRequire } from "node:module";\nconst require = __hooknosticCreateRequire(import.meta.url);',
  },
});

// 2. Binary: transpile only; it imports ./index.js.
await build({
  ...node,
  bundle: false,
  entryPoints: [join(packageDir, "src/bin.ts")],
  outfile: join(dist, "hooknostic.mjs"),
});

// 3. Adapter shims.
await build({
  ...node,
  bundle: true,
  entryPoints: SHIMS,
  outdir: join(dist, "shims"),
  outExtension: { ".js": ".mjs" },
  external: ["@hooknostic/sdk"],
});
for (const id of Object.keys(SHIMS)) {
  const code = await readFile(join(dist, "shims", `${id}.mjs`), "utf8");
  const leaked = [...code.matchAll(/\bfrom\s+"(@hooknostic\/(?!sdk")[^"]*)"/g)].map((m) => m[1]);
  if (leaked.length > 0) fail(`dist/shims/${id}.mjs still imports ${leaked.join(", ")}`);
  // esbuild emits this shim when a CommonJS dependency is inlined into ESM
  // output. Such a bundle throws `Dynamic require of "fs" is not supported`
  // the moment Node imports it, so a shim that needs it has pulled in a
  // build-time dependency (typically esbuild, via @hooknostic/core) that a
  // dependency-free runtime artifact must not carry.
  if (code.includes('Dynamic require of "')) {
    fail(
      `dist/shims/${id}.mjs bundles a CommonJS dependency; keep the shim's value imports on @hooknostic/sdk and @hooknostic/runtime`,
    );
  }
}

// 4. Declarations.
const tsc = spawnSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", join(packageDir, "tsconfig.types.json")],
  { stdio: "inherit" },
);
if (tsc.status !== 0) fail("declaration emit failed");

const typesRoot = join(dist, "types");
const declarations = (await walk(typesRoot)).filter((file) => file.endsWith(".d.ts"));
for (const file of declarations) {
  const original = await readFile(file, "utf8");
  const rewritten = original.replace(internalSpecifier(), (_match, quote, name, subpath) => {
    const entry = subpath ? subpath.slice(1) : "index";
    const target = join(typesRoot, "packages", name, "src", `${entry}.js`);
    let specifier = relative(dirname(file), target).split("\\").join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    return `${quote}${specifier}${quote}`;
  });
  if (rewritten !== original) await writeFile(file, rewritten, "utf8");
  if (internalSpecifier().test(rewritten)) {
    fail(`${relative(packageDir, file)} still references an internal workspace package`);
  }
}
const cliEntry = join(typesRoot, "packages/cli/src/index.d.ts");
if (!declarations.includes(cliEntry)) fail(`expected ${cliEntry} to be emitted`);
await writeFile(
  join(dist, "index.d.ts"),
  'export * from "./types/packages/cli/src/index.js";\n',
  "utf8",
);

console.log(
  `hooknostic bundle: dist/index.js, dist/hooknostic.mjs, dist/shims/{${Object.keys(SHIMS).join(",")}}.mjs, ${declarations.length} declaration files`,
);
