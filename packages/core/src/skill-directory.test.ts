import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, contentsText } from "@hooknostic/agent-plugin";

import { CODEX_PLUGIN_MODE_RANGE } from "../../adapter-codex/src/generate.js";
import { codexHarness } from "../../adapter-codex/src/harness.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each([
  { origin: "package", delivery: "package" },
  { origin: "package", delivery: "project" },
  { origin: "direct", delivery: "project" },
] as const)("Codex skill directory ($origin source, $delivery delivery)", ({ origin, delivery }) => {
  it("fails by default and reports the same shortfall when warned or accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hkn-skill-directory-"));
    roots.push(root);
    await mkdir(join(root, "skills/where"), { recursive: true });
    await writeFile(
      join(root, "skills/where/SKILL.md"),
      '---\nname: where\ndescription: Locate the launcher\n---\nRun bash "${SKILL_DIR}/scripts/where.sh".\n',
    );
    if (origin === "package")
      await writeFile(
        join(root, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "directory-probe" }),
      );
    const components: Record<string, unknown> = origin === "package" ? { root: "." } : { skills: ["./skills"] };
    const config = {
      ...(delivery === "project" ? { project: { root: "." } } : {}),
      components,
      targets: {
        codex: {
          adapter: "codex",
          version: delivery === "package" ? CODEX_PLUGIN_MODE_RANGE : codexHarness.recommendedRange,
          delivery,
          output: "dist/codex",
        },
      },
    };
    const configPath = join(root, "hooknostic.config.ts");
    for (const behavior of ["error", "warn", "accepted"] as const) {
      Object.assign(components, {
        onDegraded: behavior === "error" ? undefined : behavior === "warn" ? "warn" : "error",
        accept: behavior === "accepted" ? ["codex:skill-directory-model-substitution"] : [],
      });
      await writeFile(configPath, `export default ${JSON.stringify(config)};`);
      const built = await buildProject({ configPath, registry: defaultAdapterRegistry(), dryRun: true });
      expect(built.ok, JSON.stringify(built.report.diagnostics)).toBe(behavior !== "error");
      expect(built.report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HN101",
          target: "codex",
          severity: behavior === "accepted" ? "info" : behavior,
          degradation: "codex:skill-directory-model-substitution",
          component: "agent-plugin.skills",
          message: expect.stringContaining("model must substitute"),
        }),
      );
      const report = built.report.targets.codex!;
      expect((delivery === "package" ? report.projection : report.project)?.degradations).toEqual([
        expect.objectContaining({ id: "codex:skill-directory-model-substitution", name: "where" }),
      ]);
      if (behavior !== "error") {
        const plan = built.plan![0]!;
        const files = delivery === "package" ? plan.artifacts : plan.integration!.files;
        const skill = files.find((file) => file.path.endsWith("where/SKILL.md"))!;
        expect(contentsText(skill.contents)).toContain(
          'bash "<absolute path of the directory containing this SKILL.md>/scripts/where.sh"',
        );
      }
    }
  });
});
