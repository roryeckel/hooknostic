import { existsSync, readFileSync, realpathSync } from "node:fs";
import Module from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildOptions, ImportKind, Plugin, PluginBuild, ResolveResult } from "esbuild";
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

interface Manifest {
  name?: unknown;
  version?: unknown;
  peerDependencies?: { zod?: unknown };
}

/** The manifest at `path`; an unreadable or non-object one names nothing. */
function readManifest(path: string): Manifest {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof manifest === "object" && manifest !== null ? (manifest as Manifest) : {};
  } catch {
    return {};
  }
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
      // An unreadable manifest names nothing; keep walking, as for a nameless one.
      const manifest = readManifest(path);
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

/** The `zod` package a bare `zod` import from a directory reaches. */
export type ReachableZod =
  | { kind: "none" }
  /** A Yarn Plug'n'Play manifest: PnP or `node_modules` may serve the import, so let esbuild's resolution decide. */
  | { kind: "pnp" }
  /** `version` only when the package's manifest names itself `zod`, unlike an npm alias installed as zod. */
  | { kind: "found"; directory: string; version?: string };

/**
 * The PnP manifests esbuild looks for. esbuild searches for one once, walking
 * up from the build's working directory (see {@link sdkZodFallbackPlugin});
 * {@link reachableZod} also checks each importer's ancestors, as a fallback.
 */
const PNP_MANIFESTS = [".pnp.data.json", ".pnp.cjs", ".pnp.js"];

