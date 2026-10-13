import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  loadProjectComponents,
  SKILL_INVOCATION_POLICY,
} from "@hooknostic/agent-plugin";

import {
  claudePackageSkillPolicyValidation,
  claudeProjectSkillPolicyValidation,
} from "../../adapter-claude/src/skill-policy.js";
import {
  codexPackageSkillPolicyValidation,
  codexProjectSkillPolicyValidation,
} from "../../adapter-codex/src/skill-policy.js";
import { opencodeHarness } from "../../adapter-opencode/src/harness.js";
import {
  opencodePackageSkillPolicyValidation,
  opencodeProjectSkillPolicyValidation,
} from "../../adapter-opencode/src/skill-policy.js";
import {
  opencodeV2PackageSkillPolicyValidation,
  opencodeV2ProjectSkillPolicyValidation,
} from "../../adapter-opencode/src/v2/skill-policy.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";
import { planProjectSkillPolicies } from "./skill-policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const registry = defaultAdapterRegistry();
const evaluate = { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } };
const body = "\r\nKeep this body. 👋\r\n  exact whitespace\r\n";
const manifest = (declaration = true, native = "") =>
  `---\r\nname: review\r\ndescription: Review code\r\n${declaration ? 'metadata:\r\n  hooknostic/allow-implicit-invocation: "false"\r\n' : ""}${native}---\r\n${body}`;
const versions = {
  project: {
    claude: claudeProjectSkillPolicyValidation.version,
    codex: codexProjectSkillPolicyValidation.version,
    oc1: opencodeProjectSkillPolicyValidation.version,
    oc2: opencodeV2ProjectSkillPolicyValidation.version,
  },
  package: {
    claude: claudePackageSkillPolicyValidation.version,
    codex: codexPackageSkillPolicyValidation.version,
    oc1: opencodePackageSkillPolicyValidation.version,
    oc2: opencodeV2PackageSkillPolicyValidation.version,
  },
};
async function fixture(
  delivery: "project" | "package",
  ids: (keyof typeof versions.project)[],
  options: {
    source?: string;
    version?: string;
    components?: Record<string, unknown>;
    compatibility?: Record<string, unknown>;
    hooks?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "hkn-policy-build-"));
  roots.push(root);
  const source = options.source ?? "skills";
  await mkdir(join(root, source, "review/agents"), { recursive: true });
  await writeFile(join(root, source, "review/SKILL.md"), manifest());
  await writeFile(
    join(root, source, "review/agents/openai.yaml"),
    "interface:\n  display_name: Keep me\npolicy:\n  allow_implicit_invocation: true\n  vendor: keep\n",
  );
  if (delivery === "package")
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "policy-probe" }),
    );
  const config = {
    ...(options.hooks ? { entry: "./hooks.ts" } : {}),
    ...(delivery === "project" ? { project: { root: "." } } : {}),
    components: { ...(delivery === "project" ? { skills: ["./" + source] } : { root: "." }), ...options.components },
    targets: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          adapter: id.startsWith("oc") ? "opencode" : id,
          version: options.version ?? versions[delivery][id],
          delivery,
          output: delivery === "project" ? `.hooknostic/artifacts/${id}` : `dist/${id}`,
        },
      ]),
    ),
    ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
  };
  const configPath = join(root, "hooknostic.config.ts");
  if (options.hooks)
    await writeFile(
      join(root, "hooks.ts"),
      'import { definePlugin, hook } from "@hooknostic/sdk"; export default definePlugin({ name: "shared-reader-probe", hooks: [hook("tool.before", { id: "probe", async run() {} })] });',
    );
  const save = async () => writeFile(configPath, `export default ${JSON.stringify(config)};`);
  await save();
  return { root, config, save, options: { configPath, registry, evaluate } };
}
const fm = (text: string) => parse(text.split("---")[1]!);
const counts = (discovered: number, emitted: number) => ({ discovered, emitted, skipped: discovered - emitted });

type PermissionAction = "allow" | "ask" | "deny";
type NativePermissions = Record<string, PermissionAction | Record<string, PermissionAction>>;
// Constructed model of the probed native fromConfig/evaluate/wildcard cases:
// .capture/skill-invocation documents its provenance and live controls.
function skillPermission(permission: NativePermissions, name: string): PermissionAction {
  const matches = (value: string, pattern: string) => {
    const expression = pattern
      .split("*")
      .map((part) =>
        part
          .split("?")
          .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("."),
      )
      .join(".*")
      .replace(/ \.\*$/, "( .*)?");
    return new RegExp(`^${expression}$`, process.platform === "win32" ? "i" : "").test(value);
  };
  const rules = Object.entries(permission).flatMap(([tool, value]) =>
    typeof value === "string"
      ? [{ tool, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ tool, pattern, action })),
  );
  return rules.reverse().find((rule) => matches("skill", rule.tool) && matches(name, rule.pattern))?.action ?? "ask";
}

