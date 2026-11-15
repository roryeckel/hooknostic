import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "esbuild";
import semver from "semver";

import type { Diagnostic } from "./diagnostics.js";

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

interface OwningManifest {
  /** The directory holding the manifest: the package root. */
  directory: string;
  name: string;
  version?: string;
  /** `peerDependencies.zod`, when the manifest declares one. */
  zodPeer?: string;
}

/**
 * The package that owns `file`: its nearest manifest that has a name.
 * `manifests` caches lookups by directory; each build passes its own, so a
 * long-lived process never reports a Zod version that has since changed.
 */
function owningManifest(file: string, manifests: Map<string, OwningManifest | undefined>): OwningManifest | undefined {
  let directory = dirname(file);
  const visited: string[] = [];
  let found: OwningManifest | undefined;
  for (;;) {
    if (manifests.has(directory)) {
      found = manifests.get(directory);
      break;
    }
    visited.push(directory);
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      let manifest: { name?: unknown; version?: unknown; peerDependencies?: { zod?: unknown } } = {};
      try {
        manifest = JSON.parse(readFileSync(path, "utf8")) as typeof manifest;
      } catch {
        // An unreadable manifest names nothing; keep walking, as for a nameless one.
      }
      // Nested manifests that only set the module type (zod/v3, zod/v4) name nothing.
      if (typeof manifest.name === "string") {
        const zodPeer = manifest.peerDependencies?.zod;
        found = {
          directory,
          name: manifest.name,
          ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
          ...(typeof zodPeer === "string" ? { zodPeer } : {}),
        };
        break;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const seen of visited) manifests.set(seen, found);
  return found;
}

const FALLBACK = "hooknostic-sdk-zod-fallback";
/** Where Hooknostic's own dependencies resolve: the CLI's `dist`, or core's `src` in the workspace. */
const OWN_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** A Zod the SDK reached outside its peer range, and the copy bundled instead. */
interface ZodSubstitution {
  range: string;
  /** The package root the SDK's import resolved into, or the resolved file when no manifest owns it. */
  foundPath: string;
  foundVersion?: string;
  ownPath: string;
  ownVersion?: string;
}

/** HN109 for one substituted Zod. */
function substitutionDiagnostic(substitution: ZodSubstitution): Diagnostic {
  const found =
    substitution.foundVersion === undefined
      ? "a zod package with no readable version"
      : `zod@${substitution.foundVersion}`;
  const own = substitution.ownVersion === undefined ? "zod" : `zod@${substitution.ownVersion}`;
  return {
    code: "HN109",
    severity: "warn",
    message:
      `the SDK's zod import resolved to ${found} at ${substitution.foundPath}, outside the SDK's zod peer range ` +
      `${substitution.range}; the runtime bundles Hooknostic's own ${own} from ${substitution.ownPath} instead, ` +
      "while user code that imports zod still bundles the project's copy.",
    remediation: `install a zod that satisfies ${substitution.range} in the project, so the SDK and user code share one copy.`,
  };
}

/**
 * Let the SDK's schemas find a Zod inside the SDK's peer range.
 *
 * Every runtime artifact validates handler effects with `@hooknostic/sdk/schemas`,
 * which imports Zod, but Zod is only an optional peer of the SDK (ADR-0040): a
 * project that authors hooks without it installs none, and a strict package
 * manager then gives the project's SDK no Zod to resolve. The compiler always
 * has one -- the published CLI depends on Zod from the same range -- so a Zod
 * import made by the SDK that cannot resolve from the SDK resolves from here
 * instead.
 *
 * An optional peer also means nothing stops a package manager from handing the
 * SDK an older Zod that the project inherited from an unrelated dependency:
 * npm with `legacy-peer-deps` hoists one beside it without a peer conflict, and
 * a project rarely controls that dependency. The SDK's import then resolves
 * from here too, and `onSubstitution` receives an HN109 warning rather than the
 * build failing. The range comes
 * from the SDK's own manifest. A manifest whose range is not a semver range --
 * the workspace's `catalog:` reference, which only `pnpm pack` rewrites -- has no
 * floor to enforce, and its resolution is used as before.
 *
 * Only the SDK's own imports are redirected. A project whose Zod satisfies the
 * range keeps one shared copy, the one its SDK resolves; user code that imports
 * Zod resolves it the normal way, and without one installed still fails, as it
 * does when the entry is evaluated.
 */
export function sdkZodFallbackPlugin(onSubstitution: (diagnostic: Diagnostic) => void = () => {}): Plugin {
  return {
    name: FALLBACK,
    setup(build) {
      const manifests = new Map<string, OwningManifest | undefined>();
      const reported = new Set<string>();
      build.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        // `<stdin>` (the generated shim entry) is no path, and no package owns it.
        if (args.pluginData === FALLBACK || !isAbsolute(args.importer)) return undefined;
        const sdk = owningManifest(args.importer, manifests);
        if (sdk?.name !== SDK) return undefined;
        const options = { kind: args.kind, importer: args.importer, pluginData: FALLBACK };
        const direct = await build.resolve(args.path, { ...options, resolveDir: args.resolveDir });
        const range = sdk.zodPeer !== undefined && semver.validRange(sdk.zodPeer) !== null ? sdk.zodPeer : undefined;
        let found: OwningManifest | undefined;
        if (direct.errors.length === 0) {
          if (range === undefined) return direct;
          found = owningManifest(direct.path, manifests);
          // A prerelease is outside the range, as a package manager would treat it.
          if (found?.name === "zod" && found.version !== undefined && semver.satisfies(found.version, range))
            return direct;
        }
        const own = await build.resolve(args.path, { ...options, resolveDir: OWN_DIRECTORY });
        // With no Zod at all, report the project-side failure: that is the
        // resolution a reader can act on. With an out-of-range one, never
        // bundle it: a CLI that cannot resolve its own dependency is broken.
        if (own.errors.length > 0) return { errors: direct.errors.length > 0 ? direct.errors : own.errors };
        if (direct.errors.length === 0 && range !== undefined) {
          const foundPath = found?.name === "zod" ? found.directory : direct.path;
          if (!reported.has(foundPath)) {
            reported.add(foundPath);
            const mine = owningManifest(own.path, manifests);
            onSubstitution(
              substitutionDiagnostic({
                range,
                foundPath,
                ...(found?.name === "zod" && found.version !== undefined ? { foundVersion: found.version } : {}),
                ownPath: mine?.directory ?? own.path,
                ...(mine?.version === undefined ? {} : { ownVersion: mine.version }),
              }),
            );
          }
        }
        return own;
      });
    },
  };
}