/** The nearest PnP manifest in `directory` or one of its ancestors, as esbuild finds it. */
function pnpManifest(directory: string): string | undefined {
  for (let current = directory; ;) {
    const manifest = PNP_MANIFESTS.find((name) => existsSync(join(current, name)));
    if (manifest !== undefined) return join(current, manifest);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * HN110 when the CLI running a build and the project's `@hooknostic/sdk` are
 * on different releases: the build would mix one release's SDK with another
 * release's compiler and shims (#194).
 *
 * `sdkEntry` is the SDK entry the build resolves; its package's own manifest
 * gives the version. `cliVersion` is passed in rather than imported, because
 * `build.ts` imports this module through `bundle.ts`. Any difference in
 * version counts, prereleases included, because the two packages are released
 * in lockstep; build metadata (`+local.1`) is ignored, as semver orders it.
 * With no SDK, or a version on either side that is not semver, there is
 * nothing to compare, and the check stays silent. So does the Hooknostic
 * workspace, by lockstep rather than detection: its SDK is `packages/sdk`, at
 * the CLI's version.
 */
export function sdkReleaseSkew(
  sdkEntry: string | undefined,
  cliVersion: string,
  projectDirectory: string,
): Diagnostic | undefined {
  if (sdkEntry === undefined) return undefined;
  const sdk = owningManifest(sdkEntry, new Map());
  if (sdk?.name !== SDK || sdk.version === undefined) return undefined;
  if (semver.valid(sdk.version) === null || semver.valid(cliVersion) === null) return undefined;
  if (semver.eq(sdk.version, cliVersion)) return undefined;
  // npx runs the project's CLI only when the project installs one; without it,
  // and always under Plug'n'Play, where npx does not see the project's install
  // (as HN504 explains), it fetches the registry's latest instead.
  const remediation =
    pnpManifest(projectDirectory) !== undefined
      ? `add hooknostic to the project's devDependencies at the same version as its ${SDK}, ` +
        "and run `yarn hooknostic`, which runs that CLI (under Plug'n'Play, npx fetches the registry's latest)."
      : `add hooknostic to the project's devDependencies at the same version as its ${SDK}, ` +
        "and run `npx hooknostic` from the project directory, which then runs that CLI " +
        "(without a local install, npx fetches the registry's latest).";
  return {
    code: "HN110",
    severity: "warn",
    message:
      `this hooknostic is ${cliVersion}, but the project's ${SDK} at ${shownPath(sdk.directory, projectDirectory)} ` +
      `is ${sdk.version}, so the build mixes one release's SDK with another release's compiler and shims; ` +
      "run the project's own hooknostic, or install both at one version.",
    remediation,
  };
}

/**
 * `directory` as HN110 names it: relative to the config's directory, with
 * forward slashes and saying so, when that directory contains it, because the
 * build report that carries the message may be committed, and an absolute path
 * differs by machine and can name a home directory. Otherwise absolute. The
 * SDK's path is real (Node resolves symlinks), so the project's real path is
 * tried too.
 */
function shownPath(directory: string, projectDirectory: string): string {
  let real = projectDirectory;
  try {
    real = realpathSync.native(projectDirectory);
  } catch {
    // A project directory that cannot be resolved is compared as given.
  }
  for (const base of [projectDirectory, real]) {
    const path = relative(base, directory);
    if (path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      return `${path.replaceAll("\\", "/")} (relative to the config's directory)`;
  }
  return directory;
}

/** A path inside a Yarn zip archive or virtual folder (Yarn 2's `$$virtual`, Yarn 3+'s `__virtual__`). */
export const PNP_PATH = /\.zip[\\/]|[\\/](?:__virtual__|\$\$virtual)[\\/]/;

/**
 * The `detail` of an esbuild error meaning that Yarn Plug'n'Play serves a
 * module this process cannot read. `bundleRuntime` turns such a build failure
 * into one HN504.
 */
export const PNP_RUNTIME_REQUIRED = "hooknostic-pnp-runtime-required";

/** What to do about an HN504, as an esbuild note. */
const PNP_RUNTIME_NOTE = {
  text:
    "Run Hooknostic through Yarn from the project: add hooknostic to its devDependencies and run `yarn hooknostic`. " +
    "npx, a global install, pnpm dlx and yarn dlx do not load the project's Plug'n'Play runtime.",
};

/**
 * Fail a build that would read a module from Yarn Plug'n'Play's install when
 * this process cannot: Hooknostic is running under plain `node`, not through
 * Yarn's runtime (#183). esbuild reads Yarn's zip archives itself, so the
 * bundle would otherwise build, but everything Hooknostic reads beside it --
 * the SDK's manifest for its Zod fallback, licence notices, the project's SDK
 * -- comes back missing, and the artifact silently comes out wrong.
 *
 * It costs nothing under Yarn's runtime (`process.versions.pnp`) or outside a
 * PnP project, and it refuses only a path the process cannot see: a real
 * directory whose name ends in `.zip`, or a stray ancestor manifest above a
 * `node_modules` project, never fires it.
 */
export function pnpRuntimeGuardPlugin(): Plugin {
  return {
    name: "hooknostic-pnp-runtime",
    setup(build) {
      if (process.versions.pnp !== undefined) return;
      const manifest = pnpManifest(build.initialOptions.absWorkingDir ?? process.cwd());
      if (manifest === undefined) return;
      build.onLoad({ filter: PNP_PATH, namespace: "file" }, (args) => {
        if (existsSync(args.path)) return undefined;
        return {
          errors: [
            {
              text:
                `Yarn Plug'n'Play serves ${args.path} from its install (${manifest}), and this process cannot ` +
                "read it: Hooknostic is running without Yarn's PnP runtime.",
              detail: PNP_RUNTIME_REQUIRED,
              notes: [PNP_RUNTIME_NOTE],
            },
          ],
        };
      });
    },
  };
}

/** The part of Yarn's PnP API this module asks: which package a path belongs to. */
interface PnpApi {
  findPackageLocator(location: string): unknown;
}

/**
 * Whether Hooknostic's own Zod failed to resolve because Hooknostic itself
 * runs from a Yarn install that the project's PnP manifest does not list, as
 * under `yarn dlx`. esbuild reads one PnP manifest per build, the project's,
 * so nothing installed beside the CLI resolves from it.
 *
 * A Hooknostic in a zip is not enough to say so: under `yarn hooknostic`
 * the CLI is in the project's own install, and a failure there has another
 * cause, which esbuild's own error states. Under Yarn's runtime, which
 * `yarn dlx` also loads (its own, not the project's), `module.findPnpApi`
 * returns the API that serves Hooknostic -- it asks the loaded APIs first,
 * so this holds in a global cache too -- and only an API that does not list
 * the project means another install.
 */
export function ownZodNeedsProjectInstall(
  pnpProject: boolean,
  ownDirectory: string,
  projectDirectory: string,
): boolean {
  if (!pnpProject || !PNP_PATH.test(ownDirectory)) return false;
  const findPnpApi =
    process.versions.pnp === undefined
      ? undefined
      : (Module as { findPnpApi?: (location: string) => PnpApi | null }).findPnpApi;
  // No API to ask: without Yarn's runtime nothing installed in a zip could be
  // running this, and Yarn 2 sets process.versions.pnp but has no
  // findPnpApi. Either way the zip path is all there is to go on.
  if (findPnpApi === undefined) return true;
  let own: PnpApi | null;
  try {
    own = findPnpApi(ownDirectory);
  } catch {
    // Yarn throws when several loaded APIs control the CLI's zip, which
    // implies the project's lists it: keep esbuild's error.
    return false;
  }
  return own === null || own.findPackageLocator(projectDirectory) === null;
}

/**
 * Walk the `node_modules` lookup path from `directory`, as esbuild does for a
 * bare specifier: each ancestor's `node_modules/zod`, skipping ancestors that
 * are themselves named `node_modules`. The first one found is the package
 * esbuild resolves `zod/v4` against -- it does not walk on when that package's
 * exports map lacks the subpath -- so its manifest is the version to check,
 * including a Zod 3.24 that has no `./v4`. Pass the importer's real path
 * (esbuild resolves symlinks), which puts pnpm's `.pnpm/<sdk>/node_modules` on
 * the path. `require.resolve("zod/package.json")` would not do: Zod 3.0-3.8
 * export no `./package.json`, and Node's CommonJS lookup adds `NODE_PATH` and
 * global folders that esbuild does not search.
 */
export function reachableZod(directory: string): ReachableZod {
  for (let current = directory; ;) {
    if (PNP_MANIFESTS.some((manifest) => existsSync(join(current, manifest)))) return { kind: "pnp" };
    if (basename(current) !== "node_modules") {
      const candidate = join(current, "node_modules", "zod");
      if (existsSync(candidate)) {
        const manifest = readManifest(join(candidate, "package.json"));
        return {
          kind: "found",
          directory: candidate,
          ...(manifest.name === "zod" && typeof manifest.version === "string" ? { version: manifest.version } : {}),
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { kind: "none" };
    current = parent;
  }
}

const FALLBACK = "hooknostic-sdk-zod-fallback";
/** Where Hooknostic's own dependencies resolve: the CLI's `dist`, or core's `src` in the workspace. */
const OWN_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * Hooknostic's own Zod, by the directory it resolves from (the install, unless
 * a test places one), import kind and path, for the life of the process:
 * the CLI's install does not change under a running CLI. A cached file that has
 * since disappeared is resolved again.
 */
const ownResolutions = new Map<string, ResolveResult>();

/** Whether an esbuild `alias` map redirects a zod import. */
function aliasesZod(alias: Record<string, string> | undefined): boolean {
  return Object.keys(alias ?? {}).some((key) => key === "zod" || key.startsWith("zod/"));
}

/**
 * The esbuild options that can change what a path resolves to from
 * `OWN_DIRECTORY`: the lookup itself (`conditions`, `mainFields`,
 * `resolveExtensions`, `nodePaths`, `preserveSymlinks`, `platform`), path
 * mapping (`alias`, `tsconfig`, `tsconfigRaw`), and what is bundled at all
 * (`external`, `packages`). `absWorkingDir` moves no lookup that starts from
 * `OWN_DIRECTORY`.
 */
const RESOLUTION_OPTIONS = [
  "alias",
  "conditions",
  "external",
  "mainFields",
  "nodePaths",
  "packages",
  "platform",
  "preserveSymlinks",
  "resolveExtensions",
  "tsconfig",
  "tsconfigRaw",
] as const satisfies readonly (keyof BuildOptions)[];

/**
 * Whether a build may use the process-lifetime cache of Hooknostic's own Zod.
 * The cache key holds only the directory resolved from, an import's kind and
 * its path, so that answer must not
 * depend on the build: each of {@link RESOLUTION_OPTIONS} must be absent, as a
 * key, even one set to its default value. Two exceptions are what
 * `bundleRuntime` sets: `platform` must be `"node"` (an unset one is esbuild's
 * browser default), and an `alias` may map packages other than zod.
 */
function cachesOwnZod(options: BuildOptions): boolean {
  return RESOLUTION_OPTIONS.every((key) => {
    if (key === "platform") return options.platform === "node";
    if (key === "alias") return !aliasesZod(options.alias);
    return !(key in options);
  });
}

/**
 * Resolve `path` from Hooknostic's own install, through the process-lifetime
 * cache when `cache` is set ({@link cachesOwnZod}). A build whose options
 * reshape resolution, as a `zod` alias does, must not cache: a nested resolve
 * applies the alias here too, so that answer holds for that build alone.
 */
async function resolveOwn(
  build: PluginBuild,
  path: string,
  options: { kind: ImportKind; importer: string; pluginData: string },
  cache: boolean,
  ownDirectory: string,
): Promise<ResolveResult> {
  const key = `${ownDirectory}\0${options.kind}\0${path}`;
  const cached = cache ? ownResolutions.get(key) : undefined;
  if (cached !== undefined && existsSync(cached.path)) return cached;
  const own = await build.resolve(path, { ...options, resolveDir: ownDirectory });
  if (cache && own.errors.length === 0) ownResolutions.set(key, own);
  return own;
}

/** A Zod the SDK reached outside its peer range, and the copy bundled instead. */
interface ZodSubstitution {
  range: string;
  /** The real path of the zod package the SDK's import reached, or the resolved file when no manifest owns it. */
  foundPath: string;
  foundVersion?: string;
  ownPath: string;
  ownVersion?: string;
}

/** A Zod the SDK reached that it cannot use: out of its peer range, or versionless. */
interface ReachedZod {
  path: string;
  version?: string;
  range: string;
}

/** "the SDK's zod import reached zod@<version> at <path>" */
function reachedText(reached: { path: string; version?: string }): string {
  const found = reached.version === undefined ? "a zod package with no readable version" : `zod@${reached.version}`;
  return `the SDK's zod import reached ${found} at ${reached.path}`;
}

/** HN109 for one substituted Zod. */
function substitutionDiagnostic(substitution: ZodSubstitution): Diagnostic {
  const reached = reachedText({
    path: substitution.foundPath,
    ...(substitution.foundVersion === undefined ? {} : { version: substitution.foundVersion }),
  });
  const own = substitution.ownVersion === undefined ? "zod" : `zod@${substitution.ownVersion}`;
  return {
    code: "HN109",
    severity: "warn",
    message:
      `${reached}, outside the SDK's zod peer range ` +
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
 * import made by the SDK that cannot use the project's Zod resolves from here
 * instead.
 *
 * An optional peer also means nothing stops a package manager from handing the
 * SDK an older Zod: npm with `legacy-peer-deps` hoists one that the project
 * inherited from an unrelated dependency beside it without a peer conflict,
 * and pnpm links a project's own Zod 3 as the peer with only a warning. The
 * SDK's import then resolves from here too, and `onSubstitution` receives an
 * HN109 warning rather than the build failing. The range comes from the SDK's
 * own manifest. A manifest whose range is not a semver range -- the
 * workspace's `catalog:` reference, which only `pnpm pack` rewrites -- has no
 * floor to enforce, and the reached Zod is used as is.
 *
 * The version checked is the one {@link reachableZod} reads, before anything
 * resolves, from the zod package the SDK's import reaches: the package esbuild
 * takes that import from, whether or not it provides `zod/v4`. So a Zod 3.24
 * without the subpath is out of range and reported, and only a project with no
 * reachable Zod stays silent. An in-range Zod is left to esbuild untouched:
 * reading one manifest replaces a nested `build.resolve()`, which cost more
 * than everything else this plugin does.
 *
 * Two cases resolve first instead and read the version from the resolved
 * file's package, as this plugin always did. Under a Yarn Plug'n'Play
 * manifest, found as esbuild finds it, from the build's working directory, the
 * walk cannot tell whether PnP or `node_modules` serves the SDK's import:
 * esbuild falls back to `node_modules` for an importer the manifest does not
 * know. And a build whose options change what a bare `zod`
 * reaches -- an `alias` with a zod key, `nodePaths` or `preserveSymlinks` --
 * cannot be modelled by the walk: esbuild (0.28) applies `alias` only after
 * `onResolve` callbacks have seen the import as written, while a nested
 * `build.resolve()` does apply it. When the import itself fails there, the
 * package's root, which every Zod exports, names the Zod it reached.
 *
 * Hooknostic's own Zod resolves once per directory resolved from, import kind
 * and path for the life of the process ({@link resolveOwn}), so a Zod-free project pays one nested
 * resolve, in its first bundle. Reports stay per build: `build.ts` dedupes
 * them across one build's targets, and a later build must warn again.
 *
 * Only the SDK's own imports are redirected. A project whose Zod satisfies the
 * range keeps one shared copy, the one its SDK resolves; user code that imports
 * Zod resolves it the normal way, and without one installed still fails, as it
 * does when the entry is evaluated.
 *
 * `options.ownDirectory` stands in for where Hooknostic's own dependencies
 * resolve, so tests can place that install, as `yarn dlx` does.
 */
export function sdkZodFallbackPlugin(
  onSubstitution: (diagnostic: Diagnostic) => void = () => {},
  options: { ownDirectory?: string } = {},
): Plugin {
  const ownDirectory = options.ownDirectory ?? OWN_DIRECTORY;
  return {
    name: FALLBACK,
    setup(build) {
      const manifests = new Map<string, OwningManifest | undefined>();
      const reported = new Set<string>();
      const { absWorkingDir, alias, nodePaths, preserveSymlinks } = build.initialOptions;
      const optionsResolveFirst = aliasesZod(alias) || (nodePaths?.length ?? 0) > 0 || preserveSymlinks === true;
      const projectDirectory = absWorkingDir ?? process.cwd();
      // esbuild looks for a PnP manifest once, walking up from the working
      // directory. Once it finds one, an importer the manifest has a locator
      // for resolves through PnP and any other falls back to node_modules,
      // and the walk cannot tell which serves the SDK's import: resolve first.
      const pnpProject = pnpManifest(projectDirectory) !== undefined;
      // Every resolve-first option is also a resolution option, so a build
      // that resolves first never caches.
      const cacheable = cachesOwnZod(build.initialOptions);
      build.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        // `<stdin>` (the generated shim entry) is no path, and no package owns it.
        if (args.pluginData === FALLBACK || !isAbsolute(args.importer)) return undefined;
        const sdk = owningManifest(args.importer, manifests);
        if (sdk?.name !== SDK) return undefined;
        const options = { kind: args.kind, importer: args.importer, pluginData: FALLBACK };
        const range = sdk.zodPeer !== undefined && semver.validRange(sdk.zodPeer) !== null ? sdk.zodPeer : undefined;
        const reachable: ReachableZod | undefined = optionsResolveFirst
          ? undefined
          : pnpProject
            ? { kind: "pnp" }
            : reachableZod(args.resolveDir);
        let found: ReachedZod | undefined;
        let direct: ResolveResult | undefined;
        if (reachable === undefined || reachable.kind === "pnp") {
          direct = await build.resolve(args.path, { ...options, resolveDir: args.resolveDir });
          if (direct.errors.length === 0 && range === undefined) return direct;
          if (range !== undefined) {
            // A Zod too old for zod/v4 fails that import, but every published
            // Zod exports its root (3.0-3.8 as `{import, require}`), so the
            // root names the package the import reached. Only a failed import
            // pays for this second resolve.
            const resolved =
              direct.errors.length === 0
                ? direct
                : args.path === "zod"
                  ? undefined
                  : await build.resolve("zod", { ...options, resolveDir: args.resolveDir });
            if (resolved !== undefined && resolved.errors.length === 0) {
              const owner = owningManifest(resolved.path, manifests);
              const version = owner?.name === "zod" ? owner.version : undefined;
              // A prerelease is outside the range, as a package manager would
              // treat it. An in-range Zod whose import failed is broken, and
              // fails with esbuild's own error, as on the walk path.
              if (version !== undefined && semver.satisfies(version, range))
                return direct.errors.length === 0 ? direct : { errors: direct.errors };
              found = {
                // The package directory, as the walk reports, whatever its name.
                path: owner?.directory ?? resolved.path,
                ...(version === undefined ? {} : { version }),
                range,
              };
            }
          }
        } else if (reachable.kind === "found") {
          // In range, or no floor to enforce: esbuild resolves it as it would without this plugin.
          if (range === undefined || (reachable.version !== undefined && semver.satisfies(reachable.version, range)))
            return undefined;
          // The real path, as esbuild names a resolved package: pnpm's store entry, not a link to it.
          found = {
            path: realpathSync.native(reachable.directory),
            ...(reachable.version === undefined ? {} : { version: reachable.version }),
            range,
          };
        }
        const own = await resolveOwn(build, args.path, options, cacheable, ownDirectory);
        if (own.errors.length > 0) {
          // Not a broken CLI: one this project's install cannot see (HN504).
          if (ownZodNeedsProjectInstall(pnpProject, ownDirectory, projectDirectory)) {
            return {
              errors: [
                {
                  text:
                    `Hooknostic's own zod, which the SDK needs here, did not resolve from ${ownDirectory}: ` +
                    "Hooknostic runs from a Yarn install that this project's Plug'n'Play manifest does not list, " +
                    "as under yarn dlx.",
                  detail: PNP_RUNTIME_REQUIRED,
                  notes: [PNP_RUNTIME_NOTE],
                },
              ],
            };
          }
          // With an out-of-range Zod, never bundle it: a CLI that cannot
          // resolve its own dependency is broken. Say which Zod needed it.
          if (found !== undefined) {
            const note = {
              text:
                `${reachedText(found)}, outside the SDK's zod peer range ${found.range}, ` +
                `and Hooknostic's own zod, which would replace it, did not resolve from ${ownDirectory}.`,
            };
            return { errors: own.errors.map((error) => ({ ...error, notes: [...error.notes, note] })) };
          }
          // With no Zod at all, report the project-side failure: that is the
          // resolution a reader can act on.
          direct ??= await build.resolve(args.path, { ...options, resolveDir: args.resolveDir });
          return { errors: direct.errors.length > 0 ? direct.errors : own.errors };
        }
        if (found !== undefined && !reported.has(found.path)) {
          reported.add(found.path);
          const mine = owningManifest(own.path, manifests);
          onSubstitution(
            substitutionDiagnostic({
              range: found.range,
              foundPath: found.path,
              ...(found.version === undefined ? {} : { foundVersion: found.version }),
              ownPath: mine?.directory ?? own.path,
              ...(mine?.version === undefined ? {} : { ownVersion: mine.version }),
            }),
          );
        }
        return own;
      });
    },
  };
}
