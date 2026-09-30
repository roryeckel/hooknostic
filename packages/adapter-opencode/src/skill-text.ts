import { type AgentPluginDegradationDeclaration, SKILL_REFERENCE_UNEXPANDED } from "@hooknostic/agent-plugin";

/**
 * Both OpenCode families hand the model a skill's text as written and follow
 * it with "Base directory for this skill: <absolute path>" and "Relative paths
 * in this skill (e.g., scripts/, reference/) are relative to this base
 * directory" (1.18.33 and 2.0.18, .capture/skill-directory). So `${SKILL_DIR}`
 * becomes `.` here, and every reference another harness would expand is shown
 * as written (ADR-0028).
 */
export const OPENCODE_SKILL_TEXT_RATIONALE =
  "${SKILL_DIR} in a SKILL.md body becomes `.`: OpenCode expands nothing in skill text, and its skill tool gives the model the skill's base directory and tells it that relative paths in the skill are relative to it (ADR-0028).";

export const OPENCODE_SKILL_REFERENCE_DEGRADATION: AgentPluginDegradationDeclaration = {
  id: SKILL_REFERENCE_UNEXPANDED,
  summary:
    "A SKILL.md that holds a Claude Code variable such as ${CLAUDE_PLUGIN_ROOT}, ${PLUGIN_ROOT} or ${PLUGIN_DATA} anywhere, ${SKILL_DIR} in its frontmatter, or ${SKILL_DIR} at all in a project skill discovered in place, reaches the model with that text as written: OpenCode expands nothing in skill text.",
  evidence: ".capture/skill-directory",
};
