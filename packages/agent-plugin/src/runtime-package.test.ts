import { describe, expect, it } from "vitest";
import { packageNameProblem, validateNpmRuntimePackage } from "./runtime-package.js";

const manifest = JSON.stringify({ name: "runtime", dependencies: { left: "1.0.0", right: "^2.0.0" } });

function lockfile(overrides: Record<string, unknown> = {}, root: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { left: "1.0.0", right: "^2.0.0" }, ...root },
      "node_modules/left": { version: "1.0.0" },
      "node_modules/right": { version: "2.3.4" },
    },
    ...overrides,
  });
}

/** A one-dependency pair, with extra lock entries beside `node_modules/dep`. */
function single(spec: string, entry: Record<string, unknown>, extra: Record<string, unknown> = {}, name = "dep"): [string, string] {
  return [
    JSON.stringify({ dependencies: { [name]: spec } }),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { [name]: spec } }, [`node_modules/${name}`]: entry, ...extra },
    }),
  ];
}

describe("validateNpmRuntimePackage", () => {
  it("accepts a manifest whose every dependency is locked by a v2/v3 lockfile", () => {
    for (const version of [2, 3]) {
      const result = validateNpmRuntimePackage(manifest, lockfile({ lockfileVersion: version }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  });

  it("accepts every npm-native spec whose lock entry satisfies it the way arborist checks", () => {
    const aliased = JSON.stringify({
      dependencies: {
        tagged: "latest",
        star: "*",
        prerelease: "^1.0.0-beta.1",
        git: "github:example/git#v1",
        gitUrl: "git+https://github.com/Example/Git-Url.git",
        pinned: "git+ssh://git@github.com/example/pinned.git#0123456789abcdef0123456789abcdef01234567",
        ranged: "gitlab:example/ranged#semver:^2.0.0",
        url: "https://example.com/pkg.tgz",
        shorthand: "example/repo",
        // scp-style hosts are accepted inside `git+ssh://` (npa `fromURL`); the
        // bare `git@host:path` form is a CLI-argument convenience npa applies
        // only in `npa(arg)`, never to package.json specs.
        scpUrl: "git+ssh://git@github.com:example/scp-url.git",
        looseVersion: "01.2.3",
        // npm-package-arg consults hosted-git-info before the URL check, so a
        // hosted HTTPS URL is a git spec, and GitLab subgroups are hosted paths.
        hostedHttps: "https://github.com/example/hosted-https.git",
        subgroup: "gitlab:team/platform/repo#v1",
        selfHosted: "git+https://example.com/pkg.git",
        selfHostedScp: "git+ssh://git@example.com:pkg.git#v2",
        alias: "npm:other@^1",
        bareAlias: "npm:other",
        tagAlias: "npm:other@next",
        scopedAlias: "npm:@scope/other@~2.1.0",
      },
    });
    const registry = (name: string, version: string) => ({
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    });
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: JSON.parse(aliased).dependencies },
        "node_modules/tagged": registry("tagged", "9.9.9"),
        "node_modules/star": registry("star", "3.0.0-rc.1"),
        "node_modules/prerelease": registry("prerelease", "1.0.0-beta.2"),
        "node_modules/git": { version: "0.0.1", resolved: "git+ssh://git@github.com/example/git.git#abc123" },
        "node_modules/gitUrl": { version: "0.0.1", resolved: "git+ssh://git@github.com/Example/Git-Url.git#abc123" },
        "node_modules/pinned": {
          version: "0.0.1",
          resolved: "git+ssh://git@github.com/example/pinned.git#0123456789abcdef0123456789abcdef01234567",
        },
        "node_modules/ranged": { version: "2.4.0", resolved: "git+ssh://git@gitlab.com/example/ranged.git#def456" },
        "node_modules/url": { version: "0.0.1", resolved: "https://example.com/pkg.tgz" },
        "node_modules/shorthand": { version: "0.0.1", resolved: "git+ssh://git@github.com/example/repo.git#def456" },
        "node_modules/scpUrl": { version: "0.0.1", resolved: "git+ssh://git@github.com/example/scp-url.git#abc123" },
        "node_modules/looseVersion": registry("looseVersion", "1.2.3"),
        "node_modules/hostedHttps": { version: "0.0.1", resolved: "git+ssh://git@github.com/example/hosted-https.git#abc123" },
        "node_modules/subgroup": { version: "0.0.1", resolved: "git+ssh://git@gitlab.com/team/platform/repo.git#abc123" },
        "node_modules/selfHosted": { version: "0.0.1", resolved: "git+https://example.com/pkg.git#abc123" },
        "node_modules/selfHostedScp": { version: "0.0.1", resolved: "git+ssh://git@example.com:pkg.git#abc123" },
        "node_modules/alias": { name: "other", ...registry("other", "1.2.3") },
        "node_modules/bareAlias": { name: "other", ...registry("other", "4.0.0") },
        "node_modules/tagAlias": { name: "other", ...registry("other", "5.0.0-beta.1") },
        "node_modules/scopedAlias": { name: "@scope/other", ...registry("other", "2.1.7") },
      },
    });
    expect(validateNpmRuntimePackage(aliased, lock)).toMatchObject({ ok: true });
  });

  it.each([
    ["workspace:*", { version: "1.0.0" }, "workspace: is a package-manager protocol npm does not understand"],
    ["link:../dep", { version: "1.0.0" }, "link: is a package-manager protocol"],
    ["catalog:", { version: "1.0.0" }, "catalog: is a package-manager protocol"],
    ["jsr:@scope/dep@^1", { version: "1.0.0" }, "jsr: is a package-manager protocol"],
    // Messages for what npm itself refuses come from npm-package-arg.
    ["custom:thing", { version: "1.0.0" }, 'Unsupported URL Type "custom:"'],
    ["ssh://git@example.com/repo.git", { version: "1.0.0" }, 'Unsupported URL Type "ssh:"'],
    ["npm:other@not a range", { version: "1.0.0" }, 'Invalid tag name "not a range"'],
    ["file:../local", { version: "1.0.0" }, "local paths resolve outside the projected package"],
    ["git+file:///srv/local.git", { version: "1.0.0" }, "git+file: paths resolve outside the projected package"],
    ["npm:@^1", { version: "1.0.0" }, "which npm cannot install"],
    ["npm:", { version: "1.0.0" }, "which npm cannot install"],
    ["npm:other@^2", { name: "other", version: "1.5.0" }, 'dependency "dep" ("npm:other@^2") is locked at 1.5.0'],
    ["npm:other@^1", { name: "different", version: "1.5.0" }, 'resolves in the lockfile to package "different" instead of alias target "other"'],
    // Local paths cannot resolve from the harness's cached copy; `../dep` must
    // not read as hosted shorthand for a GitHub repository named `../dep`.
    ["../dep", { version: "1.0.0", resolved: "git+ssh://git@github.com/../dep.git#abc" }, "local paths resolve outside the projected package"],
    ["./dep", { version: "1.0.0" }, "local paths resolve outside"],
    ["/srv/dep", { version: "1.0.0" }, "local paths resolve outside"],
    ["~/dep", { version: "1.0.0" }, "local paths resolve outside"],
    ["C:\\dep", { version: "1.0.0" }, "local paths resolve outside"],
    // npm's semver check is loose without includePrerelease: a prerelease of a
    // later minor never satisfies a caret range (arborist dep-valid).
    ["^1.0.0", { version: "1.1.0-beta.1" }, "is locked at 1.1.0-beta.1, which does not satisfy the spec"],
    ["npm:other@^1.0.0", { name: "other", version: "1.1.0-beta.1" }, "is locked at 1.1.0-beta.1"],
    // Tags must have resolved through a registry tarball.
    ["latest", { version: "9.9.9" }, "has no registry tarball resolution"],
    ["latest", { version: "9.9.9", resolved: "git+ssh://git@github.com/x/y.git#abc" }, "has no registry tarball resolution"],
    ["npm:other@latest", { name: "other", version: "9.9.9" }, "has no registry tarball resolution"],
    // Remote tarballs must have resolved to exactly the manifest URL.
    ["https://example.com/pkg.tgz", { version: "0.0.1" }, 'resolves in the lockfile to undefined instead of the manifest URL'],
    ["https://example.com/pkg.tgz", { version: "0.0.1", resolved: "" }, 'resolves in the lockfile to "" instead of'],
    ["https://example.com/pkg.tgz", { version: "0.0.1", resolved: "https://example.com/other.tgz" }, 'to "https://example.com/other.tgz" instead of'],
    // A malformed #semver: range matches nothing, as npm-package-arg rejects it.
    ["example/repo#semver:not-a-range", { version: "1.0.0", resolved: "git+ssh://git@github.com/example/repo.git#abc" }, 'has a #semver: range "not-a-range" that is not a valid semver range'],
    // Loose parsing: `01.2.3` is a version to npm, so the locked version is checked.
    ["01.2.3", { version: "1.2.4", resolved: "https://registry.npmjs.org/dep/-/dep-1.2.4.tgz" }, "is locked at 1.2.4, which does not satisfy the spec"],
    ["npm:other@01.2.3", { name: "other", version: "1.2.4" }, "is locked at 1.2.4, which does not satisfy the spec"],
    // Git specs must resolve to the same repository, commit, or semver range.
    ["github:example/git#v1", { version: "0.0.1" }, "has no git resolution in the lockfile"],
    ["github:example/git#v1", { version: "0.0.1", resolved: "https://registry.npmjs.org/git/-/git-0.0.1.tgz" }, "has no git resolution"],
    [
      "github:example/git#v1",
      { version: "0.0.1", resolved: "git+ssh://git@github.com/example/other.git#abc" },
      "to repository git@github.com:example/other.git instead of git@github.com:example/git.git",
    ],
    [
      "git+https://github.com/example/git.git#0123456789abcdef0123456789abcdef01234567",
      { version: "0.0.1", resolved: "git+ssh://git@github.com/example/git.git#fedcba9876543210fedcba9876543210fedcba98" },
      "git.git#fedcba9876543210fedcba9876543210fedcba98 instead of git@github.com:example/git.git#0123456789abcdef0123456789abcdef01234567",
    ],
    // Non-hosted git specs compare by exact fetch spec (arborist dep-valid):
    // a different protocol or user is a different repository to npm.
    [
      "git+https://example.com/pkg.git",
      { version: "0.0.1", resolved: "git+ssh://git@example.com/pkg.git#abc" },
      "to repository ssh://git@example.com/pkg.git instead of https://example.com/pkg.git",
    ],
    [
      "git+ssh://git@example.com:pkg.git",
      { version: "0.0.1", resolved: "git+ssh://deploy@example.com:pkg.git#abc" },
      "to repository deploy@example.com:pkg.git instead of git@example.com:pkg.git",
    ],
    // A bare scp-style spec is a CLI convenience, not a package.json spec.
    ["git@example.com:pkg.git", { version: "0.0.1", resolved: "git+ssh://git@example.com:pkg.git#abc" }, 'Invalid tag name "git@example.com:pkg.git"'],
    [
      "example/git#semver:^2.0.0",
      { version: "1.9.0", resolved: "git+ssh://git@github.com/example/git.git#abc" },
      "is locked at 1.9.0, which does not satisfy the range ^2.0.0",
    ],
  ])("rejects spec %s against lock entry %o", (spec, entry, message) => {
    const result = validateNpmRuntimePackage(...single(spec, entry));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it.each([
    ["@scope", "name can only contain URL-friendly characters"],
    ["foo?bar", "name can only contain URL-friendly characters"],
    ["@scope/.hidden", "name cannot start with a period"],
    [".hidden", "name cannot start with a period"],
    ["_private", "name cannot start with an underscore"],
    ["-dash", "name cannot start with a hyphen"],
    [" spaced", "name cannot contain leading or trailing spaces"],
    ["node_modules", "node_modules is not a valid package name"],
    ["favicon.ico", "favicon.ico is not a valid package name"],
  ])("rejects dependency name %s even when a matching lock entry exists", (name, message) => {
    const result = validateNpmRuntimePackage(...single("1.0.0", { version: "1.0.0" }, {}, name));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`dependency name ${JSON.stringify(name)} is not a valid npm package name: ${message}`);
  });

  it("accepts legacy names npm still installs", () => {
    for (const name of ["UPPER", "@Scope/Name", "a".repeat(215), "http", "weird~'!()*"]) {
      expect(packageNameProblem(name), name).toBeUndefined();
    }
  });

  describe("locked dependency graph", () => {
    const deep = (version: string, extra: Record<string, unknown> = {}) => ({ version, ...extra });

    it("accepts a graph whose every transitive dependency is locked where it resolves", () => {
      const [m, l] = single(
        "1.0.0",
        { version: "1.0.0", dependencies: { deep: "^1.0.0", nested: "^3.0.0" }, optionalDependencies: { fsevents: "^2" } },
        {
          "node_modules/deep": deep("1.5.0", { peerDependencies: { dep: "*", missingPeer: "^1" }, peerDependenciesMeta: { missingPeer: { optional: true } } }),
          "node_modules/nested": deep("2.0.0"),
          "node_modules/dep/node_modules/nested": deep("3.1.0", { dependencies: { deep: "^1" } }),
        },
      );
      expect(validateNpmRuntimePackage(m, l)).toMatchObject({ ok: true });
    });

    it("accepts transitive aliases, tags, tarballs, and git specs that resolve as npm requires", () => {
      const [m, l] = single(
        "1.0.0",
        { version: "1.0.0", dependencies: { alias: "npm:other@^1", tagged: "latest", tarball: "https://example.com/t.tgz", repo: "example/repo#v1" } },
        {
          "node_modules/alias": deep("1.4.0", { name: "other" }),
          "node_modules/tagged": deep("2.0.0", { resolved: "https://registry.npmjs.org/tagged/-/tagged-2.0.0.tgz" }),
          "node_modules/tarball": deep("0.0.1", { resolved: "https://example.com/t.tgz" }),
          "node_modules/repo": deep("0.0.1", { resolved: "git+ssh://git@github.com/example/repo.git#abc" }),
        },
      );
      expect(validateNpmRuntimePackage(m, l)).toMatchObject({ ok: true });
    });

    /** A pair whose transitive `deep@^1` is locked at 2.0.0, valid only under an override. */
    const overridden = (overrides: unknown): [string, string] => [
      JSON.stringify({ dependencies: { dep: "1.0.0" }, overrides }),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { dep: "1.0.0" } },
          "node_modules/dep": deep("1.0.0", { dependencies: { deep: "^1" } }),
          "node_modules/deep": deep("2.0.0"),
        },
      }),
    ];

    it("treats a name in both dependencies and optionalDependencies as one optional edge, as arborist does", () => {
      const both = (extra: Record<string, unknown>) =>
        single("1.0.0", { version: "1.0.0", dependencies: { foo: "^1" }, optionalDependencies: { foo: "^2" } }, extra);
      expect(validateNpmRuntimePackage(...both({ "node_modules/foo": deep("2.0.0") }))).toMatchObject({ ok: true });
      expect(validateNpmRuntimePackage(...both({}))).toMatchObject({ ok: true });
      const result = validateNpmRuntimePackage(...both({ "node_modules/foo": deep("1.0.0") }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('dependency "foo" is locked at 1.0.0, which does not satisfy the spec');
    });

    it("judges an overridden edge by the override, as arborist does", () => {
      expect(validateNpmRuntimePackage(...overridden(undefined))).toMatchObject({ ok: false });
      expect(validateNpmRuntimePackage(...overridden({ deep: "^2" }))).toMatchObject({ ok: true });
      const result = validateNpmRuntimePackage(...overridden({ deep: "^3" }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('dependency "deep" is locked at 2.0.0, which does not satisfy the spec');
    });

    it.each([
      ["a nested override", { dep: { deep: "^2" } }, "nested overrides are not modelled"],
      ["a selector override", { "deep@^1": "^2" }, "selectors are not modelled"],
      ["a $reference override", { deep: "$dep" }, "$reference values are not modelled"],
      ["a non-semver override", { deep: "github:example/deep" }, "only semver range overrides are modelled"],
      ["an invalid override name", { "foo?bar": "^2" }, "URL-friendly characters"],
      ["a direct dependency overridden to a different spec", { dep: "^1" }, 'override "dep" ("^1") conflicts with the direct dependency spec "1.0.0"'],
    ])("rejects %s", (_label, overrides, message) => {
      const result = validateNpmRuntimePackage(...overridden(overrides));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    });

    it.each([
      ["a missing transitive dependency", { dependencies: { deep: "^1" } }, {}, 'depends on "deep" ("^1"), which is not locked anywhere it resolves'],
      ["a shadowed nested dependency that is missing", { dependencies: { nested: "^3" } }, { "node_modules/nested": deep("2.0.0") }, 'dependency "nested" is locked at 2.0.0, which does not satisfy the spec'],
      ["a transitive prerelease outside its range", { dependencies: { deep: "^1.0.0" } }, { "node_modules/deep": deep("1.1.0-beta.1") }, "is locked at 1.1.0-beta.1, which does not satisfy the spec"],
      // Every edge gets the full spec rules, not only semver ranges.
      ["a transitive alias outside its range", { dependencies: { alias: "npm:other@^2" } }, { "node_modules/alias": deep("1.4.0", { name: "other" }) }, 'entry "node_modules/dep" dependency "alias" is locked at 1.4.0'],
      ["a transitive alias resolved to another package", { dependencies: { alias: "npm:other@^1" } }, { "node_modules/alias": deep("1.4.0", { name: "else" }) }, 'to package "else" instead of alias target "other"'],
      ["a transitive workspace protocol", { dependencies: { ws: "workspace:*" } }, { "node_modules/ws": deep("1.0.0") }, 'dependency "ws" uses spec "workspace:*", which npm cannot install'],
      ["a transitive file path", { dependencies: { local: "file:../local" } }, { "node_modules/local": deep("1.0.0") }, "local paths resolve outside the projected package"],
      ["a transitive tag without a registry resolution", { dependencies: { tagged: "latest" } }, { "node_modules/tagged": deep("2.0.0") }, 'dependency "tagged" has no registry tarball resolution'],
      ["a missing required peer dependency", {}, { "node_modules/extra": deep("1.0.0", { peerDependencies: { peer: "^1" } }) }, 'entry "node_modules/extra" depends on "peer"'],
      ["a link entry", {}, { "node_modules/linked": { link: true, resolved: "../elsewhere" } }, "is a link to \"../elsewhere\"; a projected runtime package cannot contain links"],
      ["an entry without a version", {}, { "node_modules/extra": { resolved: "x" } }, 'entry "node_modules/extra" has no version'],
    ])("rejects %s", (_label, depEntry, extra, message) => {
      const result = validateNpmRuntimePackage(...single("1.0.0", { version: "1.0.0", ...depEntry }, extra));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    });
  });

  // `npm ci --ignore-scripts` does not refuse these packages: it installs them
  // with their own setup skipped, so the failure lands at import time in the
  // installed plugin rather than here.
  describe("lifecycle install scripts", () => {
    const withScript = (extra: Record<string, unknown> = {}) =>
      single("1.0.0", { version: "1.0.0", hasInstallScript: true }, extra);

    it("rejects a direct dependency that needs an install script", () => {
      const result = validateNpmRuntimePackage(...withScript());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("npm ci --ignore-scripts");
        expect(result.error).toContain('"dep"');
        expect(result.error).not.toContain("regenerate the lockfile");
      }
    });

    it("rejects a transitive dependency that needs an install script", () => {
      const result = validateNpmRuntimePackage(
        ...single(
          "1.0.0",
          { version: "1.0.0", dependencies: { native: "^1" } },
          { "node_modules/dep/node_modules/native": { version: "1.0.0", hasInstallScript: true } },
        ),
      );
      expect(result.ok).toBe(false);
      // Named by package, not by nesting location, since that is what the
      // author writes in `allowInstallScripts`.
      if (!result.ok) expect(result.error).toContain('"native"');
    });

    it("accepts one the author has named in allowInstallScripts", () => {
      expect(validateNpmRuntimePackage(...withScript(), { allowInstallScripts: ["dep"] })).toMatchObject({ ok: true });
      expect(validateNpmRuntimePackage(...withScript(), { allowInstallScripts: ["other"] }).ok).toBe(false);
    });

    it("accepts a lock entry that declares no install script", () => {
      expect(validateNpmRuntimePackage(...single("1.0.0", { version: "1.0.0", hasInstallScript: false })).ok).toBe(true);
      expect(validateNpmRuntimePackage(...single("1.0.0", { version: "1.0.0" })).ok).toBe(true);
    });
  });

  it("accepts binary input", () => {
    const encoder = new TextEncoder();
    expect(validateNpmRuntimePackage(encoder.encode(manifest), encoder.encode(lockfile())).ok).toBe(true);
  });

  it.each([
    ["a manifest without dependencies", JSON.stringify({ name: "x" }), lockfile(), "dependencies object"],
    ...["devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"].map(
      (section): [string, string, string, string] => [
        `a manifest with ${section}`,
        JSON.stringify({ dependencies: { left: "1.0.0", right: "^2.0.0" }, [section]: {} }),
        lockfile(),
        `remove ${section}`,
      ],
    ),
    ["a manifest with a non-string dependency", JSON.stringify({ dependencies: { left: 1 } }), lockfile(), "dependencies object"],
    ["invalid manifest JSON", "{", lockfile(), "manifest is not valid JSON"],
    ["a non-JSON lockfile", manifest, "lockfileVersion: '9.0'\n", "pnpm and yarn lockfiles are not supported"],
    ["a lockfile array", manifest, "[]", "JSON object"],
    ["lockfileVersion 1", manifest, lockfile({ lockfileVersion: 1 }), "lockfileVersion 2 or 3"],
    ["a missing lockfileVersion", manifest, lockfile({ lockfileVersion: undefined }), "lockfileVersion 2 or 3"],
    ["a lockfile without a root entry", manifest, JSON.stringify({ lockfileVersion: 3, packages: {} }), 'root "" entry'],
    ["extra root dependencies", manifest, lockfile({}, { dependencies: { left: "1.0.0", right: "^2.0.0", extra: "1" } }), "do not match"],
    ["a changed root dependency range", manifest, lockfile({}, { dependencies: { left: "1.0.0", right: "^3.0.0" } }), "do not match"],
    ["a missing root dependency map", manifest, lockfile({}, { dependencies: undefined }), "do not match"],
    [
      "a locked version outside the manifest range",
      manifest,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { left: "1.0.0", right: "^2.0.0" } },
          "node_modules/left": { version: "1.0.0" },
          "node_modules/right": { version: "1.9.9" },
        },
      }),
      'dependency "right" ("^2.0.0") is locked at 1.9.9, which does not satisfy the spec',
    ],
    [
      "an exact spec locked at a different version",
      manifest,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { left: "1.0.0", right: "^2.0.0" } },
          "node_modules/left": { version: "1.0.1" },
          "node_modules/right": { version: "2.0.0" },
        },
      }),
      'dependency "left" ("1.0.0") is locked at 1.0.1',
    ],
    [
      "an unlocked dependency",
      manifest,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { left: "1.0.0", right: "^2.0.0" } }, "node_modules/left": { version: "1.0.0" } },
      }),
      'does not lock dependency "right"',
    ],
  ])("rejects %s", (_label, manifestText, lockfileText, message) => {
    const result = validateNpmRuntimePackage(manifestText, lockfileText);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
