import { describe, expect, it } from "vitest";

import { SKILL_INVOCATION_POLICY } from "@hooknostic/agent-plugin";

import { claudeProjectSkillPolicyValidation } from "../../adapter-claude/src/skill-policy.js";
import { codexPackageSkillPolicyValidation } from "../../adapter-codex/src/skill-policy.js";
import { opencodeProjectSkillPolicyValidation } from "../../adapter-opencode/src/skill-policy.js";
import { opencodeV2ProjectSkillPolicyValidation } from "../../adapter-opencode/src/v2/skill-policy.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

describe("inspect skill invocation policy", () => {
  it.each([
    ["claude", claudeProjectSkillPolicyValidation.version, "project", "exact"],
    ["codex", codexPackageSkillPolicyValidation.version, "package", "exact"],
    ["opencode", opencodeProjectSkillPolicyValidation.version, "project", "emulated"],
    ["opencode", opencodeV2ProjectSkillPolicyValidation.version, "project", "exact"],
  ] as const)("exposes %s %s %s support and named shortfalls", async (target, version, delivery, level) => {
    const output: string[] = [];
    const code = await runInspect({
      target,
      version,
      delivery,
      component: SKILL_INVOCATION_POLICY,
      json: true,
      registry: defaultAdapterRegistry(),
      io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
    });
    expect(code, output.join("\n")).toBe(0);
    const report = JSON.parse(output.join("\n"));
    expect(report.components).toEqual([
      expect.objectContaining({
        component: SKILL_INVOCATION_POLICY,
        level,
        degradations: expect.arrayContaining([
          expect.objectContaining({ id: `${target}:skill-implicit-invocation-unenforced` }),
          expect.objectContaining({ id: `${target}:skill-policy-in-place` }),
        ]),
      }),
    ]);
    expect(
      report.projectionProfiles.some((profile: { source: { validatedOn: { artifact: string }[] } }) =>
        profile.source.validatedOn.some((record) => record.artifact === ".capture/skill-invocation"),
      ),
    ).toBe(true);
  });
});
