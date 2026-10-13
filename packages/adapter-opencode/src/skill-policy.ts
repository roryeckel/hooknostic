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
export const opencodePermissionOrderValidation: SkillPolicyValidation = {
  version: opencodeProjectSkillPolicyValidation.version,
  date: "2026-10-12",
  method: "live-probe",
  artifact: ".capture/skill-invocation/evidence/opencode-v1-permission-order.json",
  what: "The generated callback's deny and allow rules win over pre-existing trailing skill and top-level permission wildcards; ordinary discovery was checked over credential-free loopback.",
};
export const opencodePermissionPreservationValidation: SkillPolicyValidation = {
  version: opencodeProjectSkillPolicyValidation.version,
  date: "2026-10-12",
  method: "live-probe",
  artifact: ".capture/skill-invocation/evidence/opencode-v1-permission-preservation.json",
  what: "Twelve project loopback controls preserve unrelated skill discovery while applying named allow/deny overrides across trailing scalar, map and patterned tool rules, including optional trailing wildcards; the shared callback is exercised, not installed-package loading.",
};
export const OPENCODE_SKILL_POLICY_RATIONALE =
  "A generated config callback sets a named permission.skill deny/allow rule. Deny withholds automatic selection and forced skill-tool loading; explicit slash invocation still loads the skill body.";

/** Merge named rules without losing native shorthand or unrelated permissions. */
export function skillPermissionSource(policies: Readonly<Record<string, boolean>>): string {
  if (Object.keys(policies).length === 0) return "";
  // Replay all rules matching the skill tool before moving its block last.
  // Otherwise a trailing tool wildcard stops overriding unrelated skill rules.
  // Native ordering/wildcards: .capture/skill-invocation permission-preservation.
  return String.raw`
  const permission = typeof config.permission === "string" ? { "*": config.permission } : { ...(config.permission ?? {}) };
  const skillRules = {};
  const setSkillRule = (pattern, action) => {
    delete skillRules[pattern];
    Object.defineProperty(skillRules, pattern, { value: action, enumerable: true, configurable: true, writable: true });
  };
  for (const [tool, value] of Object.entries(permission)) {
    let pattern = tool.replaceAll("\\", "/").replace(/[.+^$()|[\]{}\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
    if (pattern.endsWith(" .*")) pattern = pattern.slice(0, -3) + "( .*)?";
    if (!new RegExp("^" + pattern + "$", process.platform === "win32" ? "si" : "s").test("skill")) continue;
    for (const [name, action] of Object.entries(typeof value === "string" ? { "*": value } : value)) {
      setSkillRule(name, action);
    }
  }
  for (const [name, allowed] of Object.entries(${JSON.stringify(policies)})) {
    setSkillRule(name, allowed ? "allow" : "deny");
  }
  delete permission.skill;
  permission.skill = skillRules;
  config.permission = permission;
`;
}
