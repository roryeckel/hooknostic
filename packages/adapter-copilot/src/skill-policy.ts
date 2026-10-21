import {
  type AgentPluginFile,
  setSkillPolicyYaml,
  SKILL_IMPLICIT_INVOCATION_UNENFORCED,
  SKILL_POLICY_IN_PLACE,
  type SkillPolicy,
} from "@hooknostic/agent-plugin";

export const COPILOT_SKILL_POLICY_RATIONALE =
  'Captured on 1.0.101: disable-model-invocation: true withheld a project skill from ordinary listing, but an explicit /skill invocation answered "Skill not found" and the model only reached the body by reading the file. A faithful portable policy must keep explicit invocation available, so no captured route is faithful and a gated skill is omitted unless the author removes the policy.';

export const COPILOT_SKILL_POLICY_EVIDENCE = ".capture/copilot/README.md";

/** The acceptance ids `selectSkillPolicies` checks, with Copilot evidence. */
export const COPILOT_SKILL_POLICY_DEGRADATIONS = [
  {
    id: SKILL_IMPLICIT_INVOCATION_UNENFORCED,
    summary:
      "The declared implicit-invocation policy cannot be applied faithfully: Copilot withholds the skill from automatic selection, but an explicit /skill invocation is not available, so accepting this emits the authored native flag and the skill may be unreachable.",
    evidence: COPILOT_SKILL_POLICY_EVIDENCE,
  },
  {
    id: SKILL_POLICY_IN_PLACE,
    summary: "A skill discovered in place is authored input, so Hooknostic cannot own or verify its invocation policy.",
    evidence: COPILOT_SKILL_POLICY_EVIDENCE,
  },
] as const;

/**
 * The native field a future version would use, if explicit invocation starts
 * working again. The current profile rates the component unsupported, so
 * `selectSkillPolicies` never calls this.
 */
export function copilotSkillPolicy(files: readonly AgentPluginFile[], policy: SkillPolicy): AgentPluginFile[] {
  return setSkillPolicyYaml(
    files,
    "SKILL.md",
    ["disable-model-invocation"],
    policy.allowImplicitInvocation === false,
    true,
  );
}
