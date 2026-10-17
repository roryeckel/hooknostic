import {
  setSkillPolicyYaml,
  type SkillPolicyFileProjector,
  type SkillPolicyValidation,
} from "@hooknostic/agent-plugin";

export const piSkillPolicy: SkillPolicyFileProjector = (files, policy) =>
  setSkillPolicyYaml(files, "SKILL.md", ["disable-model-invocation"], !policy.allowImplicitInvocation, true);

export const piProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "0.84.4",
  date: "2026-10-14",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Pi loopback: disable-model-invocation:true withheld ordinary discovery, false restored it, and /skill:feature-probe retained the gated body. Verified .pi/skills and project/ancestor .agents/skills with isolated home and repository boundary (.capture/pi/FEATURES.md).",
};
export const piPackageSkillPolicyValidation: SkillPolicyValidation = {
  ...piProjectSkillPolicyValidation,
  what: "Pi loopback: a package installed through pi install -l --approve retained explicit /skill:feature-probe while disable-model-invocation:true withheld ordinary discovery; false restored discovery (.capture/pi/FEATURES.md).",
};
export const PI_SKILL_POLICY_RATIONALE =
  "Native disable-model-invocation withholds automatic selection while retaining explicit /skill:name invocation. Canonical policy is applied after authored native settings.";
