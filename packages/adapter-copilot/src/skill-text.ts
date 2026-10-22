import { RELATIVE_SKILL_TEXT, type SkillTextTarget } from "@hooknostic/agent-plugin";

/**
 * `${SKILL_DIR}` in a Copilot skill body is shown to the model as written: a
 * project skill's loaded context carries a `Base directory for this skill:`
 * line, but the body keeps `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`
 * and `$CLAUDE_SESSION_ID` unchanged (captured on 1.0.101, .capture/copilot).
 * The projection writes an explicit placeholder for the model to substitute,
 * as Codex does, and reports the shortfall (ADR-0028).
 */
export const copilotSkillDirectoryDegradation = {
  id: "skill-directory-model-substitution",
  summary:
    "A ${SKILL_DIR} in a SKILL.md body becomes `<absolute path of the directory containing this SKILL.md>`. The model must substitute the skill directory from the Base directory line Copilot supplies; Copilot performs no expansion in the body.",
  evidence: ".capture/copilot/README.md",
} as const;

export const COPILOT_SKILL_TEXT: SkillTextTarget = {
  ...RELATIVE_SKILL_TEXT,
  skillDirectory: "<absolute path of the directory containing this SKILL.md>",
  directoryDegradation: {
    id: copilotSkillDirectoryDegradation.id,
    reason:
      "${SKILL_DIR} in this skill's body becomes `<absolute path of the directory containing this SKILL.md>`. The model must substitute the skill directory from the Base directory line Copilot supplies; Copilot performs no runtime expansion. Accept copilot:skill-directory-model-substitution after reviewing the skill (ADR-0028).",
  },
};
