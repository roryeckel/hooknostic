import {
  setSkillPolicyYaml,
  type SkillPolicyFileProjector,
  type SkillPolicyValidation,
} from "@hooknostic/agent-plugin";

export const piSkillPolicy: SkillPolicyFileProjector = (files, policy) =>
  setSkillPolicyYaml(files, "SKILL.md", ["disable-model-invocation"], !policy.allowImplicitInvocation, true);

/** The 0.84.4 probes, cited by the `>=0.84 <1` profiles. */
export const piLegacyProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "0.84.4",
  date: "2026-10-14",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Pi loopback: disable-model-invocation:true withheld ordinary discovery, false restored it, and /skill:feature-probe retained the gated body. Verified .pi/skills and project/ancestor .agents/skills with isolated home and repository boundary (.capture/pi/FEATURES.md).",
};
export const piLegacyPackageSkillPolicyValidation: SkillPolicyValidation = {
  ...piLegacyProjectSkillPolicyValidation,
  what: "Pi loopback: a package installed through pi install -l --approve retained explicit /skill:feature-probe while disable-model-invocation:true withheld ordinary discovery; false restored discovery (.capture/pi/FEATURES.md).",
};
/** The same probes repeated on the reference build. */
export const piProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "1.3.0",
  date: "2026-10-19",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Pi loopback on 1.3.0: disable-model-invocation:true withheld ordinary discovery, false and an absent gate kept it, and /skill:feature-probe still injected the gated body with its relative-reference instruction. Verified .pi/skills and project/ancestor .agents/skills with isolated home and repository boundary (.capture/pi/FEATURES.md).",
};
export const piPackageSkillPolicyValidation: SkillPolicyValidation = {
  ...piProjectSkillPolicyValidation,
  what: "Pi loopback on 1.3.0: a package installed through pi install -l --approve retained explicit /skill:feature-probe while disable-model-invocation:true withheld ordinary discovery; false restored discovery (.capture/pi/FEATURES.md).",
};
export const PI_SKILL_POLICY_RATIONALE =
  "Native disable-model-invocation withholds automatic selection while retaining explicit /skill:name invocation. Canonical policy is applied after authored native settings.";
