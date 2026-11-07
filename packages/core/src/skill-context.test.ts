import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, contentsText } from "@hooknostic/agent-plugin";

import { CODEX_PLUGIN_MODE_RANGE } from "../../adapter-codex/src/generate.js";
import { opencodeHarness } from "../../adapter-opencode/src/harness.js";
import { opencodeV2Harness } from "../../adapter-opencode/src/v2/harness.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";

const registry = defaultAdapterRegistry();
const variants = [
  { id: "claude", adapter: "claude", packageRef: "/sample:setup", projectRef: "/setup", destination: ".claude/skills" },
  { id: "codex", adapter: "codex", packageRef: "$sample:setup", projectRef: "$setup", destination: ".agents/skills" },
  {
    id: "copilot",
    adapter: "copilot",
    packageRef: "/sample:setup",
    projectRef: "/setup",
    destination: ".agents/skills",
  },
  {
    id: "opencode",
    adapter: "opencode",
    packageRef: "/sample-setup",
    projectRef: "/setup",
    destination: ".agents/skills",
  },
  {
    id: "opencode-v2",
    adapter: "opencode",
    packageRef: "@sample/setup",
    projectRef: "@setup",
    destination: ".agents/skills",
  },
  { id: "pi", adapter: "pi", packageRef: "/skill:setup", projectRef: "/skill:setup", destination: ".pi/skills" },
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const manifest = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;
const body = "Harness ${HARNESS}; next ${SKILL_REF:setup}.";

async function fixture(
  variant: (typeof variants)[number],
  delivery: "package" | "project",
  origin: "package" | "direct" = "package",
) {
  const root = await mkdtemp(join(tmpdir(), "hkn-skill-context-"));
  roots.push(root);
  for (const name of ["status", "setup"]) {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), manifest(name, name === "status" ? body : "Prepare."));
  }
  await writeFile(join(root, "skills/status/script.mjs"), body);
  if (origin === "package")
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "sample" }),
    );
  const version =
    variant.id === "opencode-v2"
      ? opencodeV2Harness.recommendedRange
      : variant.id === "opencode"
        ? opencodeHarness.recommendedRange
        : variant.id === "codex" && delivery === "package"
          ? CODEX_PLUGIN_MODE_RANGE
          : registry[variant.adapter]!.harness.recommendedRange;
  const config = {
    ...(delivery === "project" ? { project: { root: "." } } : {}),
    components: { ...(origin === "package" ? { root: "." } : { skills: ["./skills"] }) } as Record<string, unknown>,
    targets: {
      custom: { adapter: variant.adapter, version, delivery, output: "dist/custom" } as Record<string, unknown>,
    },
  };
  const configPath = join(root, "hooknostic.config.ts");
  const save = () => writeFile(configPath, `export default ${JSON.stringify(config)};`);
  await save();
  return { root, config, save, options: { configPath, registry, dryRun: true } };
}

describe.each(variants)("skill context on $id", (variant) => {
  it.each([
    { origin: "package", delivery: "package" },
    { origin: "package", delivery: "project" },
    { origin: "direct", delivery: "project" },
  ] as const)(
    "projects $origin skills for $delivery delivery and accounts for rewritten files",
    async ({ origin, delivery }) => {
      const f = await fixture(variant, delivery, origin);
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      expect(built.report.diagnostics.filter(({ code }) => code === "HN101")).toEqual([]);
      const plan = built.plan![0]!;
      const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
      const status = files.find(({ path }) => path.endsWith("status/SKILL.md"))!;
      expect(contentsText(status.contents)).toContain(
        `Harness ${variant.id}; next ${delivery === "package" ? variant.packageRef : variant.projectRef}.`,
      );
      expect(contentsText(files.find(({ path }) => path.endsWith("status/script.mjs"))!.contents)).toBe(body);
      if (delivery === "package") {
        expect(built.report.targets.custom!.artifacts).toContain(status.path);
        expect(built.report.targets.custom!.artifacts).not.toContain(
          files.find(({ path }) => path.endsWith("status/script.mjs"))!.path,
        );
      }
    },
  );

  it("keeps in-place sources untouched and reports their portable tokens", async () => {
    const f = await fixture(variant, "project", "direct");
    await mkdir(join(f.root, variant.destination, "status"), { recursive: true });
    const path = join(f.root, variant.destination, "status/SKILL.md");
    await writeFile(path, manifest("status", body));
    f.config.components.skills = [`./${variant.destination}`];
    await f.save();
    const built = await buildProject(f.options);
    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN101",
        degradation: `${variant.adapter}:skill-reference-unexpanded`,
        message: expect.stringContaining("discovers this skill where it is"),
      }),
    );
    expect(await readFile(path, "utf8")).toBe(manifest("status", body));
  });
});

