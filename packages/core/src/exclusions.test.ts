import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";
import { type HooknosticConfig, hooknosticConfigSchema } from "@hooknostic/sdk";

import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";
import { planProjectSkillPolicies } from "./skill-policy.js";

const registry = defaultAdapterRegistry();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(delivery: "package" | "project" = "package", adapters = ["claude", "copilot"]) {
  const root = await mkdtemp(join(tmpdir(), "hkn-exclusions-"));
  roots.push(root);
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, "export default {};\n");
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "exclusions" }),
  );
  await mkdir(join(root, "skills/review"), { recursive: true });
  await writeFile(join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview.\n");
  await writeFile(join(root, "skills/review/helper.txt"), "helper\n");
  await mkdir(join(root, "server"));
  await writeFile(join(root, "server/run"), "#!/usr/bin/env node\n");
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { sample: { type: "stdio", command: "./server/run" } },
    }),
  );
  const config: HooknosticConfig = {
    ...(delivery === "project" ? { project: { root: "." } } : {}),
    components: { root: ".", executableFiles: ["server/run"] },
    targets: Object.fromEntries(
      adapters.map((adapter, index) => [
        index === 0 ? "keep" : "omit",
        {
          adapter,
          version: registry[adapter]!.harness.referenceVersion,
          delivery,
          output: delivery === "package" ? `dist/${index}` : `.hooknostic/artifacts/${index}`,
        },
      ]),
    ),
  };
  const options = () => ({ configPath, registry, configResult: { config, diagnostics: [] } });
  return {
    root,
    config: config as HooknosticConfig,
    options,
    build: (targets?: string[]) => buildProject({ ...options(), dryRun: true, ...(targets ? { targets } : {}) }),
  };
}

