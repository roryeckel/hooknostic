import {
  setSkillPolicyYaml,
  type SkillPolicyFileProjector,
  type SkillPolicyValidation,
} from "@hooknostic/agent-plugin";

export const opencodeV2SkillPolicy: SkillPolicyFileProjector = (files, policy) =>
  setSkillPolicyYaml(
    files,
    "SKILL.md",
    ["metadata", "opencode/autoinvoke"],
    String(policy.allowImplicitInvocation),
    true,
  );
export const opencodeV2ProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "2.0.17",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "metadata opencode/autoinvoke:false withheld project discovery, true restored it, and @skill with a scripted skill tool call retained explicit body loading over loopback. A forced skill call could still load the hidden body. Separate ordinary-discovery probes loaded .claude/skills, .opencode/skills and .opencode/skill.",
};
export const opencodeV2PackageSkillPolicyValidation: SkillPolicyValidation = {
  version: opencodeV2ProjectSkillPolicyValidation.version,
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Installed a relocated local npm package and registered package-qualified skills through ctx.skill.transform: autoinvoke:false withheld discovery while @plugin/skill plus a scripted skill call retained body loading over loopback; true restored discovery.",
};
export const opencodeV2NewerSkillPolicyValidation: SkillPolicyValidation = {
  version: "2.0.20",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Repeated project metadata and installed-package registered-skill probes: autoinvoke:false hid discovery while forced skill calls and explicit references plus loading retained body access; native allow restored installed-package discovery.",
};
export const OPENCODE_V2_SKILL_POLICY_RATIONALE =
  "Native opencode/autoinvoke metadata (discovered skills) or autoinvoke (registered package skills) withholds automatic selection while explicit skill loading remains available.";