describe("skill invocation policy builds", () => {
  it.each(["project", "package"] as const)(
    "makes generated %s skill permissions win over existing wildcard rules",
    async (delivery) => {
      const f = await fixture(delivery, ["oc1"]);
      const skill = delivery === "package" ? "policy-probe-review" : "review";
      for (const allowed of [false, true]) {
        // Policy metadata is string-valued, including its allow control.
        await writeFile(
          join(f.root, "skills/review/SKILL.md"),
          manifest().replace('"false"', JSON.stringify(String(allowed))),
        );
        const built = await buildProject({ ...f.options, dryRun: true });
        expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
        const path =
          delivery === "package" ? "hooknostic-agent-plugin.js" : ".opencode/plugins/hooknostic-components.js";
        const plan = built.plan!.find((target) => target.target === "oc1")!;
        const artifact = [...plan.artifacts, ...(plan.integration?.files ?? [])].find((file) => file.path === path)!;
        const file = join(f.root, `${allowed ? "allow" : "deny"}.mjs`);
        await writeFile(file, artifact.contents);
        const plugin = await (await import(pathToFileURL(file).href)).default();
        const wildcard = allowed ? "deny" : "allow";
        for (const permission of [
          { skill: { [skill]: "ask", "*": wildcard, untouched: "ask" }, edit: "deny" },
          { skill: { [skill]: "ask", untouched: "ask" }, "*": wildcard, edit: "deny" },
          { skill: "ask", "*": wildcard, edit: "deny" },
          { skill: "ask", "skill *": wildcard, edit: "deny" },
          { "*": wildcard, skill: { "*": "ask", untouched: "allow" }, edit: "deny" },
          { skill: { untouched: "allow", "*": "ask" }, "*": { untouched: "deny", "*": wildcard }, edit: "deny" },
          {
            skill: { "*": "ask", untouched: "allow" },
            "sk?l*": { untouched: "deny", "*": wildcard },
            "edit*": "allow",
            edit: "deny",
          },
        ] satisfies NativePermissions[]) {
          const original = structuredClone(permission);
          const config = { permission };
          plugin.config(config);
          expect(skillPermission(config.permission, skill)).toBe(allowed ? "allow" : "deny");
          expect(config.permission.edit).toBe("deny");
          for (const name of ["untouched", "unlisted"])
            expect(skillPermission(config.permission, name)).toBe(skillPermission(original, name));
          expect(permission).toEqual(original);
        }
      }
    },
    60_000,
  );

  it("limits an authored-only excluded reader to the skills it discovers", async () => {
    const f = await fixture("project", ["claude", "codex"], {
      components: {
        targets: ["claude"],
        skills: ["./skills", "./.codex/skills"],
        accept: ["codex:skill-policy-in-place"],
      },
      hooks: true,
    });
    await mkdir(join(f.root, ".codex/skills/native"), { recursive: true });
    await writeFile(join(f.root, ".codex/skills/native/SKILL.md"), manifest().replace("name: review", "name: native"));
    // Exercise an unavailable invocation gate without changing ordinary skill support.
    const codex = registry.codex!;
    const customRegistry = {
      ...registry,
      codex: {
        ...codex,
        projectComponentProfiles: codex.projectComponentProfiles!.map((profile) => ({
          ...profile,
          components: {
            ...profile.components,
            [SKILL_INVOCATION_POLICY]: {
              ...profile.components[SKILL_INVOCATION_POLICY]!,
              level: "unsupported" as const,
            },
          },
        })),
      },
    };
    const built = await buildProject({ ...f.options, registry: customRegistry, dryRun: true });
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    expect(built.report.targets.codex!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 1));
    expect(built.report.targets.codex!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject({
      support: "unsupported",
      ...counts(1, 0),
    });
    expect(built.report.targets.codex!.project!.degradations?.map((degradation) => degradation.name)).toEqual([
      "native",
    ]);
  }, 60_000);

  it("retains ordinary skill support checks for adapters without discovery metadata", async () => {
    const f = await fixture("project", ["claude"], { components: { onUnsupported: "warn" } });
    await writeFile(join(f.root, "skills/review/SKILL.md"), manifest(false));
    const { skillInvocationPolicy: _policy, ...adapter } = registry.claude!;
    const customRegistry = { ...registry, claude: adapter };
    const built = await buildProject({ ...f.options, registry: customRegistry, dryRun: true });
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    expect(built.report.targets.claude!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 1));
    customRegistry.claude = {
      ...adapter,
      projectComponentProfiles: adapter.projectComponentProfiles!.map((profile) => ({
        ...profile,
        components: {
          ...profile.components,
          "agent-plugin.skills": { level: "unsupported", rationale: "Synthetic unsupported component" },
        },
      })),
    };
    const unavailable = await buildProject({ ...f.options, registry: customRegistry, dryRun: true });
    expect(unavailable.ok, JSON.stringify(unavailable.report.diagnostics)).toBe(true);
    expect(unavailable.report.targets.claude!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 0));
    expect(
      unavailable
        .plan!.flatMap((target) => target.integration?.files ?? [])
        .some((file) => file.path.endsWith("SKILL.md")),
    ).toBe(false);
  }, 60_000);

  it.each([".agents/skills", ".codex/skills"])(
    "validates accepted authored text for an excluded reader of %s",
    async (source) => {
      const f = await fixture("project", ["claude", "codex"], {
        source,
        components: { targets: ["claude"], accept: ["codex:skill-policy-in-place"] },
        hooks: true,
      });
      await writeFile(
        join(f.root, source, "review/SKILL.md"),
        manifest().replace(body, "${CLAUDE_SKILL_DIR}/reference.md\n"),
      );
      const built = await buildProject({ ...f.options, dryRun: true });
      expect(built.ok).toBe(false);
      expect(built.report.diagnostics).toContainEqual(
        expect.objectContaining({
          target: "codex",
          code: "HN101",
          severity: "error",
          degradation: "codex:skill-reference-unexpanded",
        }),
      );
    },
    60_000,
  );

  it.each(["error", "warn", "accepted"] as const)(
    "handles alternate-reader %s across every discoverable copy",
    async (behavior) => {
      const f = await fixture("project", ["claude", "codex", "oc1"], {
        components: {
          targets: ["claude", "codex"],
          onUnsupported: behavior === "warn" ? "warn" : "error",
          ...(behavior === "accepted" ? { accept: ["opencode:skill-implicit-invocation-unenforced"] } : {}),
        },
        hooks: true,
      });
      f.config.targets.oc1!.version = opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0");
      await f.save();
      const built = await buildProject({ ...f.options, dryRun: true });
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(behavior !== "error");
      for (const id of ["claude", "codex", "oc1"]) {
        expect(built.report.targets[id]!.project!.components["agent-plugin.skills"]).toMatchObject(
          counts(1, behavior === "accepted" ? 1 : 0),
        );
        if (behavior !== "accepted")
          expect(built.report.targets[id]!.project!.omissions).toContainEqual(
            expect.objectContaining({ name: "review" }),
          );
      }
      if (behavior === "error") return;
      expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(true);
      for (const destination of [".claude/skills", ".agents/skills"]) {
        const path = join(f.root, destination, "review/SKILL.md");
        if (behavior === "warn") await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        else expect(fm(await readFile(path, "utf8")).metadata["opencode/autoinvoke"]).toBeUndefined();
      }
      if (behavior === "accepted") {
        expect(built.report.targets.oc1!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject({
          support: "unsupported",
          ...counts(1, 0),
        });
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "HN101",
            severity: "info",
            degradation: "opencode:skill-implicit-invocation-unenforced",
          }),
        );
        await expect(readFile(join(f.root, ".opencode/plugins/hooknostic-components.js"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
    60_000,
  );

  it("keeps omissions confined to copies the unsupported reader discovers", async () => {
    const f = await fixture("project", ["claude"]);
    const loaded = await loadProjectComponents({ skills: [join(f.root, "skills")] });
    const plans = planProjectSkillPolicies(
      loaded.source,
      f.root,
      [
        { id: "writer-a", adapter: "a", destination: ".a/skills", support: { level: "exact" } },
        { id: "writer-b", adapter: "b", destination: ".b/skills", support: { level: "unsupported" } },
        {
          id: "reader",
          adapter: "r",
          destination: ".b/skills",
          discoveryDirectories: [".a/skills"],
          support: { level: "exact" },
          componentsSelected: false,
        },
      ],
      { onUnsupported: "warn" },
    );
    expect(plans.get("writer-a")!.source.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(plans.get("writer-b")!.source.skills).toEqual([]);
    expect(plans.get("reader")!.source.skills).toEqual([]);
    expect(plans.get("reader")!.observed.map((copy) => copy.destination)).toEqual([".a/skills"]);
    expect(plans.get("writer-a")!.selection.omissions).toEqual([]);
  });

  it("reports a preserved authored source for an excluded reader without emitting another copy", async () => {
    const f = await fixture("project", ["claude", "codex"], {
      source: ".codex/skills",
      components: { targets: ["claude"], onUnsupported: "warn" },
      hooks: true,
    });
    const path = join(f.root, ".codex/skills/review/SKILL.md");
    const original = await readFile(path);
    const failed = await buildProject({ ...f.options, dryRun: true });
    expect(failed.ok).toBe(false);
    expect(failed.report.diagnostics).toContainEqual(
      expect.objectContaining({ target: "codex", severity: "error", message: expect.stringContaining("move it") }),
    );
    Object.assign(f.config.components, { accept: ["codex:skill-policy-in-place"] });
    await f.save();
    const accepted = await buildProject({ ...f.options, dryRun: true });
    expect(accepted.ok, JSON.stringify(accepted.report.diagnostics)).toBe(true);
    expect(accepted.report.targets.codex!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 1));
    expect(accepted.report.targets.codex!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 0));
    expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(true);
    expect(await readFile(path)).toEqual(original);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("validates alternate copies after the writer rewrites skill text", async () => {
    const f = await fixture("project", ["claude", "oc2"], { components: { targets: ["claude"] }, hooks: true });
    await writeFile(
      join(f.root, "skills/review/SKILL.md"),
      manifest().replace(body, "Read ${SKILL_DIR}/reference.md\n"),
    );
    const failed = await buildProject({ ...f.options, dryRun: true });
    expect(failed.ok).toBe(false);
    expect(failed.report.diagnostics).toContainEqual(
      expect.objectContaining({
        target: "oc2",
        code: "HN101",
        severity: "error",
        degradation: "opencode:skill-reference-unexpanded",
      }),
    );
    Object.assign(f.config.components, { accept: ["opencode:skill-reference-unexpanded"] });
    await f.save();
    const accepted = await buildProject({ ...f.options, dryRun: true });
    expect(accepted.ok, JSON.stringify(accepted.report.diagnostics)).toBe(true);
    expect(accepted.report.targets.oc2!.project!.degradations).toContainEqual(
      expect.objectContaining({
        path: ".claude/skills/review/SKILL.md",
        reason: expect.stringContaining("CLAUDE_SKILL_DIR"),
      }),
    );
  }, 60_000);

  it.each(["oc1", "oc2"] as const)(
    "gates Claude copies for the excluded %s alternate discovery reader",
    async (id) => {
      const f = await fixture("project", ["claude", id], {
        components: { targets: ["claude"], mcp: "./mcp.json" },
        hooks: true,
      });
      await writeFile(
        join(f.root, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: { selectedOnly: { type: "stdio", command: "node", args: ["-e", "process.exit(0)"] } },
        }),
      );
      const built = await buildProject({ ...f.options, dryRun: true });
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      expect(built.report.targets[id]!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 1));
      expect(built.report.targets[id]!.project!.components["agent-plugin.mcp.stdio"]).toBeUndefined();
      expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(true);
      const native = fm(await readFile(join(f.root, ".claude/skills/review/SKILL.md"), "utf8"));
      expect(native["disable-model-invocation"]).toBe(true);
      if (id === "oc2") expect(native.metadata["opencode/autoinvoke"]).toBe("false");
      else {
        const module = await import(pathToFileURL(join(f.root, ".opencode/plugins/hooknostic-components.js")).href);
        const config = { permission: { skill: { review: "ask" } }, mcp: { untouched: true } };
        (await module.default()).config(config);
        expect(config.permission.skill.review).toBe("deny");
        expect(config.mcp).toEqual({ untouched: true });
      }
      await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
  );

  it("does not resurrect rejected packaged skills through Claude overlays", async () => {
    const f = await fixture("package", ["claude"], { components: { onInvalid: "warn" } });
    await writeFile(join(f.root, "skills/review/SKILL.md"), manifest(true, "disable-model-invocation: false\r\n"));
    await mkdir(join(f.root, "com.anthropic.claude-code/skills/review"), { recursive: true });
    await writeFile(join(f.root, "com.anthropic.claude-code/skills/review/SKILL.md"), manifest(false));
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    await expect(readFile(join(f.root, "dist/claude/skills/review/SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(built.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", severity: "warn" }));
    expect(built.report.targets.claude!.projection!.components["agent-plugin.client-extension.files"]).toMatchObject(
      counts(1, 0),
    );
  }, 60_000);

  it.each([
    ["codex", ".codex/skills"],
    ["oc1", ".claude/skills"],
    ["oc1", ".opencode/skills"],
    ["oc1", ".opencode/skill"],
    ["oc2", ".claude/skills"],
    ["oc2", ".opencode/skills"],
    ["oc2", ".opencode/skill"],
    ["oc1", ".opencode/skills/team"],
    ["oc2", ".opencode/skills/team"],
  ] as const)(
    "refuses policy copies from %s alternate native source %s",
    async (id, source) => {
      const f = await fixture("project", [id], { source, components: { onUnsupported: "warn" } });
      const original = await readFile(join(f.root, source, "review/SKILL.md"));
      const built = await buildProject(f.options);
      expect(built.ok).toBe(false);
      expect(built.report.diagnostics).toContainEqual(
        expect.objectContaining({ severity: "error", message: expect.stringContaining("move it") }),
      );
      expect(built.report.targets[id]!.project!.omissions).toEqual([]);
      expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(false);
      expect(await readFile(join(f.root, source, "review/SKILL.md"))).toEqual(original);
      Object.assign(f.config.components, {
        accept: [`${id === "codex" ? "codex" : "opencode"}:skill-policy-in-place`],
      });
      await f.save();
      const accepted = await buildProject(f.options);
      expect(accepted.ok, JSON.stringify(accepted.report.diagnostics)).toBe(true);
      expect(accepted.report.targets[id]!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 0));
    },
    60_000,
  );

  it("refuses policy copies from an ancestor primary source", async () => {
    const f = await fixture("project", ["codex"], { source: ".agents/skills" });
    const loaded = await loadProjectComponents({ skills: [join(f.root, ".agents/skills")] });
    const plan = planProjectSkillPolicies(
      loaded.source,
      join(f.root, "project"),
      [{ id: "test", adapter: "test", destination: ".agents/skills", support: { level: "exact" } }],
      { onUnsupported: "warn" },
    ).get("test")!;
    expect(plan.selection.issues).toContainEqual(
      expect.objectContaining({ severity: "error", message: expect.stringContaining("move it") }),
    );
    expect(plan.selection.omissions).toEqual([]);
    expect(plan.selection.applied.size).toBe(0);
  });

  it("reports a policy-omitted Claude overlay as a discovered, skipped extension", async () => {
    const f = await fixture("package", ["claude"], {
      version: claudePackageSkillPolicyValidation.version.replace(/\.\d+$/, ".0"),
      components: { onUnsupported: "warn" },
    });
    await mkdir(join(f.root, "com.anthropic.claude-code/skills/review"), { recursive: true });
    await writeFile(join(f.root, "com.anthropic.claude-code/skills/review/SKILL.md"), manifest(false));
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    expect(built.report.targets.claude!.projection!.components["agent-plugin.client-extension.files"]).toMatchObject(
      counts(1, 0),
    );
    await expect(readFile(join(f.root, "dist/claude/skills/review/SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it.each(["disable-model-invocation: true\r\n", "name: wrong\r\n", "description: ''\r\n"])(
    "keeps malformed reserved policy fatal with another invalid field: %s",
    async (native) => {
      const f = await fixture("package", ["claude"], { components: { onInvalid: "warn" } });
      const text =
        native.startsWith("name:") || native.startsWith("description:")
          ? manifest().replace(native.startsWith("name:") ? "name: review\r\n" : "description: Review code\r\n", native)
          : manifest(true, native);
      await writeFile(join(f.root, "skills/review/SKILL.md"), text.replace('"false"', "false"));
      const built = await buildProject(f.options);
      expect(built.ok).toBe(false);
      expect(built.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", severity: "error" }));
    },
    60_000,
  );

  it.each(["oc1", "oc2"] as const)(
    "enforces policy for the excluded %s shared reader without delivering its MCP",
    async (id) => {
      const f = await fixture("project", ["codex", id], {
        components: { targets: ["codex"], mcp: "./mcp.json" },
        hooks: true,
      });
      await writeFile(
        join(f.root, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: { selectedOnly: { type: "stdio", command: "node", args: ["-e", "process.exit(0)"] } },
        }),
      );
      const built = await buildProject({ ...f.options, dryRun: true });
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      expect(built.report.targets[id]!.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 1));
      expect(built.report.targets[id]!.project!.components["agent-plugin.mcp.stdio"]).toBeUndefined();
      const synced = await runProject({ ...f.options, command: "sync" });
      expect(synced.ok, JSON.stringify(synced)).toBe(true);
      if (id === "oc2")
        expect(
          fm(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).metadata["opencode/autoinvoke"],
        ).toBe("false");
      else {
        const module = await import(pathToFileURL(join(f.root, ".opencode/plugins/hooknostic-components.js")).href);
        const config = { mcp: { unrelated: { keep: true } }, permission: { skill: { review: "ask" } } };
        (await module.default()).config(config);
        expect(config.permission.skill.review).toBe("deny");
        expect(config.mcp).toEqual({ unrelated: { keep: true } });
      }
      await writeFile(join(f.root, "skills/review/SKILL.md"), manifest(false));
      const restored = await runProject({ ...f.options, command: "sync" });
      expect(restored.ok, JSON.stringify(restored)).toBe(true);
      if (id === "oc1")
        await expect(readFile(join(f.root, ".opencode/plugins/hooknostic-components.js"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(fm(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).metadata).toBeUndefined();
    },
    60_000,
  );

  it("omits shared skills and reports excluded readers whose gate is unavailable", async () => {
    const f = await fixture("project", ["codex", "oc1"], {
      components: { targets: ["codex"], onUnsupported: "warn" },
      hooks: true,
    });
    f.config.targets.oc1!.version = opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0");
    await f.save();
    const built = await buildProject({ ...f.options, dryRun: true });
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    for (const id of ["codex", "oc1"]) {
      expect(built.report.targets[id]!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 0));
      expect(built.report.targets[id]!.project!.omissions).toContainEqual(expect.objectContaining({ name: "review" }));
    }
    const synced = await runProject({ ...f.options, command: "sync" });
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("preserves ordinary skills across the existing broad version ranges", async () => {
    const f = await fixture("project", ["claude", "codex", "oc1"]);
    for (const id of ["claude", "codex"] as const)
      f.config.targets[id]!.version = registry[id]!.harness.recommendedRange;
    f.config.targets.oc1!.version = opencodeHarness.recommendedRange;
    await f.save();
    await writeFile(join(f.root, "skills/review/SKILL.md"), manifest(false));
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    for (const target of Object.values(built.report.targets)) {
      expect(target.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 1));
      expect(target.project!.components[SKILL_INVOCATION_POLICY]).toBeUndefined();
    }
  }, 60_000);
  it("composes shared native files and restores authored settings when the declaration is removed", async () => {
    const f = await fixture("project", ["claude", "codex", "oc2"]);
    const source = join(f.root, "skills/review/SKILL.md");
    const authored = manifest(true, "disable-model-invocation: false\r\nuser-invocable: false\r\n");
    await writeFile(source, authored);
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    for (const target of Object.values(built.report.targets))
      expect(target.project!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 1));
    const synced = await runProject({ ...f.options, command: "sync" });
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    const claude = await readFile(join(f.root, ".claude/skills/review/SKILL.md"), "utf8");
    const shared = await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8");
    expect(fm(claude)).toMatchObject({ "disable-model-invocation": true, "user-invocable": false });
    expect(fm(shared)).toMatchObject({
      metadata: { "opencode/autoinvoke": "false" },
      "disable-model-invocation": false,
    });
    expect(claude.endsWith(body)).toBe(true);
    expect(shared.endsWith(body)).toBe(true);
    const sidecar = join(f.root, ".agents/skills/review/agents/openai.yaml");
    expect(parse(await readFile(sidecar, "utf8"))).toEqual({
      interface: { display_name: "Keep me" },
      policy: { allow_implicit_invocation: false, vendor: "keep" },
    });
    expect(await readFile(source, "utf8")).toBe(authored);
    await writeFile(sidecar, "policy:\n  allow_implicit_invocation: true\n");
    expect((await runProject({ ...f.options, command: "verify" })).ok).toBe(false);
    expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(false);
    // Restore the owned bytes before changing the declaration; drift is never overwritten.
    await writeFile(
      sidecar,
      "interface:\n  display_name: Keep me\npolicy:\n  allow_implicit_invocation: false\n  vendor: keep\n",
    );
    await writeFile(source, manifest(false, "disable-model-invocation: false\r\nuser-invocable: false\r\n"));
    const restored = await runProject({ ...f.options, command: "sync" });
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    expect(fm(await readFile(join(f.root, ".claude/skills/review/SKILL.md"), "utf8"))["disable-model-invocation"]).toBe(
      false,
    );
    expect(fm(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).metadata).toBeUndefined();
    expect(parse(await readFile(sidecar, "utf8")).policy.allow_implicit_invocation).toBe(true);
  }, 60_000);

  it.each(["claude", "codex", "oc1", "oc2"] as const)(
    "projects packaged %s policy after native overlays",
    async (id) => {
      const f = await fixture("package", [id]);
      if (id === "claude") {
        await mkdir(join(f.root, "com.anthropic.claude-code/skills/review"), { recursive: true });
        await writeFile(
          join(f.root, "com.anthropic.claude-code/skills/review/SKILL.md"),
          manifest(false, "disable-model-invocation: false\r\nuser-invocable: false\r\n"),
        );
      }
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      expect(built.report.targets[id]!.projection!.components[SKILL_INVOCATION_POLICY]).toMatchObject(counts(1, 1));
      const prefix = id.startsWith("oc") ? "package/" : "";
      const text = await readFile(join(f.root, `dist/${id}/${prefix}skills/review/SKILL.md`), "utf8");
      expect(text.endsWith(body)).toBe(true);
      if (id === "claude")
        expect(fm(text)).toMatchObject({ "disable-model-invocation": true, "user-invocable": false });
      if (id === "codex")
        expect(
          parse(await readFile(join(f.root, `dist/${id}/skills/review/agents/openai.yaml`), "utf8")),
        ).toMatchObject({
          interface: { display_name: "Keep me" },
          policy: { allow_implicit_invocation: false, vendor: "keep" },
        });
      if (id === "oc1") {
        const file = join(f.root, "dist/oc1/hooknostic-agent-plugin.js");
        const plugin = (await import(pathToFileURL(file).href)).default;
        const config = { permission: { skill: "ask", edit: "deny" } };
        (await plugin()).config(config);
        expect(config.permission).toEqual({ skill: { "*": "ask", "policy-probe-review": "deny" }, edit: "deny" });
      }
      if (id === "oc2") {
        expect(fm(text).metadata["opencode/autoinvoke"]).toBe("false");
        const registered: unknown[] = [];
        const plugin = (await import(pathToFileURL(join(f.root, "dist/oc2/hooknostic-agent-plugin.js")).href)).default;
        await plugin.setup({
          skill: {
            transform: (callback: (editor: { add: (value: unknown) => void }) => void) =>
              callback({ add: (value) => registered.push(value) }),
          },
        });
        expect(registered).toContainEqual(expect.objectContaining({ id: "policy-probe/review", autoinvoke: false }));
      }
    },
    60_000,
  );

  it.each(["error", "warn", "accepted"])(
    "separates unsupported failure, omission and %s emission",
    async (behavior) => {
      const unsupportedVersion = opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0");
      const f = await fixture("project", ["oc1"], {
        version: unsupportedVersion,
        components: {
          onUnsupported: behavior === "warn" ? "warn" : "error",
          onDegraded: "warn",
          ...(behavior === "accepted" ? { accept: ["opencode:skill-implicit-invocation-unenforced"] } : {}),
        },
        compatibility: { minimum: "exact", onBelowMinimum: "error" },
      });
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(behavior !== "error");
      const report = built.report.targets.oc1!.project!;
      expect(report.components[SKILL_INVOCATION_POLICY]).toMatchObject({ support: "unsupported", ...counts(1, 0) });
      expect(report.components["agent-plugin.skills"]).toMatchObject(counts(1, behavior === "accepted" ? 1 : 0));
      if (behavior === "accepted") {
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "HN101",
            severity: "info",
            degradation: "opencode:skill-implicit-invocation-unenforced",
          }),
        );
        expect(report.degradations).toContainEqual(
          expect.objectContaining({ id: "opencode:skill-implicit-invocation-unenforced", name: "review" }),
        );
        expect(report.omissions).toEqual([]);
      } else
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({ code: "HN205", severity: behavior, component: SKILL_INVOCATION_POLICY }),
        );
    },
    60_000,
  );

  it.each(["warn", "accepted"])(
    "reports packaged %s policy separately from skill delivery",
    async (behavior) => {
      const f = await fixture("package", ["codex"], {
        version: codexPackageSkillPolicyValidation.version.replace(/\.\d+$/, ".0"),
        components: {
          onUnsupported: behavior === "warn" ? "warn" : "error",
          ...(behavior === "accepted" ? { accept: ["codex:skill-implicit-invocation-unenforced"] } : {}),
        },
        compatibility: { minimum: "exact", onBelowMinimum: "error" },
      });
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      const report = built.report.targets.codex!.projection!;
      expect(report.components[SKILL_INVOCATION_POLICY]).toMatchObject({ support: "unsupported", ...counts(1, 0) });
      expect(report.components["agent-plugin.skills"]).toMatchObject(counts(1, behavior === "accepted" ? 1 : 0));
      const path = join(f.root, "dist/codex/skills/review/SKILL.md");
      if (behavior === "warn") {
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({ code: "HN205", severity: "warn", component: SKILL_INVOCATION_POLICY }),
        );
      } else {
        expect(await readFile(path, "utf8")).toBe(manifest());
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "HN101",
            severity: "info",
            degradation: "codex:skill-implicit-invocation-unenforced",
          }),
        );
        expect(report.omissions).toEqual([]);
      }
    },
    60_000,
  );

  it("keeps invalid input and unrelated shortfalls fatal under policy acceptance", async () => {
    const f = await fixture("project", ["oc1"], {
      version: opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0"),
      components: {
        onInvalid: "warn",
        onUnsupported: "warn",
        accept: ["opencode:skill-implicit-invocation-unenforced"],
      },
    });
    await writeFile(join(f.root, "skills/review/SKILL.md"), manifest().replace('"false"', '"invalid"'));
    const invalid = await buildProject(f.options);
    expect(invalid.ok).toBe(false);
    expect(invalid.report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", severity: "error" }));
    await writeFile(join(f.root, "skills/review/SKILL.md"), manifest().replace(body, "${PLUGIN_DATA}\n"));
    const unrelated = await buildProject(f.options);
    expect(unrelated.ok).toBe(false);
    expect(unrelated.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN101", severity: "error", degradation: "opencode:skill-reference-unexpanded" }),
    );
  }, 60_000);

  it("projects true over an authored native gate without changing its source", async () => {
    const f = await fixture("project", ["claude", "codex", "oc2"]);
    const source = join(f.root, "skills/review/SKILL.md");
    const authored = manifest(true, "disable-model-invocation: true\r\n").replace('"false"', '"true"');
    await writeFile(source, authored);
    const synced = await runProject({ ...f.options, command: "sync" });
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    expect(fm(await readFile(join(f.root, ".claude/skills/review/SKILL.md"), "utf8"))["disable-model-invocation"]).toBe(
      false,
    );
    expect(
      fm(await readFile(join(f.root, ".agents/skills/review/SKILL.md"), "utf8")).metadata["opencode/autoinvoke"],
    ).toBe("true");
    expect(
      parse(await readFile(join(f.root, ".agents/skills/review/agents/openai.yaml"), "utf8")).policy
        .allow_implicit_invocation,
    ).toBe(true);
    expect(await readFile(source, "utf8")).toBe(authored);
  }, 60_000);

  it("propagates an unaccepted omission to every configured reader of the shared directory", async () => {
    const f = await fixture("project", ["codex", "oc1"], { components: { onUnsupported: "warn" } });
    f.config.targets.oc1!.version = opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0");
    await f.save();
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    for (const id of ["codex", "oc1"]) {
      expect(built.report.targets[id]!.project!.components["agent-plugin.skills"]).toMatchObject(counts(1, 0));
      expect(built.report.targets[id]!.project!.omissions).toContainEqual(
        expect.objectContaining({ name: "review", component: SKILL_INVOCATION_POLICY }),
      );
    }
    expect((await runProject({ ...f.options, command: "sync" })).ok).toBe(true);
    await expect(readFile(join(f.root, ".agents/skills/review/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("leaves an in-place source untouched and requires its own named acceptance", async () => {
    const f = await fixture("project", ["codex"], { source: ".agents/skills", components: { onUnsupported: "warn" } });
    const path = join(f.root, ".agents/skills/review/SKILL.md");
    const original = await readFile(path);
    const failed = await runProject({ ...f.options, command: "sync" });
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "error", message: expect.stringContaining("move it") }),
    );
    expect(await readFile(path)).toEqual(original);
    Object.assign(f.config.components, { accept: ["codex:skill-policy-in-place"] });
    await f.save();
    const accepted = await runProject({ ...f.options, command: "sync" });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(accepted.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN101", severity: "info", degradation: "codex:skill-policy-in-place" }),
    );
    expect(await readFile(path)).toEqual(original);
  }, 60_000);

  it("refuses to claim omission or accepted replacement over an unowned native copy", async () => {
    const f = await fixture("project", ["oc1"], {
      version: opencodeProjectSkillPolicyValidation.version.replace(/\.\d+$/, ".0"),
      components: { onUnsupported: "warn" },
    });
    const path = join(f.root, ".agents/skills/review/SKILL.md");
    await mkdir(join(f.root, ".agents/skills/review"), { recursive: true });
    await writeFile(path, "Unowned native skill\n");
    const omitted = await runProject({ ...f.options, command: "sync" });
    expect(omitted.ok).toBe(false);
    expect(omitted.errors.join(" ")).toContain("cannot omit an unowned native skill");
    Object.assign(f.config.components, { accept: ["opencode:skill-implicit-invocation-unenforced"] });
    await f.save();
    const accepted = await runProject({ ...f.options, command: "sync" });
    expect(accepted.ok).toBe(false);
    expect(accepted.errors.join(" ")).toContain("unowned or modified generated file");
    expect(await readFile(path, "utf8")).toBe("Unowned native skill\n");
  }, 60_000);
});