describe("per-target exclusions", () => {
  it.each(["target", "global"] as const)(
    "keeps direct skill exclusions collection-relative for %s rules",
    async (kind) => {
      const f = await fixture("project", ["codex"]);
      await mkdir(join(f.root, "skills/skills"));
      await writeFile(
        join(f.root, "skills/skills/SKILL.md"),
        "---\nname: skills\ndescription: Another skill\n---\nAnother.\n",
      );
      f.config.components = {
        skills: ["skills"],
        ...(kind === "target" ? { excludeFor: { keep: ["skills/**"] } } : { exclude: ["skills/**"] }),
      };
      const result = await runProject({ ...f.options(), command: "sync" });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.targets!.keep!.project!.components["agent-plugin.skills"]!.emitted).toBe(1);
      expect(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).toContain("Review.");
      await expect(readFile(join(f.root, ".agents/skills/skills/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
    },
  );

  it.each(["linked skill", "unrelated broken link"])("detects authored exclusions with a native %s", async (kind) => {
    const f = await fixture("project", ["codex"]);
    await mkdir(join(f.root, ".agents/skills"), { recursive: true });
    const native = join(f.root, ".agents/skills/review");
    if (kind === "linked skill") await symlink(join(f.root, "skills/review"), native, "junction");
    else {
      await mkdir(native);
      await writeFile(join(native, "SKILL.md"), await readFile(join(f.root, "skills/review/SKILL.md")));
      await symlink(join(f.root, "missing"), join(f.root, ".agents/skills/unrelated"), "junction");
    }
    f.config.components = { skills: ["skills"], excludeFor: { keep: ["review/**"] } };
    const blocked = await runProject({ ...f.options(), command: "sync" });
    expect(blocked.ok).toBe(false);
    expect(blocked.targets!.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ status: "exposed", nativePath: ".agents/skills/review/SKILL.md", writer: "authored" }),
    );
    f.config.components.accept = ["codex:skill-exclusion-unenforced"];
    const accepted = await runProject({ ...f.options(), command: "sync" });
    expect(accepted.errors).toEqual([]);
    expect(accepted.ok).toBe(true);
    expect(accepted.targets!.keep!.project!.components["agent-plugin.skills"]!.emitted).toBe(1);
    expect(await readFile(join(native, "SKILL.md"), "utf8")).toContain("Review.");
    if (kind === "linked skill") expect((await lstat(native)).isSymbolicLink()).toBe(true);
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
  });

  it("preserves exclusion intent when project version analysis fails before integration", async () => {
    const f = await fixture("project", ["codex"]);
    f.config.components = { skills: ["skills"], excludeFor: { keep: ["review/**"] } };
    f.config.targets.keep!.version = "99.0.0";
    const result = await f.build();
    expect(result.ok).toBe(false);
    expect(result.report.targets.keep!.project?.authorExclusions).toMatchObject({
      patterns: ["review/**"],
      matches: [expect.objectContaining({ path: "review", status: "omitted" })],
    });
  });

  it("reports authored native files hidden by default delivery exclusions", async () => {
    const f = await fixture("project", ["codex"]);
    await mkdir(join(f.root, ".agents/skills/review"), { recursive: true });
    await writeFile(
      join(f.root, ".agents/skills/review/SKILL.md"),
      await readFile(join(f.root, "skills/review/SKILL.md")),
    );
    const native = join(f.root, ".agents/skills/review/.env");
    await writeFile(native, "CONSTRUCTED_FIXTURE=preserve\n");
    f.config.components = { skills: [".agents/skills"], excludeFor: { keep: ["review/.env"] } };
    const blocked = await f.build();
    expect(blocked.ok).toBe(false);
    expect(blocked.report.targets.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ status: "exposed", nativePath: ".agents/skills/review/.env", writer: "authored" }),
    );
    f.config.components.accept = ["codex:skill-exclusion-unenforced"];
    const accepted = await runProject({ ...f.options(), command: "sync" });
    expect(accepted.errors).toEqual([]);
    expect(accepted.ok).toBe(true);
    expect(await readFile(native, "utf8")).toBe("CONSTRUCTED_FIXTURE=preserve\n");
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
  });

  it("unions native file observations across readers with different exclusions", async () => {
    const f = await fixture("project", ["codex", "copilot"]);
    await mkdir(join(f.root, ".agents/skills/review"), { recursive: true });
    await writeFile(
      join(f.root, ".agents/skills/review/SKILL.md"),
      await readFile(join(f.root, "skills/review/SKILL.md")),
    );
    await writeFile(join(f.root, ".agents/skills/review/.env"), "CONSTRUCTED_FIXTURE=preserve\n");
    await writeFile(join(f.root, ".agents/skills/review/helper.txt"), "authored helper\n");
    f.config.components = {
      skills: [".agents/skills"],
      excludeFor: { keep: ["review/.env"], omit: ["review/helper.txt"] },
      accept: ["copilot:skill-exclusion-unenforced"],
    };
    const result = await f.build();
    expect(result.ok).toBe(false);
    expect(result.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN101", severity: "error", target: "keep" }),
    );
    expect(result.report.targets.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ status: "exposed", nativePath: ".agents/skills/review/.env", writer: "authored" }),
    );
    expect(result.report.targets.omit!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({
        status: "exposed",
        nativePath: ".agents/skills/review/helper.txt",
        writer: "authored",
      }),
    );
  });

  it.each([{ patterns: [] }, { patterns: ["review/absent.txt"] }, { patterns: ["review/.env"] }])(
    "ignores unrelated native dependency links when observing $patterns",
    async ({ patterns }) => {
      const f = await fixture("project", ["codex"]);
      await mkdir(join(f.root, ".agents/skills/review/node_modules"), { recursive: true });
      await writeFile(
        join(f.root, ".agents/skills/review/SKILL.md"),
        await readFile(join(f.root, "skills/review/SKILL.md")),
      );
      await writeFile(join(f.root, ".agents/skills/review/.env"), "CONSTRUCTED_FIXTURE=preserve\n");
      await symlink(join(f.root, "missing"), join(f.root, ".agents/skills/review/node_modules/dependency"), "junction");
      f.config.components = { skills: [".agents/skills"], excludeFor: { keep: patterns }, onDegraded: "warn" };
      const result = await f.build();
      expect(result.ok).toBe(true);
      expect(result.report.diagnostics.some((diagnostic) => diagnostic.code === "HN501")).toBe(false);
      expect(result.report.diagnostics.some((diagnostic) => diagnostic.code === "HN101")).toBe(
        patterns.includes("review/.env"),
      );
    },
  );

  it("validates target aliases and participating targets", async () => {
    const f = await fixture();
    f.config.components!.excludeFor = { omit: ["mcp.json"] };
    expect(hooknosticConfigSchema.safeParse(f.config).success).toBe(true);
    expect(
      hooknosticConfigSchema.safeParse({
        ...f.config,
        components: { ...f.config.components, excludeFor: { omit: [42] } },
      }).success,
    ).toBe(false);
    f.config.components!.excludeFor = { copilot: [] };
    expect(hooknosticConfigSchema.safeParse(f.config).success).toBe(false);
    f.config.components!.excludeFor = { omit: [] };
    f.config.entry = "hooks.ts";
    f.config.components!.targets = ["keep"];
    expect(hooknosticConfigSchema.safeParse(f.config).success).toBe(false);
  });

  it("omits MCP and executable files only from the selected package and reports intent", async () => {
    const f = await fixture();
    f.config.components!.excludeFor = { omit: ["mcp.json", "server/**"] };
    const result = await f.build();
    expect(result.report.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const keep = result.plan!.find((plan) => plan.target === "keep")!;
    const omit = result.plan!.find((plan) => plan.target === "omit")!;
    expect(keep.artifacts.some((file) => file.path.endsWith("server/run"))).toBe(true);
    expect(omit.artifacts.some((file) => file.path.includes("server/") || file.path.endsWith("mcp.json"))).toBe(false);
    expect(omit.artifacts.some((file) => file.path.endsWith("skills/review/SKILL.md"))).toBe(true);
    expect(result.report.targets.omit!.projection!.authorExclusions!.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "mcp.json", status: "omitted" })]),
    );
    expect(result.report.targets.omit!.projection!.omissions).toEqual([]);
    expect(result.report.targets.omit!.mcpServers).toEqual([]);
    expect(result.report.targets.keep!.mcpServers).toHaveLength(1);
  });

  it("filters invalid input before validation, including partial target selection", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "mcp.json"), "not JSON");
    f.config.components!.excludeFor = { omit: ["mcp.json"] };
    expect((await f.build(["omit"])).ok).toBe(true);
    expect((await f.build()).ok).toBe(false);
  });

  it("rejects retained MCP commands whose executable is excluded and mandatory manifests", async () => {
    const f = await fixture();
    f.config.components!.excludeFor = { omit: ["server/**"] };
    expect((await f.build()).ok).toBe(false);
    f.config.components!.excludeFor = { omit: ["plugin.json"] };
    expect((await f.build()).ok).toBe(false);
  });

  it.each(["error", "warn", "accept"] as const)("reports shared discovery with %s policy", async (policy) => {
    const f = await fixture("project", ["codex", "copilot"]);
    f.config.components = {
      skills: ["skills"],
      excludeFor: { omit: ["review/**"] },
      ...(policy === "warn" ? { onDegraded: "warn" } : {}),
      ...(policy === "accept" ? { accept: ["copilot:skill-exclusion-unenforced"] } : {}),
    };
    const result = await f.build();
    expect(result.ok).toBe(policy !== "error");
    expect(result.report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "HN101",
          target: "omit",
          severity: policy === "accept" ? "info" : policy,
        }),
      ]),
    );
    expect(result.report.targets.omit!.project!.components["agent-plugin.skills"]!.emitted).toBe(1);
    expect(result.report.targets.omit!.project!.authorExclusions!.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "exposed", reader: "omit", writer: "keep" })]),
    );
  });

  it("composes auxiliary files without silently dropping a retaining target's file", async () => {
    const f = await fixture("project", ["codex", "copilot"]);
    f.config.components = { skills: ["skills"], excludeFor: { omit: ["review/helper.txt"] }, onDegraded: "warn" };
    const result = await f.build();
    expect(result.ok).toBe(true);
    expect(result.report.targets.omit!.project!.degradations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "copilot:skill-exclusion-unenforced", path: ".agents/skills/review/helper.txt" }),
      ]),
    );
    expect(
      result
        .plan!.find((plan) => plan.target === "keep")!
        .integration!.files.some((file) => file.path.endsWith("helper.txt")),
    ).toBe(true);
  });

  it("disables excluded direct MCP in shared project configuration and restores it", async () => {
    const f = await fixture("project");
    f.config.components = { mcp: "mcp.json", excludeFor: { omit: ["mcp.json"] } };
    const first = await runProject({ ...f.options(), command: "sync" });
    expect(first.errors).toEqual([]);
    expect(first.ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(f.root, ".github/copilot/settings.json"), "utf8")).disabledMcpServers,
    ).toContain("sample");
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
    delete f.config.components.excludeFor;
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
  });

  it("filters materialized trees per target and validates retained commands against the filtered tree", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { generated: { type: "stdio", command: "./generated/run" } },
      }),
    );
    f.config.components!.materialize = [
      {
        into: "generated",
        inputs: {},
        provider: {
          id: "exclusion-fixture",
          plan: ({ outputDir }) => ({
            command: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync(require('node:path').join(process.argv[1],'run'),'#!/usr/bin/env node\\n')",
              outputDir,
            ],
          }),
          postprocess: (files) => ({ files: files.map((file) => ({ ...file, mode: 0o755 })), problems: [] }),
        },
      },
    ];
    f.config.components!.excludeFor = { omit: ["mcp.json", "generated/**"] };
    const result = await f.build();
    expect(result.report.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(
      result
        .plan!.find((plan) => plan.target === "keep")!
        .artifacts.some((file) => file.path.endsWith("generated/run")),
    ).toBe(true);
    expect(
      result
        .plan!.find((plan) => plan.target === "omit")!
        .artifacts.some((file) => file.path.endsWith("generated/run")),
    ).toBe(false);
    expect(result.report.targets.omit!.projection!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ path: "generated/run", status: "omitted" }),
    );
    f.config.components!.excludeFor.omit = ["generated/**"];
    const invalid = await f.build();
    expect(invalid.ok).toBe(false);
    expect(invalid.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", target: "omit" }));
  });

  it("reports excluded authored in-place skills without deleting them", async () => {
    const f = await fixture("project", ["codex"]);
    await mkdir(join(f.root, ".agents/skills/review"), { recursive: true });
    const path = join(f.root, ".agents/skills/review/SKILL.md");
    const text = await readFile(join(f.root, "skills/review/SKILL.md"), "utf8");
    await writeFile(path, text);
    f.config.components = { skills: [".agents/skills"], excludeFor: { keep: ["review/**"] } };
    const blocked = await f.build();
    expect(blocked.ok).toBe(false);
    expect(blocked.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN101", target: "keep" }));
    f.config.components.accept = ["codex:skill-exclusion-unenforced"];
    const accepted = await runProject({ ...f.options(), command: "sync" });
    expect(accepted.errors).toEqual([]);
    expect(accepted.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(text);
    expect(accepted.targets!.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ writer: "authored", status: "exposed" }),
    );
  });

  it("removes and restores owned skills rather than misreporting stale copies as authored exposure", async () => {
    const f = await fixture("project", ["codex"]);
    f.config.components = { skills: ["skills"] };
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    f.config.components.excludeFor = { keep: ["review/**"] };
    const omitted = await runProject({ ...f.options(), command: "sync" });
    expect(omitted.errors).toEqual([]);
    expect(omitted.ok).toBe(true);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
    delete f.config.components.excludeFor;
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    expect(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).toContain("Review.");
  });

  it("detects authored native skills when a package exclusion prunes the parent directory", async () => {
    const f = await fixture("project", ["codex"]);
    await mkdir(join(f.root, "source/skills/review"), { recursive: true });
    await writeFile(join(f.root, "source/plugin.json"), await readFile(join(f.root, "plugin.json")));
    const text = await readFile(join(f.root, "skills/review/SKILL.md"), "utf8");
    await writeFile(join(f.root, "source/skills/review/SKILL.md"), text);
    await mkdir(join(f.root, ".agents/skills/review"), { recursive: true });
    const native = join(f.root, ".agents/skills/review/SKILL.md");
    await writeFile(native, text);
    await mkdir(join(f.root, ".agents/skills/unrelated"), { recursive: true });
    await writeFile(join(f.root, ".agents/skills/unrelated/SKILL.md"), text.replace("name: review", "name: unrelated"));
    f.config.components = { root: "source", excludeFor: { keep: ["skills/**"] } };
    const blocked = await runProject({ ...f.options(), command: "sync" });
    expect(blocked.ok).toBe(false);
    expect(blocked.targets!.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ status: "exposed", nativePath: ".agents/skills/review/SKILL.md", writer: "authored" }),
    );
    expect(await readFile(native, "utf8")).toBe(text);
    f.config.components.accept = ["codex:skill-exclusion-unenforced"];
    const accepted = await runProject({ ...f.options(), command: "sync" });
    expect(accepted.errors).toEqual([]);
    expect(accepted.ok).toBe(true);
    expect(accepted.targets!.keep!.project!.components["agent-plugin.skills"]!.emitted).toBe(1);
    expect(accepted.targets!.keep!.project!.authorExclusions!.matches.some((match) => match.name === "unrelated")).toBe(
      false,
    );
    expect(await readFile(native, "utf8")).toBe(text);
  });

  it("detects unowned excluded auxiliary files beside a retained owned skill manifest", async () => {
    const f = await fixture("project", ["codex"]);
    f.config.components = { skills: ["skills"], excludeFor: { keep: ["review/helper.txt"] } };
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    const native = join(f.root, ".agents/skills/review/helper.txt");
    await writeFile(native, "authored helper\n");
    const blocked = await f.build();
    expect(blocked.ok).toBe(false);
    expect(blocked.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN101", target: "keep" }));
    expect(blocked.report.targets.keep!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({
        status: "exposed",
        nativePath: ".agents/skills/review/helper.txt",
        writer: "authored",
      }),
    );
    f.config.components.onDegraded = "warn";
    const warned = await runProject({ ...f.options(), command: "sync" });
    expect(warned.errors).toEqual([]);
    expect(warned.ok).toBe(true);
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
    expect(await readFile(native, "utf8")).toBe("authored helper\n");
    // If the owned manifest is removed too, the remaining unowned helper is no longer a skill.
    delete f.config.components.onDegraded;
    f.config.components.excludeFor = { keep: ["review/**"] };
    const omitted = await runProject({ ...f.options(), command: "sync" });
    expect(omitted.errors).toEqual([]);
    expect(omitted.ok).toBe(true);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(native, "utf8")).toBe("authored helper\n");
  });

  it("does not analyze invocation policy for an excluded skill outside the target's discovery paths", () => {
    const source = {
      origin: "direct" as const,
      skills: [
        {
          name: "review",
          source: join(tmpdir(), "neutral/review"),
          files: [],
          policy: { allowImplicitInvocation: false },
        },
      ],
    };
    const plans = planProjectSkillPolicies(
      source,
      tmpdir(),
      [
        { id: "keep", adapter: "first", destination: ".first/skills", source, support: { level: "exact" } },
        {
          id: "omit",
          adapter: "second",
          destination: ".second/skills",
          source: { origin: "direct", skills: [] },
          exclude: ["review/**"],
          support: { level: "unsupported" },
        },
      ],
      { onUnsupported: "error" },
    );
    expect(plans.get("omit")!.selection.issues).toEqual([]);
    expect(plans.get("omit")!.discovered).toEqual([]);
  });

  it("does not analyze an obsolete owned manifest's policy through an unowned helper", async () => {
    const f = await fixture("project", ["codex"]);
    await writeFile(
      join(f.root, "skills/review/SKILL.md"),
      '---\nname: review\ndescription: Review code\nmetadata:\n  hooknostic/allow-implicit-invocation: "false"\n---\nReview.\n',
    );
    f.config.components = { skills: ["skills"], excludeFor: { keep: ["review/helper.txt"] } };
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    const native = join(f.root, ".agents/skills/review/helper.txt");
    await writeFile(native, "authored helper\n");
    f.config.components.excludeFor = { keep: ["review/**"] };
    const omitted = await runProject({ ...f.options(), command: "sync" });
    expect(omitted.errors).toEqual([]);
    expect(omitted.ok).toBe(true);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(native, "utf8")).toBe("authored helper\n");
    expect((await runProject({ ...f.options(), command: "verify" })).ok).toBe(true);
  });

  it("keeps compiled hooks when component files are excluded", async () => {
    const f = await fixture();
    f.config.entry = "hooks.ts";
    await writeFile(
      join(f.root, "hooks.ts"),
      'import { definePlugin, hook } from "@hooknostic/sdk"; export default definePlugin({ name: "exclusions", hooks: [hook("tool.before", { id: "noop", run() {} })] });',
    );
    f.config.components!.excludeFor = { omit: ["mcp.json", "server/**", "skills/**"] };
    const result = await buildProject({
      ...f.options(),
      dryRun: true,
      evaluate: { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } },
    });
    expect(result.ok).toBe(true);
    expect(
      result
        .plan!.find((plan) => plan.target === "omit")!
        .artifacts.some((file) => file.path === "runtime/hooknostic.mjs"),
    ).toBe(true);
    expect(
      result.plan!.find((plan) => plan.target === "omit")!.artifacts.some((file) => file.path.includes("SKILL.md")),
    ).toBe(false);
  });

  it("combines global filters, case-insensitive globs and whole-skill manifest pruning", async () => {
    const f = await fixture();
    f.config.components!.exclude = ["skills/review/helper.txt"];
    f.config.components!.excludeFor = { omit: ["SKILLS/REVIEW/SKILL.MD"] };
    const result = await f.build();
    expect(result.ok).toBe(true);
    expect(
      result.plan!.find((plan) => plan.target === "keep")!.artifacts.some((file) => file.path.includes("SKILL.md")),
    ).toBe(true);
    expect(
      result.plan!.find((plan) => plan.target === "omit")!.artifacts.some((file) => file.path.includes("skills/")),
    ).toBe(false);
    expect(result.plan!.flatMap((plan) => plan.artifacts).some((file) => file.path.includes("helper.txt"))).toBe(false);
  });

  it("reports alternate shared discovery and keeps failure transactional", async () => {
    const f = await fixture("project", ["claude", "copilot"]);
    f.config.components = { skills: ["skills"], excludeFor: { omit: ["review/**"] } };
    const result = await runProject({ ...f.options(), command: "sync" });
    expect(result.ok).toBe(false);
    expect(result.targets!.omit!.project!.authorExclusions!.matches).toContainEqual(
      expect.objectContaining({ nativePath: ".claude/skills/review/SKILL.md", status: "exposed" }),
    );
    await expect(readFile(join(f.root, ".claude/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fences shared MCP in the reverse direction and preserves unrelated settings", async () => {
    const f = await fixture("project", ["copilot", "claude"]);
    await mkdir(join(f.root, ".claude"));
    await writeFile(
      join(f.root, ".claude/settings.json"),
      JSON.stringify({ disabledMcpjsonServers: ["authored"], theme: "dark" }),
    );
    f.config.components = { mcp: "mcp.json", excludeFor: { omit: ["mcp.json"] } };
    const result = await runProject({ ...f.options(), command: "sync" });
    expect(result.errors).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, ".claude/settings.json"), "utf8"))).toMatchObject({
      disabledMcpjsonServers: ["authored", "sample"],
      theme: "dark",
    });
    delete f.config.components.excludeFor;
    expect((await runProject({ ...f.options(), command: "sync" })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(f.root, ".claude/settings.json"), "utf8")).disabledMcpjsonServers).toEqual([
      "authored",
    ]);
  });

  it("does not let a symlink restore target-excluded content", async () => {
    const f = await fixture();
    await symlink(join(f.root, "server"), join(f.root, "alias"), "junction");
    f.config.components!.excludeFor = { omit: ["mcp.json", "server/**"] };
    const refused = await f.build();
    expect(refused.ok).toBe(false);
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ target: "omit", message: expect.stringContaining("excluded path server") }),
    );
    f.config.components!.excludeFor.omit!.push("alias/**");
    expect((await f.build()).ok).toBe(true);
  });

  it("rejects aliases into descendants of target-pruned directories", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "server/private"));
    await writeFile(join(f.root, "server/private/data.txt"), "excluded content\n");
    await symlink(join(f.root, "server/private"), join(f.root, "alias"), "junction");
    f.config.components!.excludeFor = { omit: ["mcp.json", "server"] };
    const refused = await f.build(["omit"]);
    expect(refused.ok).toBe(false);
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ target: "omit", message: expect.stringContaining("excluded path server/private") }),
    );
    f.config.components!.excludeFor.omit!.push("alias");
    expect((await f.build(["omit"])).ok).toBe(true);
  });

  it("validates executable declarations even when their target subtree is omitted", async () => {
    const f = await fixture();
    f.config.components!.excludeFor = { omit: ["mcp.json", "server/**"] };
    f.config.components!.executableFiles = ["server/missing"];
    const result = await f.build(["omit"]);
    expect(result.ok).toBe(false);
    expect(result.report.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("even when excluded for a target") }),
    );
  });

  it("rejects explicit runtime-package inputs that a target excludes", async () => {
    const f = await fixture();
    f.config.components!.runtimePackage = { manifest: "runtime.json", lockfile: "runtime-lock.json" };
    f.config.components!.excludeFor = { omit: ["runtime.json"] };
    const result = await f.build(["omit"]);
    expect(result.ok).toBe(false);
    expect(result.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN501",
        target: "omit",
        message: "runtimePackage requires excluded input runtime.json",
      }),
    );
  });
});
