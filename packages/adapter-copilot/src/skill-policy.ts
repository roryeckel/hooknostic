import {
  type AgentPluginFile,
  type AgentPluginProjectionProfile,
  setSkillPolicyYaml,
  SKILL_IMPLICIT_INVOCATION_UNENFORCED,
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

/** The unavailable-gate acceptance for a Copilot version range without a capture. */
export const COPILOT_SKILL_POLICY_UNENFORCED_DEGRADATIONS = [
  {
    id: SKILL_IMPLICIT_INVOCATION_UNENFORCED,
    summary:
      "No invocation-policy route has been captured for this Copilot version range; a gated skill is emitted only by explicit acceptance, without a projected gate.",
    evidence: COPILOT_SKILL_POLICY_EVIDENCE,
  },
] as const;

/**
 * Split a profile at the invocation-policy capture version. Only 1.0.101 has
 * the interactive slash capture; older builds stay unsupported rather than
 * inheriting a claim the capture does not cover.
 */
export function copilotSkillPolicyProfiles(
  profile: AgentPluginProjectionProfile,
  options: { inPlace: boolean },
): AgentPluginProjectionProfile[] {
  return [false, true].map((supported) => ({
    ...profile,
    range: `${profile.range} ${supported ? ">=" : "<"}${COPILOT_SKILL_POLICY_VALIDATION.version}`,
    components: {
      ...profile.components,
      "agent-plugin.skills.invocation-policy": supported
        ? {
            level: "exact",
            rationale: COPILOT_SKILL_POLICY_RATIONALE,
            ...(options.inPlace ? { degradations: [...COPILOT_SKILL_POLICY_DEGRADATIONS] } : {}),
          }
        : {
            level: "unsupported",
            rationale: `No invocation-policy route has been captured for Copilot before ${COPILOT_SKILL_POLICY_VALIDATION.version}; the interactive slash capture covers ${COPILOT_SKILL_POLICY_VALIDATION.version} only.`,
            degradations: [
              ...COPILOT_SKILL_POLICY_UNENFORCED_DEGRADATIONS,
              ...(options.inPlace ? COPILOT_SKILL_POLICY_DEGRADATIONS : []),
            ],
          },
    },
  }));
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
