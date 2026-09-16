import { validateNpmRuntimePackage } from "../runtime-package.js";

/**
 * How a runtime's dependencies reach the machine that finally runs the server.
 *
 * These are the only three answers there are, and which one an ecosystem can
 * offer is a property of the ecosystem rather than a preference:
 *
 * - `harness-installed` needs a harness that performs the install. Exactly one
 *   does: Claude runs `npm ci --ignore-scripts` in its cached copy of a plugin
 *   (ADR-0012). No harness installs for any other ecosystem, so this is npm's
 *   alone until one of them learns to.
 * - `build-materialized` has Hooknostic perform a locked, script-free install
 *   at build time and commit the result. Only admissible when the produced
 *   bytes mean the same thing on every machine -- see `portability`.
 * - `author-supplied` is the author having put it in the package already: a
 *   vendored tree, a prebuilt binary. Hooknostic copies and reports it. This is
 *   the only answer available to an ecosystem whose output is a native binary.
 */
export type RuntimeDelivery = "harness-installed" | "build-materialized" | "author-supplied";

/** One declared runtime in `components.runtime`. */
export interface RuntimeDeclaration {
  ecosystem: string;
  /** Package-relative path to the ecosystem's dependency manifest. */
  manifest?: string;
  /** Package-relative path to its lockfile. */
  lockfile?: string;
  delivery: RuntimeDelivery;
  /** Where a materialized tree is emitted, relative to the target output. */
  into?: string;
  /** npm only: packages whose install script the author verified is not needed. */
  allowInstallScripts?: string[];
}

export interface RuntimeValidation {
  ok: boolean;
  error?: string;
}

/** The locked, offline, script-free install a `build-materialized` runtime runs. */
export interface MaterializeCommand {
  command: string;
  args: string[];
}

export interface RuntimeProvider {
  readonly ecosystem: string;
  /**
   * Whether this ecosystem's materialized output is the same bytes everywhere.
   *
   * `platform-specific` is not a judgement about the ecosystem's quality; it is
   * a statement that its build output is selected for one target triple, so
   * committing one (ADR-0006) would commit an artifact that is wrong for every
   * other consumer. Such a provider may never offer `build-materialized`.
   */
  readonly portability: "portable" | "platform-specific";
  readonly deliveries: readonly RuntimeDelivery[];
  /** The executable a `build-materialized` install shells out to, if any. */
  readonly tool?: string;
  /** Why this ecosystem is limited to what it offers, for diagnostics and docs. */
  readonly rationale: string;
  validate(
    files: { manifest?: Uint8Array | string; lockfile?: Uint8Array | string },
    options?: { allowInstallScripts?: readonly string[] },
  ): RuntimeValidation;
  /**
   * The install to run. Declared rather than performed, so this package stays
   * free of side effects and the command itself is testable without spawning.
   */
  materializeCommand?(input: { lockfile: string; into: string }): MaterializeCommand;
  /**
   * Paths to drop from a materialized tree before it is verified and emitted.
   *
   * Not a convenience: installers write platform-native files of their own next
   * to the portable ones, and a tree that keeps them is not portable no matter
   * how pure its dependencies are.
   */
  excludedFromTree?(path: string): boolean;
}

