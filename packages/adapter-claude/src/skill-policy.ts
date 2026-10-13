import {
  setSkillPolicyYaml,
  type SkillPolicyFileProjector,
  type SkillPolicyValidation,
} from "@hooknostic/agent-plugin";

export const claudeSkillPolicy: SkillPolicyFileProjector = (files, policy) =>
  setSkillPolicyYaml(files, "SKILL.md", ["disable-model-invocation"], !policy.allowImplicitInvocation, true);

export const claudeProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "2.1.238",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Isolated project discovery withheld disable-model-invocation:true, false restored visibility, and explicit /skill invocation retained the gated body over loopback.",
};
export const claudePackageSkillPolicyValidation: SkillPolicyValidation = {
  version: claudeProjectSkillPolicyValidation.version,
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Installed a synthetic package through an isolated local marketplace: true withheld ordinary discovery, false restored it, and explicit /plugin:skill delivered the gated body over loopback.",
};
export const claudeNewerSkillPolicyValidation: SkillPolicyValidation = {
  version: "2.1.295",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Repeated project and local-marketplace installed-package discovery, native allow, explicit invocation and forced Skill calls: the gate hid ordinary discovery, kept explicit bodies, and rejected forced loading while the ungated control succeeded.",
};
export const CLAUDE_SKILL_POLICY_RATIONALE =
  "Native disable-model-invocation withholds automatic selection and retains explicit user invocation. Canonical policy is applied after native overlays.";
