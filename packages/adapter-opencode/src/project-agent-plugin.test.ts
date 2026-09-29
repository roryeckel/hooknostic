import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
  type SubagentDefinition,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument, TargetSpec } from "@hooknostic/core";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { opencodeAgentPluginProjector, SUBAGENT_NAME_UNQUALIFIED } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const file = (path: string): AgentPluginFile => ({
  path,
  contents: encoder.encode(path),
  mode: 0o644,
});

function source(
  servers: Record<string, AgentPluginMcpServer> = {},
  files: string[] = [],
  directories?: string[],
): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable-tools", version: "1.2.3" },
    skills: [
      {
        name: "review",
        description: "Review code",
        directory: "skills/review",
        manifestPath: "skills/review/SKILL.md",
      },
    ],
    ...(Object.keys(servers).length === 0 ? {} : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } }),
    files: [file("plugin.json"), file("mcp.json"), file("skills/review/SKILL.md"), ...files.map(file)],
    ...(directories === undefined ? {} : { directories }),
    contentDigest: "sha256:source",
  };
}

// Package delivery, because that is the only delivery this projector
// serves: the build gates the projection phase on it, and the projector
// now rejects anything else (assertPackageDelivery).
const target = { id: "opencode", version: ">=1.18 <2", delivery: "package" as const, output: "dist" };
const support = resolveAgentPluginProjection(target, opencodeAgentPluginProjector).matrix!;