const npm: RuntimeProvider = {
  ecosystem: "npm",
  portability: "portable",
  deliveries: ["harness-installed", "author-supplied"],
  rationale:
    "Claude installs a plugin's npm dependencies in its cached copy; no other harness does, and Hooknostic bundles " +
    "Node code rather than materializing node_modules.",
  validate(files, options) {
    if (files.manifest === undefined || files.lockfile === undefined) {
      return { ok: false, error: "the npm runtime requires both a manifest and a lockfile" };
    }
    const result = validateNpmRuntimePackage(files.manifest, files.lockfile, {
      ...(options?.allowInstallScripts === undefined ? {} : { allowInstallScripts: options.allowInstallScripts }),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  },
};

/** Every requirement pinned with `==`, and carrying at least one hash. */
const PINNED_REQUIREMENT = /^[A-Za-z0-9._-]+(\[[^\]]*\])?==\S+/;

const pypi: RuntimeProvider = {
  ecosystem: "pypi",
  portability: "portable",
  deliveries: ["build-materialized", "author-supplied"],
  tool: "uv",
  rationale:
    "No harness installs Python dependencies, so a locked wheel-only install is performed at build time and the " +
    "pure-Python result committed. A distribution with a compiled extension is refused rather than pinned to the " +
    "machine that built it.",
  validate(files) {
    if (files.lockfile === undefined) return { ok: false, error: "the pypi runtime requires a lockfile" };
    const text = typeof files.lockfile === "string" ? files.lockfile : Buffer.from(files.lockfile).toString("utf8");
    // A hash-pinned requirements file is the lock: `uv pip compile --generate-hashes`
    // and `pip-compile` both emit it, and `--require-hashes` makes pip enforce it.
    const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
    let requirements = 0;
    for (const raw of logical) {
      const line = raw.split(" #")[0]!.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("-e ") || line.startsWith("--editable")) {
        return { ok: false, error: "an editable requirement resolves outside the package and cannot be installed" };
      }
      if (line.startsWith("--no-binary")) {
        return { ok: false, error: "--no-binary would build a source distribution, which executes its setup code" };
      }
      if (line.startsWith("-")) continue;
      requirements += 1;
      if (!PINNED_REQUIREMENT.test(line)) {
        return { ok: false, error: `requirement ${JSON.stringify(line.split(/\s/)[0])} is not pinned with ==` };
      }
      if (!line.includes("--hash=")) {
        return { ok: false, error: `requirement ${JSON.stringify(line.split("==")[0])} carries no --hash` };
      }
    }
    if (requirements === 0) return { ok: false, error: "the pypi lockfile declares no requirements" };
    return { ok: true };
  },
  materializeCommand({ lockfile, into }) {
    return {
      command: "uv",
      args: [
        "pip",
        "install",
        "--target",
        into,
        "--requirement",
        lockfile,
        // The lockfile is the complete closure, so resolution is not repeated.
        "--no-deps",
        // Enforces the hashes that `validate` insisted on.
        "--require-hashes",
        // The Python analogue of `npm ci --ignore-scripts`: a source distribution
        // runs its own setup code at install time, and a wheel does not.
        "--only-binary=:all:",
      ],
    };
  },
  excludedFromTree(path) {
    // `uv pip install --target` writes console-script launchers, and on Windows
    // those are generated `.exe` stubs -- measured: a `--target` install of
    // `idna`, which is `py3-none-any` throughout, still produced `bin/idna.exe`.
    // A materialized runtime exists to be imported through PYTHONPATH; the
    // server's own command is declared in `mcp.json`, so no entry point here is
    // ever invoked and keeping them would make every tree platform-specific.
    return path === ".lock" || path.startsWith("bin/") || path.startsWith("Scripts/");
  },
};

const nuget: RuntimeProvider = {
  ecosystem: "nuget",
  portability: "portable",
  deliveries: ["author-supplied"],
  rationale:
    "A framework-dependent publish is portable IL and could be materialized; a self-contained one is not. The " +
    "distinction is a publish flag rather than a property of the package, so the safe half is not yet automated.",
  validate() {
    return { ok: true };
  },
};

const nativeToolchain = (ecosystem: string, tool: string): RuntimeProvider => ({
  ecosystem,
  portability: "platform-specific",
  deliveries: ["author-supplied"],
  rationale:
    `A ${tool} build produces one native binary per target triple. Committing one (ADR-0006) would commit an ` +
    "artifact that is wrong for every consumer on another platform, so the author supplies the binaries, or the " +
    "server is declared as a runner command such as docker.",
  validate() {
    return { ok: true };
  },
});

/**
 * Every ecosystem Hooknostic knows how to talk about.
 *
 * Ecosystems that cannot be materialized are listed rather than omitted. An
 * author reaching for Rust should be told what the answer is, not left to infer
 * it from an unknown-ecosystem error -- and the reason is the same rule that
 * admits Python, applied to a different set of bytes.
 */
export const RUNTIME_PROVIDERS: Record<string, RuntimeProvider> = {
  npm,
  pypi,
  nuget,
  cargo: nativeToolchain("cargo", "cargo"),
  golang: nativeToolchain("golang", "go"),
};

export function runtimeProvider(ecosystem: string): RuntimeProvider | undefined {
  return Object.hasOwn(RUNTIME_PROVIDERS, ecosystem) ? RUNTIME_PROVIDERS[ecosystem] : undefined;
}

/** Why a declaration is inadmissible, or `undefined` if the shape is allowed. */
export function runtimeDeclarationProblem(declaration: RuntimeDeclaration): string | undefined {
  const provider = runtimeProvider(declaration.ecosystem);
  if (provider === undefined) {
    return `unknown runtime ecosystem ${JSON.stringify(declaration.ecosystem)}; known: ${Object.keys(RUNTIME_PROVIDERS).sort().join(", ")}`;
  }
  if (!provider.deliveries.includes(declaration.delivery)) {
    return (
      `${declaration.ecosystem} does not support ${declaration.delivery} delivery ` +
      `(it offers ${provider.deliveries.join(", ")}). ${provider.rationale}`
    );
  }
  if (declaration.delivery === "build-materialized") {
    if (provider.portability === "platform-specific") {
      return `${declaration.ecosystem} output is built for one platform and cannot be committed. ${provider.rationale}`;
    }
    if (declaration.into === undefined) {
      return `${declaration.ecosystem} build-materialized delivery requires "into"`;
    }
  } else if (declaration.into !== undefined) {
    return `"into" applies only to build-materialized delivery`;
  }
  return undefined;
}