describe("skill reference resolution", () => {
  it.each(["package", "project"] as const)(
    "continues projection after an unclosed prefix for %s delivery",
    async (delivery) => {
      const f = await fixture(variants[0]!, delivery);
      const prefix = "Reference syntax starts with `${SKILL_REF:`.\n";
      await writeFile(
        join(f.root, "skills/status/SKILL.md"),
        manifest("status", prefix + 'Run node "${SKILL_DIR}/check.mjs" --harness ${HARNESS}; next ${SKILL_REF:setup}.'),
      );
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      const plan = built.plan![0]!;
      const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
      expect(contentsText(files.find(({ path }) => path.endsWith("status/SKILL.md"))!.contents)).toBe(
        manifest(
          "status",
          prefix +
            'Run node "${CLAUDE_SKILL_DIR}/check.mjs" --harness claude; next ' +
            (delivery === "package" ? "/sample:setup" : "/setup") +
            ".",
        ),
      );
    },
  );

  it.each(["package", "project"] as const)(
    "reports multiline references through HN101 for %s delivery",
    async (delivery) => {
      const f = await fixture(variants[1]!, delivery);
      const malformed = "${SKILL_REF:\n${HARNESS} ${SKILL_REF:setup}}";
      const text = manifest("status", malformed + "\nTarget ${HARNESS}.");
      await writeFile(join(f.root, "skills/status/SKILL.md"), text);
      for (const behavior of ["error", "warn"] as const) {
        f.config.components.onDegraded = behavior;
        await f.save();
        const built = await buildProject(f.options);
        expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(behavior === "warn");
        expect(built.report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "HN101",
            severity: behavior,
            degradation: "codex:skill-reference-unexpanded",
            message: expect.stringContaining(JSON.stringify(malformed)),
          }),
        );
        if (behavior === "warn") {
          const plan = built.plan![0]!;
          const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
          expect(contentsText(files.find(({ path }) => path.endsWith("status/SKILL.md"))!.contents)).toBe(
            manifest("status", malformed + "\nTarget codex."),
          );
        }
      }
    },
  );

  it("applies package overlays before resolving references", async () => {
    const delivery = "package";
    const f = await fixture(variants[0]!, delivery);
    const dir = join(f.root, "com.anthropic.claude-code/skills/status");
    await mkdir(dir, { recursive: true });
    await writeFile(join(f.root, "skills/status/SKILL.md"), manifest("status", "${SKILL_REF:missing}"));
    await writeFile(join(dir, "SKILL.md"), manifest("status", body));
    const siblingOverlay = join(f.root, "com.anthropic.claude-code/skills/setup");
    await mkdir(siblingOverlay, { recursive: true });
    await writeFile(join(siblingOverlay, "SKILL.md"), manifest("renamed", "Prepare."));
    const built = await buildProject(f.options);
    expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
    const plan = built.plan![0]!;
    const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
    expect(contentsText(files.find(({ path }) => path.endsWith("status/SKILL.md"))!.contents)).toContain(
      delivery === "package" ? "/sample:setup" : "/setup",
    );
  });

  it.each(["package", "project"] as const)(
    "reports missing, skipped and external siblings under %s degradation policy",
    async (delivery) => {
      const f = await fixture(variants[1]!, delivery);
      await writeFile(
        join(f.root, "skills/status/SKILL.md"),
        manifest("status", "${HARNESS} ${SKILL_REF:setup} ${SKILL_REF:missing} ${SKILL_REF:other/setup}"),
      );
      // A rejected sibling remains on disk but must not be a valid reference.
      await writeFile(join(f.root, "skills/setup/SKILL.md"), "---\nname: setup\n---\nInvalid: no description.\n");
      f.config.components.onInvalid = "warn";
      for (const behavior of ["error", "warn", "accepted"] as const) {
        f.config.components.onDegraded = behavior === "warn" ? "warn" : "error";
        f.config.components.accept = behavior === "accepted" ? ["codex:skill-reference-unexpanded"] : [];
        await f.save();
        const built = await buildProject(f.options);
        expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(behavior !== "error");
        const diagnostic = built.report.diagnostics.find(({ code }) => code === "HN101")!;
        expect(diagnostic).toMatchObject({
          degradation: "codex:skill-reference-unexpanded",
          severity: behavior === "accepted" ? "info" : behavior,
        });
        for (const token of ["${SKILL_REF:setup}", "${SKILL_REF:missing}", "${SKILL_REF:other/setup}"])
          expect(diagnostic.message).toContain(token);
        expect(diagnostic.message).toContain("target-specific overlays");
        if (behavior !== "error") {
          const plan = built.plan![0]!;
          const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
          expect(contentsText(files.find(({ path }) => path.endsWith("status/SKILL.md"))!.contents)).toContain(
            "codex ${SKILL_REF:setup}",
          );
        }
      }
    },
  );

  it.each(["authored", "prefixed", "collision", "long", "unrewritable"])(
    "uses OpenCode's actual sibling name: %s",
    async (kind) => {
      const f = await fixture(variants[3]!, "package");
      let sibling = "setup";
      if (kind === "authored") f.config.targets.custom.skillNames = "authored";
      if (kind === "prefixed") sibling = "sample-setup";
      if (kind === "long") sibling = "x".repeat(60);
      if (sibling !== "setup") {
        await mkdir(join(f.root, "skills", sibling), { recursive: true });
        await writeFile(join(f.root, "skills", sibling, "SKILL.md"), manifest(sibling, "Prepare."));
      }
      if (kind === "collision") {
        await mkdir(join(f.root, "skills/sample-setup"));
        await writeFile(join(f.root, "skills/sample-setup/SKILL.md"), manifest("sample-setup", "Prepare."));
      }
      if (kind === "unrewritable")
        await writeFile(
          join(f.root, "skills/setup/SKILL.md"),
          "---\nname: >-\n  setup\ndescription: Prepare\n---\nPrepare.\n",
        );
      await writeFile(join(f.root, "skills/status/SKILL.md"), manifest("status", `Next \${SKILL_REF:${sibling}}.`));
      f.config.components.accept = ["opencode:skill-name-unqualified"];
      await f.save();
      const built = await buildProject(f.options);
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(true);
      expect(
        contentsText(built.plan![0]!.artifacts.find(({ path }) => path.endsWith("status/SKILL.md"))!.contents),
      ).toContain(`Next /${sibling}.`);
    },
  );

  it.each(["${HARNESS}", "${SKILL_REF:setup}"])(
    "rejects shared project destinations with differing %s before writing",
    async (token) => {
      const f = await fixture(variants[1]!, "project", "direct");
      await writeFile(join(f.root, "skills/status/SKILL.md"), manifest("status", token));
      Object.assign(f.config.targets, {
        other: {
          adapter: "opencode",
          version: opencodeHarness.recommendedRange,
          delivery: "project",
          output: "dist/other",
        },
      });
      await f.save();
      const synced = await runProject({ ...f.options, dryRun: false, command: "sync" });
      expect(synced.ok).toBe(false);
      expect(synced.errors).toContain("duplicate integration destination: .agents/skills/status/SKILL.md");
      await expect(readFile(join(f.root, ".agents/skills/status/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(f.root, ".hooknostic/integration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
