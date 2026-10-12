import { type SkillPolicyFileProjector, type SkillPolicyValidation } from "@hooknostic/agent-plugin";

// The v1 gate is supplied by the generated config callback, not by SKILL.md.
export const opencodeSkillPolicy: SkillPolicyFileProjector = (files) => [...files];
export const opencodeProjectSkillPolicyValidation: SkillPolicyValidation = {
  version: "1.18.18",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "permission.skill deny withheld discovery and rejected forced model loading, while run --command explicitly invoked the same gated skill and delivered its body over loopback; allow restored discovery. Separate ordinary-discovery probes loaded .claude/skills, .opencode/skills and .opencode/skill.",
};
export const opencodePackageSkillPolicyValidation: SkillPolicyValidation = {
  version: opencodeProjectSkillPolicyValidation.version,
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Installed a relocated local npm package whose config callback supplied skills.paths and permission.skill using qualified gate-probe-* names: deny withheld discovery and forced loading, explicit run --command still delivered the gated body, and allow restored discovery over loopback.",
};
export const opencodeNewerSkillPolicyValidation: SkillPolicyValidation = {
  version: "1.18.34",
  date: "2026-10-11",
  method: "live-probe",
  artifact: ".capture/skill-invocation",
  what: "Repeated the installed-package deny probe: ordinary discovery and forced skill calls were withheld while native slash-command invocation still loaded the body; the installed config callback's allow control restored discovery.",
};
export const OPENCODE_SKILL_POLICY_RATIONALE =
  "A generated config callback sets a named permission.skill deny/allow rule. Deny withholds automatic selection and forced skill-tool loading; explicit slash invocation still loads the skill body.";

/** Merge named rules without losing native shorthand or unrelated permissions. */
export function skillPermissionSource(policies: Readonly<Record<string, boolean>>): string {
  if (Object.keys(policies).length === 0) return "";
  return `
  const permission = typeof config.permission === "string" ? { "*": config.permission } : { ...(config.permission ?? {}) };
  const skillRules = typeof permission.skill === "string" ? { "*": permission.skill } : { ...(permission.skill ?? {}) };
  for (const [name, allowed] of Object.entries(${JSON.stringify(policies)})) {
    Object.defineProperty(skillRules, name, { value: allowed ? "allow" : "deny", enumerable: true, configurable: true, writable: true });
  }
  permission.skill = skillRules;
  config.permission = permission;
`;
}
