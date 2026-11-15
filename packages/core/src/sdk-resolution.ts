import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "esbuild";

const SDK = "@hooknostic/sdk";
/** SDK subpath entries, named for their source module beside the root `index` entry. */
const SDK_SUBPATHS = ["schemas"] as const;

/**
 * Complete an `@hooknostic/sdk` alias with the SDK's subpath entries.
 *
 * esbuild resolves a subpath of an aliased package by appending it to the
 * alias target, so mapping `@hooknostic/sdk` to its entry FILE sends
 * `@hooknostic/sdk/schemas` to `<entry>/schemas`, which does not exist. When the
 * target is the SDK's `index` module, the subpath entry is its sibling of the
 * same extension -- true of both the built `dist/` and the workspace `src/` --
 * so add that alias unless the caller supplied one. Any other alias, such as a
 * package name, already resolves subpaths the normal way.
 */
export function withSdkSubpathAliases(alias: Record<string, string>): Record<string, string> {
  const root = alias[SDK];
  if (root === undefined || !isAbsolute(root)) return alias;
  const extension = extname(root);
  if (basename(root, extension) !== "index") return alias;
  const completed = { ...alias };
  for (const subpath of SDK_SUBPATHS) {
    const entry = join(dirname(root), `${subpath}${extension}`);
    if (completed[`${SDK}/${subpath}`] === undefined && existsSync(entry)) completed[`${SDK}/${subpath}`] = entry;
  }
  return completed;
}

const packageNames = new Map<string, string | undefined>();

/** Name of the package that owns `file`, from its nearest named manifest. */
function owningPackage(file: string): string | undefined {
  let directory = dirname(file);
  const visited: string[] = [];
  let name: string | undefined;
  for (;;) {
    if (packageNames.has(directory)) {
      name = packageNames.get(directory);
      break;
    }
    visited.push(directory);
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name as string | undefined;
      } catch {
        name = undefined;
      }
      // Nested manifests that only set the module type (zod/v3) name nothing.
      if (typeof name === "string") break;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      name = undefined;
      break;
    }
    directory = parent;
  }
  for (const seen of visited) packageNames.set(seen, name);
  return name;
}

const FALLBACK = "hooknostic-sdk-zod-fallback";
/** Where Hooknostic's own dependencies resolve: the CLI's `dist`, or core's `src` in the workspace. */
const OWN_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * Let the SDK's schemas find Zod when the project has none.
 *
 * Every runtime artifact validates handler effects with `@hooknostic/sdk/schemas`,
 * which imports Zod, but Zod is only an optional peer of the SDK (ADR-0040): a
 * project that authors hooks without it installs none, and a strict package
 * manager then gives the project's SDK no Zod to resolve. The compiler always
 * has one -- the published CLI depends on Zod -- so a Zod import made by the
 * SDK that cannot resolve from the SDK resolves from here instead.
 *
 * Only the SDK's own imports fall back. A project that installs Zod keeps one
 * shared copy, the one its SDK resolves; user code that imports Zod without
 * installing it still fails, as it does when the entry is evaluated.
 */
export function sdkZodFallbackPlugin(): Plugin {
  return {
    name: FALLBACK,
    setup(build) {
      build.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        // `<stdin>` (the generated shim entry) is no path, and no package owns it.
        if (args.pluginData === FALLBACK || !isAbsolute(args.importer)) return undefined;
        if (owningPackage(args.importer) !== SDK) return undefined;
        const options = { kind: args.kind, importer: args.importer, pluginData: FALLBACK };
        const direct = await build.resolve(args.path, { ...options, resolveDir: args.resolveDir });
        if (direct.errors.length === 0) return direct;
        const own = await build.resolve(args.path, { ...options, resolveDir: OWN_DIRECTORY });
        // Report the project-side failure: that is the resolution a reader can act on.
        return own.errors.length === 0 ? own : { errors: direct.errors };
      });
    },
  };
}
