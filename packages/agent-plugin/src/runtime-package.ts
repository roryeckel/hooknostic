/**
 * Validation for the npm runtime package a projector may materialize beside a
 * projected plugin: a `package.json` manifest and its `package-lock.json`.
 *
 * The pair is emitted verbatim and installed by the harness with a locked,
 * script-free `npm ci`-style install, so anything `npm ci` would reject must
 * be rejected here, at build time, rather than on the consumer's machine —
 * plus the one thing that install would *accept* and then silently under-do,
 * a package whose lifecycle scripts are skipped (ADR-0012). The rest of the
 * rules are npm's own, taken from its own packages rather than reimplemented:
 * `validate-npm-package-name` for names, `npm-package-arg` (with
 * `hosted-git-info`) to classify every dependency spec, arborist's `dep-valid`
 * — ported below — for whether a lock entry satisfies its spec, and its
 * lockfile validation for a complete locked graph.
 */

import npa from "npm-package-arg";
import semver from "semver";
import validatePackageName from "validate-npm-package-name";

export interface NpmRuntimeManifest {
  dependencies: Record<string, string>;
  [key: string]: unknown;
}

export interface NpmRuntimeLockfile {
  lockfileVersion: 2 | 3;
  packages: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export type NpmRuntimePackageValidation =
  { ok: true; manifest: NpmRuntimeManifest; lockfile: NpmRuntimeLockfile } | { ok: false; error: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(input: string | Uint8Array): string {
  return typeof input === "string" ? input : new TextDecoder().decode(input);
}

function parseJson(input: string | Uint8Array, label: string): unknown {
  try {
    return JSON.parse(text(input)) as unknown;
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringRecord(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((item) => typeof item === "string");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why npm would refuse `name` as a dependency or override name, or `undefined`
 * when npm can install it. Existing published packages may use names that npm
 * no longer permits for new publication.
 */
export function packageNameProblem(name: string): string | undefined {
  const result = validatePackageName(name);
  return result.validForOldPackages ? undefined : (result.errors ?? ["invalid package name"]).join("; ");
}

/**
 * What a publication-only problem costs, shared by the name and version
 * reports so the two tiers read the same wherever they surface.
 */
export const UNPUBLISHABLE_STILL_LOADS = "The result loads from a local path but cannot be published.";

/** Why npm would refuse `name` for a newly published package. */
export function publishablePackageNameProblem(name: string): string | undefined {
  const result = validatePackageName(name);
  if (result.validForNewPackages) return undefined;
  return [...(result.errors ?? []), ...(result.warnings ?? [])].join("; ") || "invalid package name";
}

/**
 * Why npm would refuse `version` in a manifest it publishes, or `undefined`
 * when it is acceptable.
 *
 * An Agent Plugins manifest accepts any string here, so a projector that emits
 * an npm package cannot infer publishability from the field's presence: npm
 * wants one exact semantic version, not a range and not a dist-tag. `semver`
 * normalises a leading `v`, which npm also accepts.
 */
export function packageVersionProblem(version: string): string | undefined {
  if (semver.valid(version) !== null) return undefined;
  return version.trim().length === 0 ? "empty" : "not a semantic version";
}

/** Package-manager-specific protocols npm rejects; named here for a clearer message than npa's. */
const FOREIGN_PROTOCOLS = new Set(["workspace", "link", "portal", "patch", "catalog", "jsr"]);

/** Manifest sections other than `dependencies`; a runtime manifest carries production dependencies only (ADR-0012). */
const OTHER_DEPENDENCY_SECTIONS = [
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

const OUTSIDE_PACKAGE = "resolve outside the projected package and cannot be installed from the harness's cached copy";

/** `hosted-git-info` methods the bundled type definitions omit. */
interface Hosted {
  ssh(options?: { noCommittish?: boolean }): string | null;
}

/**
 * Parse a dependency spec with `npm-package-arg`, the way arborist builds
 * every edge, then apply the projected package's own policy: local paths
 * (`file:`, directories, `git+file:`) cannot resolve from the harness's
 * cached copy, and package-manager protocols npm rejects get a clearer
 * message than npa's `Unsupported URL Type`.
 */
function parseSpec(name: string, spec: string): { ok: true; parsed: npa.Result } | { ok: false; reason: string } {
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(spec)?.[1]?.toLowerCase();
  if (protocol !== undefined && FOREIGN_PROTOCOLS.has(protocol)) {
    return { ok: false, reason: `${protocol}: is a package-manager protocol npm does not understand` };
  }
  let parsed: npa.Result;
  try {
    parsed = npa.resolve(name, spec, "/");
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  const reason = policyProblem(parsed);
  return reason === undefined ? { ok: true, parsed } : { ok: false, reason };
}

function policyProblem(parsed: npa.Result): string | undefined {
  switch (parsed.type) {
    case "file":
    case "directory":
      return `local paths ${OUTSIDE_PACKAGE}`;
    case "git":
      return /^(?:git\+)?file:/i.test(parsed.fetchSpec ?? "") ? `git+file: paths ${OUTSIDE_PACKAGE}` : undefined;
    case "alias":
      return policyProblem((parsed as npa.AliasResult).subSpec);
    default:
      return undefined;
  }
}

/**
 * Whether `version` satisfies `range` under npm's rules: arborist calls
 * `semver.satisfies(version, range, true)`, i.e. loose parsing and *no*
 * `includePrerelease`, so `1.1.0-beta.1` does not satisfy `^1.0.0`.
 */
function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range, { loose: true });
}

/**
 * Why a lock entry does not satisfy the spec `requested` — a port of
 * arborist's `dep-valid`, case by case — or `undefined` when it does.
 */
function resolutionProblem(requested: npa.Result, entry: Record<string, unknown>, locked: string): string | undefined {
  const resolved = typeof entry["resolved"] === "string" ? entry["resolved"] : undefined;
  const parseResolved = (): npa.Result | undefined => {
    try {
      return npa(resolved ?? "");
    } catch {
      return undefined;
    }
  };
  switch (requested.type) {
    case "range":
    case "version":
      // "if it's a version or a range other than '*', semver it"
      if (requested.type === "range" && requested.fetchSpec === "*") return undefined;
      return satisfies(locked, requested.fetchSpec ?? "")
        ? undefined
        : `is locked at ${locked}, which does not satisfy the spec`;
    case "alias":
      return resolutionProblem((requested as npa.AliasResult).subSpec, entry, locked);
    case "tag":
      // "we just verify that it has a tarball resolution; presumably it came
      // from the registry and was tagged at some point"
      return resolved !== undefined && parseResolved()?.type === "remote"
        ? undefined
        : "has no registry tarball resolution in the lockfile (a dist-tag must have been resolved through a registry)";
    case "remote":
      return resolved === requested.fetchSpec
        ? undefined
        : `resolves in the lockfile to ${JSON.stringify(resolved)} instead of the manifest URL`;
    case "git": {
      const range = requested.gitRange;
      if (range !== undefined && semver.validRange(range, { loose: true }) === null) {
        return `has a #semver: range ${JSON.stringify(range)} that is not a valid semver range`;
      }
      // Same repository: hosted specs by hosted-git-info identity, others by
      // exact fetch spec; a spec pinning a full commit must match it too.
      const resolvedRepo = parseResolved();
      if (resolvedRepo === undefined || resolvedRepo.type !== "git") return "has no git resolution in the lockfile";
      const requestedHost = requested.hosted as Hosted | undefined;
      const resolvedHost = resolvedRepo.hosted as Hosted | undefined;
      const pinned = /^[a-fA-F0-9]{40,64}$/.test(requested.gitCommittish ?? "");
      const identity = { noCommittish: !pinned };
      const wanted = requestedHost === undefined ? requested.fetchSpec : requestedHost.ssh(identity);
      const actual = resolvedHost === undefined ? resolvedRepo.fetchSpec : resolvedHost.ssh(identity);
      if ((requestedHost === undefined) !== (resolvedHost === undefined) || wanted !== actual) {
        return `resolves in the lockfile to repository ${String(actual)} instead of ${String(wanted)}`;
      }
      if (range === undefined) return undefined;
      return satisfies(locked, range) ? undefined : `is locked at ${locked}, which does not satisfy the range ${range}`;
    }
    default:
      return `uses a ${requested.type} spec the validator does not model`;
  }
}

/**
 * Why the lock entry for one dependency edge does not satisfy its spec — the
 * spec is uninstallable, an `npm:` alias resolved to another package, or the
 * resolution fails `dep-valid` — or `undefined` when it does. The same rule
 * applies to every edge, from the root and between locked packages.
 */
function edgeProblem(name: string, spec: string, entry: Record<string, unknown>, locked: string): string | undefined {
  const result = parseSpec(name, spec);
  if (!result.ok) {
    return `uses spec ${JSON.stringify(spec)}, which npm cannot install (${result.reason}); use a registry version range`;
  }
  const { parsed } = result;
  if (parsed.type === "alias") {
    const target = (parsed as npa.AliasResult).subSpec.name;
    if (typeof entry["name"] === "string" && entry["name"] !== target) {
      return `resolves in the lockfile to package ${JSON.stringify(entry["name"])} instead of alias target ${JSON.stringify(target)}`;
    }
  }
  return resolutionProblem(parsed, entry, locked);
}

/**
 * Flat npm `overrides` (`{ name: range }`) as arborist applies them: every
 * edge to `name` anywhere in the graph takes the override spec in place of
 * its own, so a lock generated with the override is valid and one generated
 * without it is not. Nested (`{ a: { b: … } }`), selector (`a@1`), and `$ref`
 * forms are not modelled and are rejected rather than silently ignored.
 */
function parseOverrides(
  manifest: Record<string, unknown>,
  dependencies: Record<string, string>,
): { ok: true; overrides: Record<string, string> } | { ok: false; error: string } {
  const raw = manifest["overrides"];
  if (raw === undefined) return { ok: true, overrides: {} };
  if (!object(raw)) return { ok: false, error: "runtime package manifest overrides must be an object" };
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const unsupported = (reason: string) => ({
      ok: false as const,
      error: `runtime package manifest override ${JSON.stringify(key)} is not supported (${reason}); use a flat { name: range } override or regenerate without it`,
    });
    if (key === "." || key.includes("@", 1)) return unsupported("selectors are not modelled");
    const problem = packageNameProblem(key);
    if (problem !== undefined) return unsupported(problem);
    if (typeof value !== "string") return unsupported("nested overrides are not modelled");
    if (value.startsWith("$")) return unsupported("$reference values are not modelled");
    if (semver.validRange(value, { loose: true }) === null)
      return unsupported("only semver range overrides are modelled");
    // npm's own rule: a direct dependency may only be overridden to its own spec.
    const direct = dependencies[key];
    if (direct !== undefined && direct !== value) {
      return {
        ok: false,
        error: `runtime package manifest override ${JSON.stringify(key)} (${JSON.stringify(value)}) conflicts with the direct dependency spec ${JSON.stringify(direct)}; npm requires them to match`,
      };
    }
    overrides[key] = value;
  }
  return { ok: true, overrides };
}

/**
 * The lock entry `name` resolves to from the package at `location`, walking
 * up through nested `node_modules` the way Node and npm resolve it.
 */
function locate(
  packages: Record<string, unknown>,
  location: string,
  name: string,
): Record<string, unknown> | undefined {
  let base = location;
  for (;;) {
    const entry = packages[base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`];
    if (object(entry)) return entry;
    if (base === "") return undefined;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut === -1 ? "" : base.slice(0, cut);
  }
}

const LOCKED_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * Why the locked graph below the root is incomplete or inconsistent — what
 * `npm ci` reports as `Missing: … from lock file` or `Invalid: lock file's …
 * does not satisfy …` — or `undefined` when every locked package's own
 * dependencies are locked somewhere they resolve, at a satisfying version.
 */
function lockedGraphProblem(packages: Record<string, unknown>, overrides: Record<string, string>): string | undefined {
  for (const [location, entry] of Object.entries(packages)) {
    if (location === "") continue;
    if (!object(entry)) return `lockfile entry ${JSON.stringify(location)} is not an object`;
    if (entry["link"] === true) {
      return `lockfile entry ${JSON.stringify(location)} is a link to ${JSON.stringify(entry["resolved"])}; a projected runtime package cannot contain links`;
    }
    if (typeof entry["version"] !== "string") return `lockfile entry ${JSON.stringify(location)} has no version`;
    const meta = object(entry["peerDependenciesMeta"]) ? entry["peerDependenciesMeta"] : {};
    // arborist reads `optionalDependencies` before `dependencies`: a name in
    // both is one optional edge with the optional spec, not two edges.
    const optionalNames = object(entry["optionalDependencies"])
      ? new Set(Object.keys(entry["optionalDependencies"]))
      : new Set<string>();
    for (const section of LOCKED_SECTIONS) {
      const declared = entry[section];
      if (declared === undefined) continue;
      if (!stringRecord(declared)) return `lockfile entry ${JSON.stringify(location)} has a malformed ${section} map`;
      for (const [name, declaredSpec] of Object.entries(declared)) {
        if (section === "dependencies" && optionalNames.has(name)) continue;
        // An overridden edge is judged by the override, never by its own spec.
        const spec = overrides[name] ?? declaredSpec;
        const peerMeta = meta[name];
        const optional =
          section === "optionalDependencies" ||
          (section === "peerDependencies" && object(peerMeta) && peerMeta["optional"] === true);
        const dependency = locate(packages, location, name);
        if (dependency === undefined) {
          if (optional) continue;
          return `lockfile entry ${JSON.stringify(location)} depends on ${JSON.stringify(name)} (${JSON.stringify(spec)}), which is not locked anywhere it resolves`;
        }
        const version = dependency["version"];
        if (typeof version !== "string")
          return `lockfile entry for ${JSON.stringify(name)} under ${JSON.stringify(location)} has no version`;
        const problem = edgeProblem(name, spec, dependency, version);
        if (problem !== undefined)
          return `lockfile entry ${JSON.stringify(location)} dependency ${JSON.stringify(name)} ${problem}`;
      }
    }
  }
  return undefined;
}

/** The installed package name a lock entry location addresses. */
function lockedName(location: string): string {
  const cut = location.lastIndexOf("node_modules/");
  return cut === -1 ? location : location.slice(cut + "node_modules/".length);
}

/**
 * Why a locked package needs setup the harness install will not run, or
 * `undefined` when none does. This is the one rule not taken from npm: an
 * install with lifecycle scripts disabled does not *reject* a package with
 * `preinstall`/`install`/`postinstall`, it installs it with its own setup
 * skipped — the failure surfaces at import time in the installed plugin
 * instead. A runtime package is pure JavaScript (ADR-0012), so the rejection
 * happens here, unless the author has named the package in
 * `allowInstallScripts` to say they have verified it runs without its script.
 *
 * `hasInstallScript` is npm-emitted lockfile metadata, written only when true.
 * It is the signal npm itself uses, not a guarantee: a hand-written lock may
 * omit it, and a package shipping a prebuilt binary with no install script is
 * not caught by it at all.
 */
function installScriptProblem(packages: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const [location, entry] of Object.entries(packages)) {
    if (location === "" || !object(entry) || entry["hasInstallScript"] !== true) continue;
    const name = lockedName(location);
    if (allowed.has(name)) continue;
    return `lockfile entry ${JSON.stringify(location)} needs an npm lifecycle install script, which the harness install does not run (\`npm ci --ignore-scripts\`); the package would be installed unbuilt and fail when the plugin imports it. Use a dependency that ships ready-to-run JavaScript, or add ${JSON.stringify(name)} to components.runtimePackage.allowInstallScripts once you have verified it works without its script`;
  }
  return undefined;
}

function sameDependencies(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/**
 * Validate a runtime manifest and lockfile pair. Rules:
 *
 * - the manifest is a JSON object with a string-valued `dependencies` object
 *   and no other dependency section (`devDependencies`, `peerDependencies`,
 *   `optionalDependencies`, bundled dependencies): a runtime package is
 *   production dependencies only, and `npm ci` checks every section for sync;
 * - every dependency name is one npm accepts (`validate-npm-package-name`);
 * - the lockfile is an npm `package-lock.json` with `lockfileVersion` 2 or 3
 *   (pnpm and yarn lockfiles are not npm lockfiles and are rejected by name);
 * - the lockfile's root entry (`packages[""]`) declares exactly the manifest's
 *   dependencies, so the manifest and lockfile were generated together;
 * - every manifest dependency has a `node_modules/<name>` entry with a
 *   `version` that satisfies its spec as arborist's `dep-valid` checks it,
 *   with the spec classified by `npm-package-arg`: a semver range or version
 *   (bare or in an `npm:` alias) under npm's loose, prerelease-excluding
 *   semantics; a dist-tag with a registry tarball `resolved`; a tarball URL
 *   whose `resolved` is exactly that URL; a git URL or hosted shorthand
 *   (`hosted-git-info` forms, `https://github.com/o/r.git` and GitLab
 *   subgroups included) whose `resolved` names the same repository, the same
 *   commit when the spec pins one, and a satisfying version for `#semver:`;
 * - every locked package's own `dependencies` and non-optional
 *   `peerDependencies` are locked where they resolve and satisfy their specs
 *   under the same rules, so the lock is a complete graph and `npm ci` has
 *   nothing to re-resolve; `link:` entries are rejected;
 * - local paths, `file:`, `git+file:`, and package-manager protocols
 *   (`workspace:`, `link:`, …) are rejected outright, on any edge;
 * - no locked package declares `hasInstallScript`, unless its name is listed
 *   in `options.allowInstallScripts`. This rule alone is not npm's: the
 *   harness install skips lifecycle scripts rather than refusing them, so
 *   without it a package that needs setup passes `check` and fails at import
 *   time in the installed plugin.
 *
 * Flat `overrides` (`{ name: range }`) are applied to every edge the way
 * arborist applies them; nested, selector, and `$ref` overrides are rejected
 * as unmodelled, and an override of a direct dependency must equal its spec
 * (npm's rule).
 */
export function validateNpmRuntimePackage(
  manifestInput: string | Uint8Array,
  lockfileInput: string | Uint8Array,
  options: { allowInstallScripts?: readonly string[] } = {},
): NpmRuntimePackageValidation {
  try {
    const manifest = parseJson(manifestInput, "runtime package manifest is not valid JSON");
    if (!object(manifest) || !stringRecord(manifest["dependencies"])) {
      return { ok: false, error: "runtime package manifest must contain a string-valued dependencies object" };
    }
    const dependencies = manifest["dependencies"];
    for (const section of OTHER_DEPENDENCY_SECTIONS) {
      if (manifest[section] !== undefined) {
        return {
          ok: false,
          error: `runtime package manifest must declare only dependencies; remove ${section} (a projected runtime package carries production dependencies only)`,
        };
      }
    }
    const parsedOverrides = parseOverrides(manifest, dependencies);
    if (!parsedOverrides.ok) return parsedOverrides;
    for (const name of Object.keys(dependencies)) {
      const problem = packageNameProblem(name);
      if (problem !== undefined) {
        return {
          ok: false,
          error: `runtime package manifest dependency name ${JSON.stringify(name)} is not a valid npm package name: ${problem}`,
        };
      }
    }

    const lockfile = parseJson(
      lockfileInput,
      "runtime package lockfile must be an npm package-lock.json (lockfileVersion 2 or 3); pnpm and yarn lockfiles are not supported",
    );
    if (!object(lockfile)) {
      return { ok: false, error: "runtime package lockfile must contain a JSON object" };
    }
    const version = lockfile["lockfileVersion"];
    if (version !== 2 && version !== 3) {
      return {
        ok: false,
        error: `runtime package lockfile must have lockfileVersion 2 or 3 (found ${JSON.stringify(version)}); regenerate it with a current npm`,
      };
    }
    const packages = lockfile["packages"];
    if (!object(packages) || !object(packages[""])) {
      return { ok: false, error: 'runtime package lockfile must contain a packages map with a root "" entry' };
    }
    const root = packages[""];
    const rootDependencies = root["dependencies"] ?? {};
    if (!stringRecord(rootDependencies) || !sameDependencies(dependencies, rootDependencies)) {
      return {
        ok: false,
        error:
          "runtime package lockfile root dependencies do not match the manifest dependencies; regenerate the lockfile from the manifest",
      };
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      const entry = packages[`node_modules/${name}`];
      const locked = object(entry) ? entry["version"] : undefined;
      if (!object(entry) || typeof locked !== "string") {
        return {
          ok: false,
          error: `runtime package lockfile does not lock dependency ${JSON.stringify(name)}; regenerate the lockfile from the manifest`,
        };
      }
      // `npm ci` refuses a lock entry that no longer satisfies the manifest
      // spec; the check per spec kind is arborist's `dep-valid`.
      const problem = edgeProblem(name, spec, entry, locked);
      if (problem !== undefined) {
        return {
          ok: false,
          error: `runtime package dependency ${JSON.stringify(name)} (${JSON.stringify(spec)}) ${problem}; regenerate the lockfile from the manifest`,
        };
      }
    }
    const graphProblem = lockedGraphProblem(packages, parsedOverrides.overrides);
    if (graphProblem !== undefined) {
      return { ok: false, error: `runtime package ${graphProblem}; regenerate the lockfile from the manifest` };
    }
    // Kept out of `lockedGraphProblem`: its findings all end in "regenerate
    // the lockfile", which would be wrong advice for a package that needs a
    // script no regeneration can supply.
    const scriptProblem = installScriptProblem(packages, new Set(options.allowInstallScripts ?? []));
    if (scriptProblem !== undefined) {
      return { ok: false, error: `runtime package ${scriptProblem}` };
    }
    return {
      ok: true,
      manifest: manifest as NpmRuntimeManifest,
      lockfile: { ...lockfile, lockfileVersion: version, packages } as NpmRuntimeLockfile,
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
