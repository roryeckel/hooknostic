import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { build, type BuildOptions, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";

import { bundleHasMainModuleGuard, bundleRuntime } from "./bundle.js";
import type { Diagnostic } from "./diagnostics.js";
import { reachableZod, sdkZodFallbackPlugin, withSdkSubpathAliases } from "./sdk-resolution.js";

it("executes bundled CommonJS builtins without the source dependency tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-cjs-"));
  try {
    await writeFile(join(root, "helper.cjs"), 'module.exports = () => require("node:path").basename("/tmp/blocked");');
    const result = await bundleRuntime({
      source: 'import helper from "./helper.cjs"; console.log(helper());',
      resolveDir: root,
    });
    await rm(join(root, "helper.cjs"));
    const artifact = join(root, "hook.mjs");
    await writeFile(artifact, result.code);
    expect(execFileSync(process.execPath, [artifact], { encoding: "utf8" }).trim()).toBe("blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("carries dependency license and notice text plus source legal comments through rebundling", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-notices-"));
  try {
    const dependency = join(root, "node_modules/notice-fixture");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "notice-fixture", version: "1.0.0", license: "MIT", main: "index.js" }),
    );
    await writeFile(join(dependency, "index.js"), 'module.exports = require("node:path").basename("/fixture/42");');
    await writeFile(
      join(dependency, "LICENSE"),
      "Copyright Example Author\nPermission is hereby granted, free of charge.\n",
    );
    await writeFile(join(dependency, "NOTICE"), "Example attribution notice.\n");
    const alias = join(root, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const first = await bundleRuntime({
      source: '/*! Keep this source attribution. */\nimport value from "notice-fixture"; console.log(value);',
      resolveDir: alias,
    });
    for (const text of [
      "notice-fixture@1.0.0",
      "Copyright Example Author",
      "Permission is hereby granted, free of charge.",
      "Example attribution notice.",
      "Keep this source attribution.",
    ])
      expect(first.code).toContain(text);
    await writeFile(join(root, "prebundled.mjs"), first.code);
    await rm(join(root, "node_modules"), { recursive: true });
    const second = await bundleRuntime({ source: 'import "./prebundled.mjs";', resolveDir: root });
    expect(second.code).toContain("Copyright Example Author");
    expect(second.code).toContain("Example attribution notice.");
    expect(second.code).toContain("Keep this source attribution.");
    const artifact = join(root, "rebundled.mjs");
    await writeFile(artifact, second.code);
    await rm(join(root, "prebundled.mjs"));
    expect(execFileSync(process.execPath, [artifact], { encoding: "utf8" }).trim()).toBe("42");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("includes the SDK's own license in standalone runtimes as well as third-party licenses", async () => {
  // Every shim validates effects through the /schemas subpath, which is what brings Zod in;
  // the root alias alone must resolve that subpath too.
  const result = await bundleRuntime({
    source:
      'import { block } from "@hooknostic/sdk"; import { effectSchema } from "@hooknostic/sdk/schemas";' +
      ' console.log(effectSchema.parse(block("review")));',
    resolveDir: import.meta.dirname,
    alias: { "@hooknostic/sdk": resolve(import.meta.dirname, "../../sdk/src/index.ts") },
  });
  expect(result.code).toContain(
    (await readFile(resolve(import.meta.dirname, "../../sdk/LICENSE"), "utf8")).replaceAll("\r\n", "\n").trim(),
  );
  const sdkRequire = createRequire(resolve(import.meta.dirname, "../../sdk/package.json"));
  const zodLicense = resolve(sdkRequire.resolve("zod/package.json"), "../LICENSE");
  expect(result.code).toContain((await readFile(zodLicense, "utf8")).replaceAll("\r\n", "\n").trim());
});

/** The `node_modules/zod` that Node resolution from `directory` would reach, if any. */
function strayZod(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, "node_modules/zod"))) return join(current, "node_modules/zod");
    if (dirname(current) === current) return undefined;
  }
}

/**
 * A fresh temporary directory from which no Zod is reachable: a stray Zod in
 * an ancestor of the temporary directory would satisfy imports a test expects
 * to find nothing.
 */
async function zodFreeTemporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  const stray = strayZod(root);
  if (stray !== undefined) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`precondition: no Zod may be reachable from ${tmpdir()}, but ${stray} is`);
  }
  return root;
}

