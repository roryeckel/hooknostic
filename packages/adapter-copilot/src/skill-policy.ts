import {
  type AgentPluginFile,
  type AgentPluginProjectionProfile,
  setSkillPolicyYaml,
  SKILL_POLICY_IN_PLACE,
  type SkillPolicy,
} from "@hooknostic/agent-plugin";

export const COPILOT_SKILL_POLICY_EVIDENCE = ".capture/copilot/README.md";

/** The interactive capture that sets the exact support boundary. */
export const COPILOT_SKILL_POLICY_VALIDATION = {
  version: "1.0.101",
  date: "2026-10-20",
  method: "live-probe",
  artifact: COPILOT_SKILL_POLICY_EVIDENCE,
  what: "Interactive /gated in .agents/skills and /<plugin-name>:gated in a --plugin-dir package injected the gated body, with skill.invoked trigger user-invoked and disableModelInvocation true. A -p prompt naming the gated skill reached only the model-facing skill tool, which listed the explicit disable-model-invocation: false control and returned Skill not found for the gated skill.",
} satisfies AgentPluginProjectionProfile["source"]["validatedOn"][number];

export const COPILOT_SKILL_POLICY_RATIONALE = `Captured on ${COPILOT_SKILL_POLICY_VALIDATION.version}: disable-model-invocation: true withholds a skill from ordinary listing, while an interactive slash invocation injects the gated body: /gated for a project skill and /<plugin-name>:gated for a package skill. A -p session has no slash path; a prompt naming the skill reaches only the model-facing skill tool, which excludes gated skills and returns Skill not found. The native gate therefore withholds automatic selection and retains interactive explicit invocation; only headless prompt mode cannot invoke it.`;

export const COPILOT_SKILL_POLICY_DEGRADATIONS = [
  {
    id: SKILL_POLICY_IN_PLACE,
    summary: "A skill discovered in place is authored input, so Hooknostic cannot own or verify its invocation policy.",
    evidence: COPILOT_SKILL_POLICY_EVIDENCE,
  },
] as const;

/**
 * Add the captured invocation-policy cell. The adapter range starts at the
 * captured build, so there is no older profile to inherit a claim.
 */
export function copilotSkillPolicyProfiles(
  profile: AgentPluginProjectionProfile,
  options: { inPlace: boolean },
): AgentPluginProjectionProfile[] {
  return [
    {
      ...profile,
      components: {
        ...profile.components,
        "agent-plugin.skills.invocation-policy": {
          level: "exact",
          rationale: COPILOT_SKILL_POLICY_RATIONALE,
          ...(options.inPlace ? { degradations: [...COPILOT_SKILL_POLICY_DEGRADATIONS] } : {}),
        },
      },
    },
  ];
}

/**
 * The native field for an owned skill. The exact profile applies this after
 * native overlays; `planProjectSkillPolicies` leaves an in-place source alone.
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