/** What `adapter.compile` contributes for package delivery when a config has an `entry`. */
const HOOK_ARTIFACTS = [
  { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
  { path: "index.js", contents: "// replaced by the projector\n" },
  { path: "package.json", contents: "{}\n" },
];

// Defaults to none: a config may declare `components` without an `entry`, and
// that shape has to keep working.
const projectAs = (pkg: AgentPluginPackage, overrides: Partial<TargetSpec>) =>
  opencodeAgentPluginProjector.project(pkg, {
    target: { ...target, ...overrides },
    hookArtifacts: [],
    support,
    onUnsupported: "error",
  });

const project = (pkg: AgentPluginPackage, hookArtifacts: { path: string; contents: string }[] = []) =>
  opencodeAgentPluginProjector.project(pkg, {
    target,
    hookArtifacts,
    support,
    onUnsupported: "error",
  });

function injector(plan: AgentPluginProjectionPlan): string {
  const artifact = plan.files.find((candidate) => candidate.path === "hooknostic-agent-plugin.js")!;
  return typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
}

function launcherDocument(plan: AgentPluginProjectionPlan): McpLauncherDocument {
  const artifact = plan.files.find((candidate) => candidate.path === "hooknostic-runtime/mcp-servers.json")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  return JSON.parse(text) as McpLauncherDocument;
}

function embeddedServers(plan: AgentPluginProjectionPlan): Record<string, Record<string, unknown>> {
  const match = injector(plan).match(/const mcpServers = JSON\.parse\((.*)\);/)!;
  return JSON.parse(JSON.parse(match[1]!) as string) as Record<string, Record<string, unknown>>;
}

describe("Agent Plugin to OpenCode projection", () => {
  // Every validatedOn record for this projection is 1.18.29. A profile reaching
  // below that would let a build claim exact/emulated support for a config hook,
  // a skills.paths merge and an MCP shape nothing has watched on those releases.
  it("carries a runner command through untouched, whatever language it launches", async () => {
    // The dominant real-world shape: of 24 stdio servers configured on one
    // developer machine, every third-party one was a runner (`npx`, `bun`,
    // `uvx`, `docker`, `php`) rather than an interpreter plus a bundled entry.
    const plan = await project(
      source({
        python: { type: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "${PLUGIN_ROOT}"] },
        container: { type: "stdio", command: "docker", args: ["run", "-i", "--rm", "example/mcp"] },
      }),
    );

    const servers = launcherDocument(plan).servers;
    expect(servers.map((server) => server.command)).toEqual(["uvx", "docker"]);
    // The placeholder survives: the launcher expands it at spawn, and rewriting
    // it here would bake in the build machine's path.
    expect(servers[0]?.args).toEqual(["mcp-server-git", "--repository", "${PLUGIN_ROOT}"]);
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("declines versions below the ones its evidence covers", () => {
    const evidenced = opencodeAgentPluginProjector.profiles.flatMap((profile) =>
      (profile.source?.validatedOn ?? []).map((record) => record.version),
    );
    expect(evidenced.length).toBeGreaterThan(0);
    expect(evidenced.every((version) => version.startsWith("1.18."))).toBe(true);

    const older = { id: "opencode", version: ">=1.10 <1.18", delivery: "package" as const, output: "d" };
    expect(resolveAgentPluginProjection(older, opencodeAgentPluginProjector).matrix).toBeUndefined();
  });

  // An MCP server names its implementation with ${PLUGIN_ROOT}/..., so copying
  // only the skill trees leaves that argv pointing at a file the output does not
  // contain -- a server reported emitted that cannot start.
  it("ships the whole package, not only its skills", async () => {
    const plan = await project(source({}, ["src/server.mjs", "assets/data.json"]));
    const paths = plan.files.map((candidate) => candidate.path);
    expect(paths).toContain("package/src/server.mjs");
    expect(paths).toContain("package/assets/data.json");
    expect(paths).toContain("package/skills/review/SKILL.md");
    // The portable documents ship too. Codex drops them because a root
    // plugin.json outranks its native manifest; nested here they outrank
    // nothing, and a server may name one with ${PLUGIN_ROOT}.
    expect(paths).toContain("package/plugin.json");
    expect(paths).toContain("package/mcp.json");
  });

  // The generated root manifest declares `type: "module"` for the generated
  // modules beside it, and Node reads a `.js` file's module system from the
  // nearest package.json ABOVE it. Without a boundary the copied package
  // inherits that manifest, and a CommonJS `node ${PLUGIN_ROOT}/server.js`
  // dies with `require is not defined` -- after being reported emitted.
  // `package.json` is not mandatory in an Agent Plugin package: only
  // plugin.json is, so a package with no manifest of its own is valid input.
  it("keeps a copied package CommonJS when it declares no manifest of its own", async () => {
    const plan = await project(source({}, ["src/server.js"]));
    const root = JSON.parse(text(plan, "package.json")) as Record<string, unknown>;
    expect(root.type).toBe("module");

    expect(JSON.parse(text(plan, "package/package.json"))).toEqual({ type: "commonjs" });
    // Generated, not copied: the summary reports what the author shipped.
    expect(plan.summary.copiedPaths).not.toContain("package/package.json");
  });

  // Their manifest is already the boundary, and whatever module system it
  // declares is theirs to declare -- a generated one would overwrite it and
  // take the package's own `type`, `exports` and `imports` with it.
  it("leaves the author's own manifest as the boundary", async () => {
    const plan = await project(source({}, ["package.json"]));
    expect(plan.files.filter((candidate) => candidate.path === "package/package.json")).toHaveLength(1);
    // `file()` encodes each fixture's own path as its contents, so verbatim
    // copying is what this compares against.
    expect(text(plan, "package/package.json")).toBe("package.json");
    expect(plan.summary.copiedPaths).toContain("package/package.json");
  });

  // Under `onInvalid: "warn"` the loader reports an invalid skill and carries
  // on: the skill leaves `skills` while its files stay in `files`. Copying its
  // SKILL.md into the tree `skills.paths` names would hand OpenCode the skill
  // the loader said it skipped.
  it("drops a rejected skill's subtree while keeping a directory that is not a skill", async () => {
    const rejected = source({}, [
      "skills/broken/SKILL.md",
      "skills/broken/bin/serve.mjs",
      "skills/shared/logo.png",
      "skills/review-notes/SKILL.md",
    ]);
    const plan = await project({
      ...rejected,
      skills: [
        ...rejected.skills,
        {
          name: "review-notes",
          description: "Keep review notes",
          directory: "skills/review-notes",
          manifestPath: "skills/review-notes/SKILL.md",
        },
      ],
    });
    const paths = plan.files.map((candidate) => candidate.path);
    const nested = (path: string) => `package/${path}`;
    // The whole rejected subtree goes, matching Claude and Codex.
    expect(paths).not.toContain(nested("skills/broken/SKILL.md"));
    expect(paths).not.toContain(nested("skills/broken/bin/serve.mjs"));
    expect(plan.summary.copiedPaths).not.toContain(nested("skills/broken/SKILL.md"));
    // `skills/shared` declares no SKILL.md, so it is not a skill and nothing is
    // wrong with this package -- dropping it would be a bug in a valid build.
    expect(paths).toContain(nested("skills/shared/logo.png"));
    // `skills/review-notes` is not inside `skills/review`, so a prefix test
    // would drop a declared skill.
    expect(paths).toContain(nested("skills/review-notes/SKILL.md"));
    expect(paths).toContain(nested("skills/review/SKILL.md"));
    expect(injector(plan)).toContain('const own = join(pluginRoot, "skills");');
    expect(plan.summary.components["agent-plugin.skills"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
  });

  // OpenCode lists skills in one flat namespace, so a second plugin's `review`
  // would hide this one (.capture/opencode-skill-namespace).
  describe("skill names", () => {
    const manifest = "---\nname: review\ndescription: Review code\n---\n\nRun scripts/review.sh.\n";
    const withManifest = (pkg: AgentPluginPackage, path: string, contents: string): AgentPluginPackage => ({
      ...pkg,
      files: pkg.files.map((candidate) =>
        candidate.path === path ? { ...candidate, contents: encoder.encode(contents) } : candidate,
      ),
    });

    it("qualifies each skill by its plugin, in place", async () => {
      const plan = await project(withManifest(source(), "skills/review/SKILL.md", manifest));
      expect(text(plan, "package/skills/review/SKILL.md")).toBe(
        "---\nname: portable-tools-review\ndescription: Review code\n---\n\nRun scripts/review.sh.\n",
      );
      // The directory keeps its portable name, so paths into it still resolve.
      expect(plan.files.map((candidate) => candidate.path)).not.toContain(
        "package/skills/portable-tools-review/SKILL.md",
      );
      // Rewritten, so no longer reported as copied byte for byte.
      expect(plan.summary.copiedPaths).not.toContain("package/skills/review/SKILL.md");
      expect(plan.issues).toEqual([]);
    });

    it("reports a skill that keeps its bare name as degraded, and ships it", async () => {
      const plan = await project(withManifest(source(), "skills/review/SKILL.md", "---\nname: >-\n  review\n---\n"));
      expect(text(plan, "package/skills/review/SKILL.md")).toBe("---\nname: >-\n  review\n---\n");
      expect(plan.summary.copiedPaths).toContain("package/skills/review/SKILL.md");
      // Reported for core to apply components.onDegraded, never raised here.
      expect(plan.issues).toEqual([]);
      expect(plan.summary.degradations).toEqual([
        {
          id: "skill-name-unqualified",
          component: "agent-plugin.skills",
          name: "review",
          path: "skills/review/SKILL.md",
          reason: expect.stringContaining("keeps its bare name") as unknown,
        },
      ]);
      // And the profile declares it, so core will not treat it as a defect.
      expect(support["agent-plugin.skills"]?.degradations?.map((item) => item.id)).toEqual(["skill-name-unqualified"]);
    });

    // What a profile for an OpenCode that qualifies plugin skills itself would
    // resolve to: no declaration, so the projection leaves names as authored.
    it("keeps authored names under a profile that does not declare the degradation", async () => {
      const plan = await opencodeAgentPluginProjector.project(
        withManifest(source(), "skills/review/SKILL.md", manifest),
        {
          target,
          hookArtifacts: [],
          support: { ...support, "agent-plugin.skills": { level: "exact" } },
          onUnsupported: "error",
        },
      );
      expect(text(plan, "package/skills/review/SKILL.md")).toBe(manifest);
      expect(plan.summary.copiedPaths).toContain("package/skills/review/SKILL.md");
      expect(plan.summary.degradations).toBeUndefined();
    });

    // skillNames: "authored" is that same state, chosen by the author on a
    // harness that needs it: exact delivery, nothing declared to report.
    it("resolves authored skill names to exact delivery with nothing to rename", () => {
      const authored = resolveAgentPluginProjection(
        { ...target, skillNames: "authored" },
        opencodeAgentPluginProjector,
      );
      expect(authored.matrix?.["agent-plugin.skills"]).toEqual({ level: "exact" });
      // Everything else is the harness's, untouched by the option.
      expect(authored.matrix?.["agent-plugin.mcp.stdio"]).toEqual(support["agent-plugin.mcp.stdio"]);
      for (const skillNames of [undefined, "qualified"] as const) {
        const qualified = resolveAgentPluginProjection(
          { ...target, ...(skillNames === undefined ? {} : { skillNames }) },
          opencodeAgentPluginProjector,
        );
        expect(qualified.matrix?.["agent-plugin.skills"]).toEqual(
          expect.objectContaining({
            level: "emulated",
            degradations: [expect.objectContaining({ id: "skill-name-unqualified" })],
          }),
        );
      }
    });

    it("still refuses a hook artifact that lands on a rewritten skill manifest", async () => {
      const plan = await project(withManifest(source(), "skills/review/SKILL.md", manifest), [
        { path: "package/skills/review/SKILL.md", contents: "hook" },
      ]);
      expect(plan.issues).toEqual([
        expect.objectContaining({ severity: "error", message: expect.stringContaining("collides") as unknown }),
      ]);
    });
  });

  it("refuses to project for project delivery", async () => {
    // The projector only ever runs for package delivery: build.ts gates the
    // projection phase on it, inspect routes a project-delivery query to
    // projectComponentProfiles, and project delivery itself goes through
    // adapter.projectComponents. Nothing enforced that at this entry point,
    // though, so a caller passing "project" silently received package-shaped
    // output -- which is how a playback cell came to assert a layout no build
    // produces, and why it only surfaced once the package layout changed.
    await expect(
      opencodeAgentPluginProjector.project(source({}), {
        target: { ...target, delivery: "project" as const },
        hookArtifacts: [],
        support,
        onUnsupported: "error",
      }),
    ).rejects.toThrow(/package delivery only/);
  });

  it("nests package content below the generated package root", async () => {
    const plan = await project(source({}, ["helper.js", "index.ts"]));
    // Package delivery loads exactly one module -- the entry named by
    // exports["./server"] -- so the flat-scan rule that shaped project delivery
    // no longer applies. What still must hold is that the author's files cannot
    // occupy a generated name at the package root: this package ships an
    // `index.ts` that would sit beside the generated `index.js` entry.
    const topLevel = plan.files.map((candidate) => candidate.path).filter((path) => !path.includes("/"));
    expect(topLevel.sort()).toEqual(["hooknostic-agent-plugin.js", "index.js", "package.json"]);
    expect(plan.files.map((candidate) => candidate.path)).toContain("package/index.ts");
  });

  function text(plan: AgentPluginProjectionPlan, path: string): string {
    const artifact = plan.files.find((candidate) => candidate.path === path);
    if (artifact === undefined) throw new Error(`plan has no ${path}; got ${plan.files.map((f) => f.path).join(", ")}`);
    return typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  }

  it('declares the plugin entry through exports["./server"]', async () => {
    const plan = await project(source({}));
    const manifest = JSON.parse(text(plan, "package.json")) as Record<string, unknown>;
    // Measured on 1.18.30: exports["./server"] is preferred over `main` when the
    // two name different files, so it is the field that actually selects the
    // entry. `main` is emitted too, but it is not what OpenCode reads here.
    expect(manifest["exports"]).toEqual({ "./server": "./index.js" });
    expect(manifest["type"]).toBe("module");
    expect(manifest["name"]).toBe("portable-tools");
    expect(manifest["version"]).toBe("1.2.3");
  });

  it("re-exports both plugins from the single entry module", async () => {
    const plan = await project(source({}), HOOK_ARTIFACTS);
    const entry = text(plan, "index.js");
    // One entry, two distinct exported functions: OpenCode loads each exactly
    // once. Re-exporting a `default` as well would alias HooknosticPlugin and
    // make correctness depend on the harness de-duplicating them.
    expect(entry).toContain('export { HooknosticPlugin } from "./hooknostic.js";');
    expect(entry).toContain('export { default as HooknosticComponents } from "./hooknostic-agent-plugin.js";');
    expect(entry).not.toContain("export default");
  });

  it("omits the hook re-export when the config declared no entry", async () => {
    const plan = await project(source({}));
    const entry = text(plan, "index.js");
    // Importing a module the output does not contain fails the WHOLE plugin at
    // load, so a components-only package would lose its skills and MCP servers
    // to a hook module nobody asked for.
    expect(entry).not.toContain("hooknostic.js");
    expect(entry).toContain("HooknosticComponents");
    const manifest = JSON.parse(text(plan, "package.json")) as { files: string[] };
    expect(manifest.files).not.toContain("hooknostic.js");
  });

  it("replaces the compiler's standalone entry and manifest rather than colliding", async () => {
    const plan = await project(source({}), HOOK_ARTIFACTS);
    // The compiler emits these two so a hooks-only package is loadable without
    // a projector. When one runs it knows strictly more, so its versions win --
    // exactly once each, not as a duplicate path.
    expect(plan.files.filter((f) => f.path === "index.js")).toHaveLength(1);
    expect(plan.files.filter((f) => f.path === "package.json")).toHaveLength(1);
    expect(text(plan, "package.json")).not.toBe("{}\n");
    expect(plan.issues.filter((issue) => issue.message.includes("collides"))).toEqual([]);
  });

  it("refuses a manifest name npm would reject as a package name", async () => {
    const pkg = source({});
    const plan = await project({
      ...pkg,
      manifest: { ...pkg.manifest, name: "Portable Tools" },
    });
    // Coercing the name would publish under something the author never chose.
    expect(
      plan.issues.some(
        (issue) => issue.severity === "error" && issue.path === "package.json" && issue.message.includes("npm"),
      ),
    ).toBe(true);
  });

  it("warns that a versionless package cannot be published, but still emits it", async () => {
    const pkg = source({});
    const { version: _dropped, ...manifest } = pkg.manifest;
    const plan = await project({ ...pkg, manifest });

    // A warning rather than an error: the package still loads from a local
    // path, which is a supported route. Publication is the one it cannot reach,
    // and npm only says so at `npm publish` -- long after the build.
    const warning = plan.issues.find((issue) => issue.message.includes("cannot be published"));
    expect(warning?.severity).toBe("warn");
    expect(warning?.path).toBe("package.json");
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(JSON.parse(text(plan, "package.json")).version).toBeUndefined();
  });

  // The manifest loader accepts any string here, so presence is not
  // publishability: a dist-tag or a range reaches the projector intact and npm
  // would refuse every one of them.
  it.each([
    ["next", "next"],
    ["^1.0.0", "^1.0.0"],
    ["1.0", "1.0"],
    ["", ""],
  ])("warns that a package versioned %j cannot be published", async (version) => {
    const pkg = source({});
    const plan = await project({ ...pkg, manifest: { ...pkg.manifest, version } });

    const warning = plan.issues.find((issue) => issue.message.includes("cannot be published"));
    expect(warning?.severity).toBe("warn");
    expect(warning?.message).toContain(JSON.stringify(version));
    // Still emitted: the local-path route does not care, and refusing here
    // would break a supported way to ship.
    expect(JSON.parse(text(plan, "package.json")).version).toBe(version);
  });

  // No route on this harness reads the component's manifest, so the omission is
  // permanent -- but its stated reason has to describe the real obstacle, and it
  // survived one round of being wrong because nothing exercised it.
  it("explains the runtime-package omission by what no route reads", async () => {
    const plan = await opencodeAgentPluginProjector.project(source({}), {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      runtimePackage: { manifest: "runtime/package.json", lockfile: "runtime/package-lock.json" },
    });

    const omission = plan.summary.omissions.find((candidate) => candidate.component === "agent-plugin.runtime-package");
    expect(omission?.reason).toContain("generated root manifest");
    // A registry-installed package IS installed, so the old explanation --
    // "loaded from a local path rather than installed" -- is now false.
    expect(omission?.reason).not.toContain("rather than installed");
  });

  it("publishes under the target's npm coordinate when it declares one", async () => {
    const plan = await projectAs(source({}), { npmName: "@example/portable-tools-opencode" });
    const manifest = JSON.parse(text(plan, "package.json")) as Record<string, unknown>;

    // The Agent Plugins name grammar admits only [a-z0-9.-], so a scoped
    // coordinate is unspellable there and this is the only route to one.
    expect(manifest.name).toBe("@example/portable-tools-opencode");
    // Identity the manifest CAN express is still the manifest's.
    expect(manifest.version).toBe("1.2.3");
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("falls back to the manifest name when no coordinate is declared", async () => {
    const plan = await project(source({}));
    expect((JSON.parse(text(plan, "package.json")) as Record<string, unknown>).name).toBe("portable-tools");
  });

  it("checks the coordinate npm will actually see, and says which one it is", async () => {
    const plan = await projectAs(source({}), { npmName: "@Scope/Name" });

    const issue = plan.issues.find((candidate) => candidate.message.includes("not a valid npm package name"));
    expect(issue?.severity).toBe("error");
    // Naming the manifest here would send the author to the wrong file.
    expect(issue?.message).toContain("npmName");
    expect(issue?.message).toContain('"@Scope/Name"');
  });

  it.each(["http", `a-${"n".repeat(215)}`])(
    "warns rather than fails when manifest name %s only blocks publication",
    async (name) => {
      const pkg = source({});
      const plan = await project({ ...pkg, manifest: { ...pkg.manifest, name } });

      const issue = plan.issues.find((candidate) => candidate.message.includes("not a valid npm package name"));
      // npm still installs a name in this tier from a local path, which is a
      // supported route; publication is the one it cannot reach -- the same
      // reasoning the manifest version check beside it already applies.
      expect(issue?.severity).toBe("warn");
      expect(plan.issues.filter((candidate) => candidate.severity === "error")).toEqual([]);
      expect(JSON.parse(text(plan, "package.json")).name).toBe(name);
    },
  );

  it.each(["_under", ".leading", "has space"])("fails a manifest name npm cannot install at all: %s", async (name) => {
    const pkg = source({});
    const plan = await project({ ...pkg, manifest: { ...pkg.manifest, name } });

    const issue = plan.issues.find((candidate) => candidate.message.includes("not a valid npm package name"));
    expect(issue?.severity).toBe("error");
  });

  it("fails an npm coordinate that only blocks publication, because publishing is why it exists", async () => {
    // A manifest name is the plugin's identity and may never be published; an
    // npmName is declared for no other purpose, so the publication tier is
    // fatal here and advisory there.
    const plan = await projectAs(source({}), { npmName: "http" });

    const issue = plan.issues.find((candidate) => candidate.message.includes("not a valid npm package name"));
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("npmName");
  });

  it("stays silent when the manifest carries a version npm would accept", async () => {
    for (const version of ["1.2.3", "v2.0.0", "1.0.0-rc.1"]) {
      const pkg = source({});
      const plan = await project({ ...pkg, manifest: { ...pkg.manifest, version } });

      expect(
        plan.issues.filter((issue) => issue.message.includes("cannot be published")),
        version,
      ).toEqual([]);
      expect(JSON.parse(text(plan, "package.json")).version).toBe(version);
    }
  });

  it("points ${PLUGIN_ROOT} at the nested package, not at the module", async () => {
    const plan = await project(source({}, ["src/server.mjs"]));
    expect(injector(plan)).toContain("const here = dirname(fileURLToPath(import.meta.url));");
    expect(injector(plan)).toContain('const pluginRoot = join(here, "package");');
    // A sibling of the package, so it is neither inside the author's namespace
    // nor at the level OpenCode's flat scan loads.
    expect(injector(plan)).toContain('const launcher = join(here, "hooknostic-runtime", "mcp-launcher.mjs");');
  });

  // OpenCode binds neither variable, so every stdio server runs through the
  // launcher. McpLocalConfig's own cwd description says a relative one "resolves
  // from the workspace directory", so the launcher is anchored absolutely; it
  // then chdirs the server itself.
  it("launches every stdio server through the generated launcher", async () => {
    const plan = await project(
      source({
        worker: {
          type: "stdio",
          command: "./bin/serve",
          cwd: "${PLUGIN_ROOT}/worker",
          // Declared, so the "no environment key" assertion below has something
          // to bite on: without it the emitted server has none either way.
          env: { TOKEN: "literal", CONFIG: "${PLUGIN_ROOT}/c.json" },
        },
        plain: { type: "stdio", command: "node", args: ["server.mjs"] },
      }),
    );
    const servers = embeddedServers(plan);
    expect(servers["worker"]).toEqual({
      type: "local",
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "0"],
      cwd: "__HOOKNOSTIC_PLUGIN_ROOT__",
      enabled: true,
    });
    expect(servers["plain"]).toMatchObject({
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "1"],
    });
    // Never emitted: whether OpenCode merges `environment` with the parent or
    // replaces it is uncaptured, and replacing would strip the PATH that
    // command[0] resolves through. The launcher applies it instead.
    for (const server of Object.values(servers)) expect(server).not.toHaveProperty("environment");
    expect(launcherDocument(plan).servers.map((entry) => entry.name)).toEqual(["worker", "plain"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
  });

  // The module is what OpenCode actually runs, so the markers have to become
  // real absolute paths at load time -- on Windows too, where a JSON round-trip
  // of a plugin root would corrupt its backslashes.
  it("resolves both markers to real paths when the module is loaded", async () => {
    const plan = await project(
      source({
        srv: { type: "stdio", command: "node" },
        api: {
          type: "streamable-http",
          // Carries the marker AND an unrecognized placeholder: a client MUST
          // NOT expand in url or headers, so neither may be rewritten at load.
          url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/${TENANT}/mcp",
        },
      }),
    );
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-injector-"));
    try {
      const modulePath = join(dir, "hooknostic-agent-plugin.mjs");
      await writeFile(modulePath, injector(plan));
      const config: { mcp?: Record<string, Record<string, unknown>> } = {};
      const plugin = await (await import(pathToFileURL(modulePath).href)).default();
      plugin.config(config);
      expect(config.mcp!["srv"]!["command"]).toEqual([
        "node",
        join(dir, "hooknostic-runtime", "mcp-launcher.mjs"),
        "0",
      ]);
      expect(config.mcp!["srv"]!["cwd"]).toBe(join(dir, "package"));
      // A remote server is returned untouched: neither the marker nor the
      // unrecognized placeholder is rewritten.
      expect(config.mcp!["api"]!["url"]).toBe("https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/${TENANT}/mcp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // U+2028 and U+2029 are JavaScript line terminators that JSON.stringify leaves
  // literal, and `description` and `version` are unconstrained strings in the
  // schema. Unescaped, a package's own metadata ends the generated `//` comment
  // and the rest of it RUNS -- confirmed by loading the module before the fix.
  it("neutralizes line terminators in the metadata comment", async () => {
    const pkg = source();
    pkg.manifest = {
      ...pkg.manifest,
      description: "harmless globalThis.HOOKNOSTIC_PWNED = 'yes'; //",
      version: "1.0.0 globalThis.HOOKNOSTIC_PWNED_TOO = 'yes'; //",
    };
    const plan = await project(pkg);
    const text = injector(plan);
    expect(text).not.toContain(" ");
    expect(text).not.toContain(" ");

    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-metadata-"));
    try {
      const modulePath = join(dir, "injector.mjs");
      await writeFile(modulePath, text);
      await import(pathToFileURL(modulePath).href);
      const scope = globalThis as Record<string, unknown>;
      expect(scope["HOOKNOSTIC_PWNED"]).toBeUndefined();
      expect(scope["HOOKNOSTIC_PWNED_TOO"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A backslash is an ordinary filename character on POSIX and a separator on
  // Windows, so a package built on one and consumed on the other resolves
  // outside the plugin root.
  it.each([
    ["command", { type: "stdio" as const, command: "./..\\..\\tool.exe" }],
    ["cwd", { type: "stdio" as const, command: "node", cwd: "./..\\..\\Windows" }],
  ])("omits a server whose %s would resolve differently on the consumer", async (_label, server) => {
    const plan = await project(source({ srv: server }));
    expect(Object.keys(embeddedServers(plan))).toEqual([]);
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
    );
  });

  it("keeps the launcher beside the package, not inside it", async () => {
    const plan = await project(source({ srv: { type: "stdio", command: "node" } }));
    const paths = plan.files.map((candidate) => candidate.path);
    expect(paths).toContain("hooknostic-runtime/mcp-launcher.mjs");
    expect(paths).toContain("hooknostic-runtime/mcp-servers.json");
    // The launcher is generated, so it must stay out of `package/`, which is
    // the author's namespace and is copied verbatim.
    expect(paths.filter((path) => path.startsWith("package/"))).not.toContain("package/hooknostic-runtime");
    expect(paths.filter((path) => !path.includes("/")).sort()).toEqual([
      "hooknostic-agent-plugin.js",
      "index.js",
      "package.json",
    ]);
  });

  // Staging creates parents for emitted files only, so a directory carrying no
  // files -- a server's cwd, typically -- has to be named in the plan or it
  // never reaches the output and the server cannot start.
  it("carries an empty package directory into the nested package", async () => {
    const plan = await project(source({ worker: { type: "stdio", command: "node", cwd: "./worker" } }, [], ["worker"]));
    expect(plan.directories).toContain("package/worker");
  });

  // Inverted: the refusal existed because package text used to flow through the
  // module's textual substitution. It no longer does -- the declaration goes to
  // the servers document, which the module never reads -- so refusing would
  // drop a harmless package.
  it("keeps a package containing the substitution marker", async () => {
    const plan = await project(
      source({
        odd: { type: "stdio", command: "node", args: ["__HOOKNOSTIC_PLUGIN_ROOT__/x"] },
        api: {
          type: "streamable-http",
          url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      }),
    );
    expect(plan.summary.omissions).toEqual([]);
    const servers = embeddedServers(plan);
    // The emitted local server carries only Hooknostic's own markers, so the
    // package's literal text cannot be rewritten...
    expect(servers["odd"]).toMatchObject({
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "0"],
    });
    // ...and it survives verbatim where the launcher reads it.
    expect(launcherDocument(plan).servers[0]!.args).toEqual(["__HOOKNOSTIC_PLUGIN_ROOT__/x"]);
    // A remote server is never walked, so its marker-bearing url is untouched.
    expect(servers["api"]).toMatchObject({
      url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
  });

  it("leaves remote fields and unrecognized placeholders literal", async () => {
    const plan = await project(
      source({
        api: {
          type: "streamable-http",
          url: "https://example.invalid/${TENANT}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      }),
    );
    // Agent Plugins 1.0: clients MUST NOT expand in url or headers, and
    // unrecognized placeholder-like text MUST stay literal. Resolving ${TOKEN}
    // from the environment would send a host secret to a package-chosen host.
    expect(embeddedServers(plan)["api"]).toMatchObject({
      type: "remote",
      url: "https://example.invalid/${TENANT}/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    expect(injector(plan)).not.toContain("process.env");
    // Substitution is confined to a local server's argv, cwd and environment;
    // a remote server is returned untouched rather than walked.
    expect(injector(plan)).toContain('server.type !== "local"');
  });

  it("emits a server whose paths need ${PLUGIN_DATA}", async () => {
    const plan = await project(
      source({ stateful: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}/state"] } }),
    );
    // The launcher creates and binds the directory, so this is no longer a
    // portable shape with no representation here.
    expect(Object.keys(embeddedServers(plan))).toEqual(["stateful"]);
    expect(plan.summary.omissions).toEqual([]);
    expect(launcherDocument(plan).servers[0]!.args).toEqual(["${PLUGIN_DATA}/state"]);
  });

  it("omits a working directory that climbs out of the directory it is anchored on", async () => {
    for (const cwd of ["${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape"]) {
      const plan = await project(source({ srv: { type: "stdio", command: "node", cwd } }));
      expect(Object.keys(embeddedServers(plan))).toEqual([]);
      expect(plan.summary.omissions).toContainEqual(
        expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
      );
    }
  });

  it("keeps a server whose name would collide with Object.prototype", async () => {
    const plan = await project(
      source({ ["__proto__"]: { type: "stdio", command: "node" } } as Record<string, AgentPluginMcpServer>),
    );
    // Written as an object literal this key would set the prototype, so the
    // module is emitted as JSON text and parsed at load time instead.
    expect(Object.keys(embeddedServers(plan))).toEqual(["__proto__"]);
    expect(injector(plan)).toContain("Object.defineProperty(config.mcp, name, {");
  });

  const projectWithMaterializedTree = (pkg: AgentPluginPackage, into: string, path: string) =>
    opencodeAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        { provider: "fixture", into, files: [{ path, contents: encoder.encode(path), mode: 0o644 }] },
      ],
    });

  it("places a materialized package tree inside the nested package, not beside it", async () => {
    const plan = await projectWithMaterializedTree(source(), "generated/dependencies", "library/data.bin");

    // OpenCode's ${PLUGIN_ROOT} is the nested package directory, so a
    // root-level tree would be unreachable from the mcp.json naming it.
    expect(plan.files.some((candidate) => candidate.path === "package/generated/dependencies/library/data.bin")).toBe(
      true,
    );
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // The bytes came from an installer, not the package: the summary's
    // "copied byte-for-byte" list must not claim them.
    expect(plan.summary.copiedPaths).not.toContain("package/generated/dependencies/library/data.bin");
  });

  it("refuses a hook artifact that collides with a materialized package tree", async () => {
    // Both are output this projector emits, so the collision is named by the
    // materializer's destination rather than as a bare duplicate in core.
    const plan = await opencodeAgentPluginProjector.project(source(), {
      target,
      hookArtifacts: [{ path: "package/generated/shared/data.bin", contents: "// hook" }],
      support,
      onUnsupported: "error",
      materializedTrees: [
        {
          provider: "fixture",
          into: "generated/shared",
          files: [{ path: "data.bin", contents: encoder.encode("materialized"), mode: 0o644 }],
        },
      ],
    });

    const issue = plan.issues.find((candidate) => candidate.path === "package/generated/shared/data.bin");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("collides with a materialized package tree");
  });
});

describe("subagents in an OpenCode v1 package projection", () => {
  const subagent = (name: string, native: SubagentDefinition["native"] = {}): SubagentDefinition => ({
    name,
    description: `${name} description`,
    instructions: `${name} instructions\n`,
    native,
    source: `/project/agents/${name}.md`,
  });
  const projectWith = (subagents: SubagentDefinition[], matrix: typeof support = support) =>
    opencodeAgentPluginProjector.project(source(), {
      target,
      hookArtifacts: [],
      support: matrix,
      onUnsupported: "error",
      subagents,
    });
  // The fixture skill has no frontmatter to rename, so it reports a skill
  // degradation of its own; these tests are about subagents.
  const subagentDegradations = (plan: AgentPluginProjectionPlan) =>
    (plan.summary.degradations ?? []).filter((item) => item.component.startsWith("subagents."));
  /** Runs the generated module's config hook, as OpenCode would, on `config`. */
  async function configured(plan: AgentPluginProjectionPlan, config: { agent?: Record<string, unknown> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-agents-"));
    try {
      const modulePath = join(dir, "hooknostic-agent-plugin.mjs");
      await writeFile(modulePath, injector(plan));
      const plugin = await (await import(pathToFileURL(modulePath).href)).default();
      plugin.config(config);
      return config;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("registers each subagent through the config hook under its plugin-qualified name", async () => {
    const plan = await projectWith([subagent("reviewer", { opencode: { model: "provider/model", temperature: 0.1 } })]);
    expect(plan.issues).toEqual([]);
    const config = await configured(plan, { agent: { build: { model: "kept" } } });
    expect(config.agent).toEqual({
      // An agent the project configured survives the injection.
      build: { model: "kept" },
      // Native fields first, then the portable core, as opencode.json spells it.
      "portable-tools-reviewer": {
        model: "provider/model",
        temperature: 0.1,
        description: "reviewer description",
        mode: "subagent",
        prompt: "reviewer instructions\n",
      },
    });
    expect(plan.summary.components["subagents.definition"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.summary.components["subagents.native"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(subagentDegradations(plan)).toEqual([]);
  });

  it("keeps a name already qualified by its plugin, and reports a name it cannot qualify", async () => {
    const long = `a${"b".repeat(55)}`;
    const plan = await projectWith([
      subagent("portable-tools-helper"),
      subagent(long),
      // Qualifying `status` would collide with the definition already named for it.
      subagent("status"),
      subagent("portable-tools-status"),
    ]);
    expect(Object.keys((await configured(plan)).agent!)).toEqual([
      "portable-tools-helper",
      long,
      "status",
      "portable-tools-status",
    ]);
    expect(subagentDegradations(plan)).toEqual([
      expect.objectContaining({ id: SUBAGENT_NAME_UNQUALIFIED, component: "subagents.definition", name: long }),
      expect.objectContaining({ id: SUBAGENT_NAME_UNQUALIFIED, component: "subagents.definition", name: "status" }),
    ]);
  });

  it("qualifies nothing and reports nothing once the matrix stops declaring the degradation", async () => {
    // The declaration is the switch (ADR-0019), as it is for skills.
    const plan = await projectWith([subagent("reviewer")], {
      ...support,
      "subagents.definition": { level: "emulated" },
    });
    expect(Object.keys((await configured(plan)).agent!)).toEqual(["reviewer"]);
    expect(subagentDegradations(plan)).toEqual([]);
  });

  it("leaves the module unchanged for a package with no subagents", async () => {
    const plan = await projectWith([]);
    expect(injector(plan)).not.toContain("config.agent");
    expect(plan.summary.components["subagents.definition"]).toBeUndefined();
  });
});
