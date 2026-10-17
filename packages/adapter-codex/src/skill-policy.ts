import {
  setSkillPolicyYaml,
  type SkillPolicyFileProjector,
  type SkillPolicyValidation,
} from "@hooknostic/agent-plugin";

export const codexSkillPolicy: SkillPolicyFileProjector = (files, policy) =>
  setSkillPolicyYaml(
    files,
    "agents/openai.yaml",
    ["policy", "allow_implicit_invocation"],
    policy.allowImplicitInvocation!,
  );

export const codexProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "0.148.0",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Isolated project discovery withheld policy.allow_implicit_invocation:false, true restored visibility, and explicit $skill delivered the gated body over loopback. A separate ordinary-discovery probe loaded authored .codex/skills alongside the primary .agents/skills route.",
};
export const codexPackageSkillPolicyValidation: SkillPolicyValidation = {
  version: "0.156.1",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Package invocation policy is probed through an isolated local marketplace, preserving explicit native user invocation while withholding automatic selection.",
};
export const CODEX_SKILL_POLICY_RATIONALE =
  "Native agents/openai.yaml policy.allow_implicit_invocation withholds automatic selection and retains explicit user invocation; unrelated sidecar fields survive.";