describe("an SDK installed without its optional Zod peer", () => {
  /** The stand-in SDK's declared peer range; the plugin reads it from the manifest. */
  const PEER = "^4.6.7";
  const ownZodManifest = createRequire(import.meta.url).resolve("zod/package.json");
  const ownZodVersion = (JSON.parse(readFileSync(ownZodManifest, "utf8")) as { version: string }).version;

  const link = (target: string, path: string) =>
    symlink(target, path, process.platform === "win32" ? "junction" : "dir");

  /**
   * A recognizable Zod stand-in at `directory`. `version` is `null` for a
   * manifest with none. `v4: false` gives it no `./v4` export and no `v4/`
   * directory, as Zod 3.24 and earlier ship; `exportsMap` replaces the
   * exports map outright.
   */
  async function writeZod(
    directory: string,
    version: string | null,
    options: { v4?: boolean; exportsMap?: Record<string, unknown> } = {},
  ): Promise<void> {
    const v4 = options.v4 !== false;
    await mkdir(v4 ? join(directory, "v4") : directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "zod",
        ...(version === null ? {} : { version }),
        type: "module",
        exports:
          options.exportsMap ??
          (v4
            ? { ".": "./index.js", "./v4": "./v4/index.js" }
            : { ".": "./index.js", "./package.json": "./package.json" }),
      }),
    );
    await writeFile(join(directory, "LICENSE"), "Project zod license.");
    const label = `project zod ${version ?? "unversioned"}: `;
    const string = `export const string = () => ({ min: () => ({ parse: (v) => ${JSON.stringify(label)} + v }) });`;
    await writeFile(join(directory, "index.js"), string);
    if (!v4) return;
    // A nested manifest that only sets the module type, as real Zod ships: it names no version.
    await writeFile(join(directory, "v4/package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "v4/index.js"), string);
  }

  /**
   * A project whose SDK's schemas import Zod, with no Zod of its own unless
   * asked. `zod` names a recognizable stand-in's version (or `null` for a
   * manifest with none), so the output shows whose Zod was bundled. `peer` is
   * the SDK's declared range. `layout: "pnpm"` puts the SDK in a virtual-store
   * entry whose `zod` links the project's, as pnpm links an optional peer;
   * `sdkEntry` then goes through the project's `@hooknostic/sdk` link.
   */
  async function project(
    options: {
      zod?: string | null;
      v4?: boolean;
      exportsMap?: Record<string, unknown>;
      layout?: "npm" | "pnpm";
      peer?: string;
    } = {},
  ): Promise<{ root: string; sdkEntry: string }> {
    // Without a stand-in, "no Zod" must mean none at all.
    const root = await zodFreeTemporaryDirectory("hooknostic-no-zod-");
    const pnpm = options.layout === "pnpm";
    const version = options.zod === undefined ? undefined : (options.zod ?? "unversioned");
    const store = join(root, "node_modules/.pnpm");
    const storeEntry = join(
      store,
      `@hooknostic+sdk@1.0.0${version === undefined ? "" : `_zod@${version}`}/node_modules`,
    );
    const sdk = pnpm ? join(storeEntry, "@hooknostic/sdk") : join(root, "node_modules/@hooknostic/sdk");
    await mkdir(join(sdk, "dist"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@hooknostic/sdk",
        type: "module",
        peerDependencies: { zod: options.peer ?? PEER },
        peerDependenciesMeta: { zod: { optional: true } },
      }),
    );
    await writeFile(join(sdk, "LICENSE"), "Example SDK license.");
    await writeFile(join(sdk, "dist/index.js"), 'export const root = "root";');
    await writeFile(
      join(sdk, "dist/schemas.js"),
      'import * as z from "zod/v4"; export const label = z.string().min(1);',
    );
    const zodOptions = {
      ...(options.v4 === undefined ? {} : { v4: options.v4 }),
      ...(options.exportsMap === undefined ? {} : { exportsMap: options.exportsMap }),
    };
    if (!pnpm) {
      if (options.zod !== undefined) await writeZod(join(root, "node_modules/zod"), options.zod, zodOptions);
      return { root, sdkEntry: join(sdk, "dist/index.js") };
    }
    if (options.zod !== undefined) {
      const zod = join(store, `zod@${version}/node_modules/zod`);
      await writeZod(zod, options.zod, zodOptions);
      await link(zod, join(storeEntry, "zod"));
      await link(zod, join(root, "node_modules/zod"));
    }
    await mkdir(join(root, "node_modules/@hooknostic"), { recursive: true });
    await link(sdk, join(root, "node_modules/@hooknostic/sdk"));
    return { root, sdkEntry: join(root, "node_modules/@hooknostic/sdk/dist/index.js") };
  }

  /**
   * HN109 for an SDK that reached `found` at `at`, bundling Hooknostic's own
   * Zod from `own` (its real path, unless the build preserves symlinks).
   */
  function substitution(found: string, at: string, own = dirname(ownZodManifest)): Diagnostic {
    return {
      code: "HN109",
      severity: "warn",
      message:
        `the SDK's zod import reached ${found} at ${at}, outside the SDK's zod peer range ${PEER}; the runtime ` +
        `bundles Hooknostic's own zod@${ownZodVersion} from ${own} instead, while user code ` +
        "that imports zod still bundles the project's copy.",
      remediation: `install a zod that satisfies ${PEER} in the project, so the SDK and user code share one copy.`,
    };
  }

  const FALLBACK = "hooknostic-sdk-zod-fallback";

  /**
   * Bundle `source` with esbuild directly, a recorder ahead of the fallback
   * plugin: `nested` lists the resolve directory of every nested resolve the
   * fallback makes, which the recorder sees first by its pluginData.
   */
  async function bundleRecorded(
    root: string,
    sdkEntry: string,
    extra: Pick<
      BuildOptions,
      "absWorkingDir" | "alias" | "conditions" | "mainFields" | "nodePaths" | "platform" | "preserveSymlinks"
    > = {},
    source = SOURCE,
  ): Promise<{ code: string; diagnostics: Diagnostic[]; nested: string[] }> {
    const nested: string[] = [];
    const diagnostics: Diagnostic[] = [];
    const recorder: Plugin = {
      name: "recorder",
      setup(recorded) {
        recorded.onResolve({ filter: /^zod(?:\/|$)/ }, (args) => {
          if (args.pluginData === FALLBACK) nested.push(args.resolveDir);
          return undefined;
        });
      },
    };
    const result = await build({
      stdin: { contents: source, resolveDir: root, loader: "ts" },
      absWorkingDir: root,
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
      ...extra,
      alias: withSdkSubpathAliases({ "@hooknostic/sdk": sdkEntry, ...extra.alias }),
      plugins: [recorder, sdkZodFallbackPlugin((diagnostic) => diagnostics.push(diagnostic))],
    });
    return { code: result.outputFiles[0]!.text, diagnostics, nested };
  }

  const SOURCE = 'import { label } from "@hooknostic/sdk/schemas"; console.log(label.parse("ok"));';

  async function run(root: string, code: string): Promise<string> {
    const artifact = join(root, "hook.mjs");
    await writeFile(artifact, code);
    return execFileSync(process.execPath, [artifact], { encoding: "utf8" }).trim();
  }

  it("bundles the SDK's schemas with Hooknostic's own Zod", async () => {
    const { root, sdkEntry } = await project();
    try {
      const result = await bundleRuntime({ source: SOURCE, resolveDir: root, alias: { "@hooknostic/sdk": sdkEntry } });
      expect(await run(root, result.code)).toBe("ok");
      expect(result.code).toContain(
        (await readFile(resolve(ownZodManifest, "../LICENSE"), "utf8")).replaceAll("\r\n", "\n").trim(),
      );
      // A project with no Zod at all is the ordinary case, not a warning.
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the project's Zod, without a warning, when it satisfies the SDK's peer range", async () => {
    const { root, sdkEntry } = await project({ zod: "4.99.0" });
    try {
      const result = await bundleRuntime({ source: SOURCE, resolveDir: root, alias: { "@hooknostic/sdk": sdkEntry } });
      expect(await run(root, result.code)).toBe("project zod 4.99.0: ok");
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const [found, described] of [
    ["3.25.76", "zod@3.25.76"],
    [null, "a zod with no readable version"],
  ] as const) {
    it(`bundles Hooknostic's own Zod, with a warning, when the SDK reaches ${described}`, async () => {
      // An old Zod hoisted from an unrelated dependency: GHSA-mrhx-c7xc-m3w5
      // affects 3.25.76's own v4 entry, which the SDK would otherwise bundle.
      const { root, sdkEntry } = await project({ zod: found });
      try {
        const result = await bundleRuntime({
          source: SOURCE,
          resolveDir: root,
          alias: { "@hooknostic/sdk": sdkEntry },
        });
        expect(await run(root, result.code)).toBe("ok");
        expect(result.code).toContain(`zod@${ownZodVersion}`);
        expect(result.code).not.toContain("Project zod license.");
        const projectZod = join(root, "node_modules", "zod");
        expect(result.diagnostics).toEqual([
          {
            code: "HN109",
            severity: "warn",
            message:
              `the SDK's zod import reached ${found === null ? "a zod package with no readable version" : `zod@${found}`} at ${projectZod}, ` +
              `outside the SDK's zod peer range ${PEER}; the runtime bundles Hooknostic's own zod@${ownZodVersion} ` +
              `from ${dirname(ownZodManifest)} instead, while user code that imports zod still bundles the project's copy.`,
            remediation: `install a zod that satisfies ${PEER} in the project, so the SDK and user code share one copy.`,
          },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("still gives user code the project's out-of-range Zod", async () => {
    const { root, sdkEntry } = await project({ zod: "3.25.76" });
    try {
      const result = await bundleRuntime({
        source: `${SOURCE} import * as z from "zod/v4"; console.log(z.string().min(1).parse("user"));`,
        resolveDir: root,
        alias: { "@hooknostic/sdk": sdkEntry },
      });
      expect((await run(root, result.code)).split(/\r?\n/)).toEqual(["ok", "project zod 3.25.76: user"]);
      expect(result.diagnostics.map((d) => d.code)).toEqual(["HN109"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives user code that imports Zod without installing it no fallback", async () => {
    const { root, sdkEntry } = await project();
    try {
      await expect(
        bundleRuntime({
          source: 'import * as z from "zod/v4"; console.log(z.string().parse("ok"));',
          resolveDir: root,
          alias: { "@hooknostic/sdk": sdkEntry },
        }),
      ).rejects.toThrow(/Could not resolve "zod\/v4"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const layout of ["pnpm", "npm"] as const) {
    it(`warns when the SDK reaches a Zod too old for zod/v4 (${layout})`, async () => {
      // pnpm links the project's Zod 3.24 as the SDK's optional peer; npm hoists
      // it beside the SDK. Either way the SDK's zod/v4 cannot resolve against it.
      const { root, sdkEntry } = await project({ zod: "3.24.4", v4: false, layout });
      try {
        const result = await bundleRuntime({
          source: SOURCE,
          resolveDir: root,
          alias: { "@hooknostic/sdk": sdkEntry },
        });
        expect(await run(root, result.code)).toBe("ok");
        expect(result.code).toContain(`zod@${ownZodVersion}`);
        // The package's real path: pnpm's virtual-store directory, not the project's link.
        const reached =
          layout === "pnpm"
            ? join(root, "node_modules", ".pnpm", "zod@3.24.4", "node_modules", "zod")
            : join(root, "node_modules", "zod");
        expect(result.diagnostics).toEqual([substitution("zod@3.24.4", reached)]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("gives a library's own code its out-of-range Zod while warning once for the SDK's (pnpm)", async () => {
    const { root, sdkEntry } = await project({ zod: "3.24.4", v4: false, layout: "pnpm" });
    try {
      // A hook library that declares the same zod peer as the SDK: only the
      // SDK's name, not a zod peer, makes an import the SDK's.
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "hook-library", type: "module", peerDependencies: { zod: PEER } }),
      );
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src/user.js"),
        'import * as z from "zod"; console.log(z.string().min(1).parse("user"));',
      );
      const result = await bundleRuntime({
        source: `${SOURCE} import "./src/user.js";`,
        resolveDir: root,
        alias: { "@hooknostic/sdk": sdkEntry },
      });
      expect((await run(root, result.code)).split(/\r?\n/)).toEqual(["project zod 3.24.4: user", "ok"]);
      expect(result.diagnostics.map((d) => d.code)).toEqual(["HN109"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays silent when a pnpm SDK has no Zod linked", async () => {
    const { root, sdkEntry } = await project({ layout: "pnpm" });
    try {
      const result = await bundleRuntime({ source: SOURCE, resolveDir: root, alias: { "@hooknostic/sdk": sdkEntry } });
      expect(await run(root, result.code)).toBe("ok");
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an in-range Zod to esbuild, with no nested resolve", async () => {
    const { root, sdkEntry } = await project({ zod: "4.99.0" });
    try {
      const result = await bundleRecorded(root, sdkEntry);
      expect(await run(root, result.code)).toBe("project zod 4.99.0: ok");
      expect(result.diagnostics).toEqual([]);
      expect(result.nested).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Hooknostic's own Zod once per process for a project with none", async () => {
    const { root, sdkEntry } = await project();
    try {
      const first = await bundleRecorded(root, sdkEntry);
      // Only the second build is asserted: an earlier test may already have filled the cache.
      const second = await bundleRecorded(root, sdkEntry);
      expect(second.nested).toEqual([]);
      expect(second.code).toBe(first.code);
      expect(second.diagnostics).toEqual([]);
      expect(await run(root, second.code)).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns in every build, not once per process", async () => {
    const { root, sdkEntry } = await project({ zod: "3.25.76" });
    try {
      for (const round of [1, 2]) {
        const result = await bundleRuntime({
          source: SOURCE,
          resolveDir: root,
          alias: { "@hooknostic/sdk": sdkEntry },
        });
        expect(result.diagnostics, `build ${round}`).toEqual([
          substitution("zod@3.25.76", join(root, "node_modules", "zod")),
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the reached Zod as is when the SDK's peer is not a semver range", async () => {
    // The workspace SDK's `catalog:` reference, which only `pnpm pack` rewrites: no floor to enforce.
    const { root, sdkEntry } = await project({ zod: "3.25.76", peer: "catalog:zod-peer" });
    try {
      const result = await bundleRecorded(root, sdkEntry);
      expect(await run(root, result.code)).toBe("project zod 3.25.76: ok");
      expect(result.diagnostics).toEqual([]);
      expect(result.nested).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the version of a Zod whose exports map hides its manifest", async () => {
    // Zod 3.0-3.8 export neither ./package.json nor ./v4, so
    // require.resolve("zod/package.json") cannot find this manifest.
    const { root, sdkEntry } = await project({
      zod: "3.8.2",
      v4: false,
      exportsMap: { import: "./index.js", require: "./index.js" },
    });
    try {
      const result = await bundleRuntime({ source: SOURCE, resolveDir: root, alias: { "@hooknostic/sdk": sdkEntry } });
      expect(await run(root, result.code)).toBe("ok");
      expect(result.diagnostics).toEqual([substitution("zod@3.8.2", join(root, "node_modules", "zod"))]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("build options that change what a zod import reaches", () => {
    const cases = [
      {
        // The walk would find node_modules' 3.25.76; esbuild applies the alias,
        // after onResolve callbacks have seen "zod/v4" as written.
        name: "an alias with a zod key",
        zod: "3.25.76",
        options: (root: string) => ({ alias: { zod: join(root, "vendor", "zod") } }),
        output: "project zod 4.99.0: ok",
      },
      {
        // The walk finds no Zod at all; esbuild searches nodePaths.
        name: "nodePaths",
        zod: undefined,
        options: (root: string) => ({ nodePaths: [join(root, "vendor")] }),
        output: "project zod 4.99.0: ok",
      },
      {
        name: "preserveSymlinks",
        zod: "4.99.0",
        options: () => ({ preserveSymlinks: true }),
        output: "project zod 4.99.0: ok",
      },
    ];
    for (const { name, zod, options, output } of cases) {
      it(`resolves first under ${name}`, async () => {
        const { root, sdkEntry } = await project(zod === undefined ? {} : { zod });
        try {
          if (zod !== "4.99.0") await writeZod(join(root, "vendor", "zod"), "4.99.0");
          const result = await bundleRecorded(root, sdkEntry, options(root));
          expect(await run(root, result.code)).toBe(output);
          expect(result.diagnostics).toEqual([]);
          // The in-range Zod is found by resolving from the SDK, as esbuild will.
          expect(result.nested).toEqual([join(root, "node_modules", "@hooknostic", "sdk", "dist")]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }

    // zod/v4 fails to resolve against a Zod 3.24, but the package's root still
    // names it: every published Zod exports one.
    it("warns when nodePaths reach a Zod too old for zod/v4", async () => {
      const { root, sdkEntry } = await project();
      try {
        await writeZod(join(root, "vendor", "zod"), "3.24.4", { v4: false });
        const result = await bundleRecorded(root, sdkEntry, { nodePaths: [join(root, "vendor")] });
        expect(await run(root, result.code)).toBe("ok");
        expect(result.diagnostics).toEqual([substitution("zod@3.24.4", join(root, "vendor", "zod"))]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("warns when nodePaths reach a Zod 3.0-3.8 that exports only its root", async () => {
      // Those releases export `{import, require}`: a root and nothing else, not
      // even ./package.json, so only the bare "zod" can name them.
      const { root, sdkEntry } = await project();
      try {
        await writeZod(join(root, "vendor", "zod"), "3.8.2", {
          v4: false,
          exportsMap: { import: "./index.js", require: "./index.js" },
        });
        const result = await bundleRecorded(root, sdkEntry, { nodePaths: [join(root, "vendor")] });
        expect(await run(root, result.code)).toBe("ok");
        expect(result.diagnostics).toEqual([substitution("zod@3.8.2", join(root, "vendor", "zod"))]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("warns when preserveSymlinks reaches a Zod too old for zod/v4", async () => {
      const { root, sdkEntry } = await project({ zod: "3.24.4", v4: false, layout: "pnpm" });
      try {
        const result = await bundleRecorded(root, sdkEntry, { preserveSymlinks: true });
        expect(await run(root, result.code)).toBe("ok");
        // Both Zods keep their linked paths: the SDK's is the project's own
        // link, and Hooknostic's is core's link into the workspace store.
        expect(result.diagnostics).toEqual([
          substitution(
            "zod@3.24.4",
            join(root, "node_modules", "zod"),
            resolve(import.meta.dirname, "..", "node_modules", "zod"),
          ),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("names the reached Zod when an alias leaves Hooknostic's own unresolvable", async () => {
      // esbuild applies an alias to every resolve, Hooknostic's own included, so
      // nothing can supply zod/v4: the build fails, and says why.
      const { root, sdkEntry } = await project();
      try {
        const vendored = join(root, "vendor", "zod");
        await writeZod(vendored, "3.24.4", { v4: false });
        const failure: unknown = await bundleRecorded(root, sdkEntry, { alias: { zod: vendored } }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({
          errors: [
            {
              text: 'Could not resolve "zod/v4"',
              notes: expect.arrayContaining([
                expect.objectContaining({
                  text:
                    `the SDK's zod import reached zod@3.24.4 at ${vendored}, outside the SDK's zod peer range ` +
                    `${PEER}, and Hooknostic's own zod, which would replace it, did not resolve from ` +
                    // Where Hooknostic's dependencies resolve: core's src in the workspace.
                    `${import.meta.dirname}.`,
                }),
              ]),
            },
          ],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("resolves first when the build's working directory is in a Plug'n'Play project", async () => {
    // esbuild looks for the PnP manifest from absWorkingDir, not from each
    // importer. Once one is found, the walk cannot tell whether PnP or
    // node_modules serves the SDK's import, so the plugin resolves first.
    const { root, sdkEntry } = await project({ zod: "4.99.0" });
    try {
      const app = join(root, "app");
      await mkdir(app);
      // esbuild loads an empty manifest and keeps resolving through node_modules.
      await writeFile(join(app, ".pnp.cjs"), "");
      const result = await bundleRecorded(root, sdkEntry, { absWorkingDir: app });
      expect(await run(root, result.code)).toBe("project zod 4.99.0: ok");
      expect(result.diagnostics).toEqual([]);
      expect(result.nested).toEqual([join(root, "node_modules", "@hooknostic", "sdk", "dist")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const uncachedOptions: [string, Pick<BuildOptions, "conditions" | "mainFields" | "platform">][] = [
    ["conditions", { conditions: ["hooknostic-test"] }],
    ["mainFields", { mainFields: ["module", "main"] }],
    ["a browser platform", { platform: "browser" }],
  ];
  for (const [name, options] of uncachedOptions) {
    it(`resolves Hooknostic's own Zod afresh under ${name}`, async () => {
      // The cache is keyed by import kind and path alone, and these options
      // can change what that path resolves to.
      const { root, sdkEntry } = await project();
      try {
        await bundleRecorded(root, sdkEntry, options);
        const second = await bundleRecorded(root, sdkEntry, options);
        expect(second.nested).toEqual([import.meta.dirname]);
        expect(second.diagnostics).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("reachableZod", () => {
  async function zodAt(directory: string, manifest: Record<string, unknown>): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  }

  it("takes the first node_modules/zod on the lookup path, skipping node_modules ancestors", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-reachable-"));
    try {
      await zodAt(join(root, "node_modules/zod"), { name: "zod", version: "2.0.0" });
      await zodAt(join(root, "app/node_modules/zod"), { name: "zod", version: "1.0.0" });
      await mkdir(join(root, "app/src"), { recursive: true });
      expect(reachableZod(join(root, "app/src"))).toEqual({
        kind: "found",
        directory: join(root, "app/node_modules/zod"),
        version: "1.0.0",
      });
      // A package's lookup from inside node_modules never tries node_modules/node_modules.
      await zodAt(join(root, "lib/node_modules/node_modules/zod"), { name: "zod", version: "9.9.9" });
      await mkdir(join(root, "lib/node_modules/pkg"), { recursive: true });
      expect(reachableZod(join(root, "lib/node_modules/pkg"))).toEqual({
        kind: "found",
        directory: join(root, "node_modules/zod"),
        version: "2.0.0",
      });
      // Another package installed under the name zod, as an npm alias does, has no Zod version.
      await zodAt(join(root, "aliased/node_modules/zod"), { name: "not-zod", version: "4.99.0" });
      expect(reachableZod(join(root, "aliased"))).toEqual({
        kind: "found",
        directory: join(root, "aliased/node_modules/zod"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers to Plug'n'Play when a project's PnP manifest comes first", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-reachable-"));
    try {
      await zodAt(join(root, "node_modules/zod"), { name: "zod", version: "2.0.0" });
      for (const marker of [".pnp.cjs", ".pnp.data.json", ".pnp.js"]) {
        const yarn = join(root, marker.replaceAll(".", "-"));
        await mkdir(join(yarn, "src"), { recursive: true });
        await writeFile(join(yarn, marker), "");
        expect(reachableZod(join(yarn, "src")), marker).toEqual({ kind: "pnp" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds none where no zod is on the lookup path", async () => {
    const root = await zodFreeTemporaryDirectory("hooknostic-reachable-");
    try {
      await mkdir(join(root, "app/src"), { recursive: true });
      expect(reachableZod(join(root, "app/src"))).toEqual({ kind: "none" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bundleHasMainModuleGuard", () => {
  it("detects the guard in both operand orderings", () => {
    for (const source of [
      `if (import.meta.url === pathToFileURL(process.argv[1]).href) main();`,
      `if (process.argv[1] === fileURLToPath(import.meta.url)) main();`,
      `if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  main();\n}`,
      `const isMain = import.meta.url == pathToFileURL(process.argv[1]).href;`,
      `if (import.meta.url !== pathToFileURL(process.argv[1]).href) return;`,
      // Minified dependency output keeps the comparison intact.
      `var a=import.meta.url===o(process.argv[1]).href;`,
    ]) {
      expect(bundleHasMainModuleGuard(source), source).toBe(true);
    }
  });

  it("ignores code that merely reads both values", () => {
    for (const source of [
      // Proximity is not a comparison — this was the original false positive.
      `console.log(import.meta.url);\nconst entry = process.argv[1];`,
      `const meta = { url: import.meta.url, entry: process.argv[1] };`,
      `log(import.meta.url, process.argv[1]);`,
      `const dir = dirname(fileURLToPath(import.meta.url));\nconst target = resolve(process.argv[1] ?? ".");`,
      // A comparison, but of a different operand joined by a logical operator.
      `if (process.argv[1] !== undefined && import.meta.url.startsWith("file:")) run();`,
      `if (import.meta.url !== "" || process.argv[1] === "--help") usage();`,
      // Each value compared against something else entirely.
      `if (import.meta.url === base) a();\nif (process.argv[1] === "x") b();`,
    ]) {
      expect(bundleHasMainModuleGuard(source), source).toBe(false);
    }
  });

  it("does not match across a statement boundary", () => {
    expect(bundleHasMainModuleGuard(`const url = import.meta.url;\nif (x === process.argv[1]) run();`)).toBe(false);
  });
});
