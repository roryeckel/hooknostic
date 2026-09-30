import { AGENT_PLUGIN_PLACEHOLDER_NAMES, type SkillTextTarget } from "@hooknostic/agent-plugin";

/**
 * Claude Code expands `${CLAUDE_SKILL_DIR}` in a skill's text to the skill's
 * absolute directory, with forward slashes, in a plugin skill and in a project
 * skill alike (2.1.285, .capture/skill-directory). It is what `${SKILL_DIR}`
 * becomes on this target (ADR-0028).
 */
const CLAUDE_SKILL_DIR = "${CLAUDE_SKILL_DIR}";

/**
 * An installed plugin's skill. Claude also expands `${CLAUDE_PLUGIN_ROOT}`,
 * `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SESSION_ID}` there, and leaves the
 * Agent Plugins placeholders, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, as written.
 */
export const CLAUDE_PLUGIN_SKILL_TEXT: SkillTextTarget = {
  skillDirectory: CLAUDE_SKILL_DIR,
  leavesLiteral: (name) => AGENT_PLUGIN_PLACEHOLDER_NAMES.has(name),
};

/**
 * A project skill under `.claude/skills`. There is no plugin, and Claude leaves
 * `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` as written; it still
 * expands `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}`.
 */
export const CLAUDE_PROJECT_SKILL_TEXT: SkillTextTarget = {
  skillDirectory: CLAUDE_SKILL_DIR,
  leavesLiteral: (name) =>
    AGENT_PLUGIN_PLACEHOLDER_NAMES.has(name) || name === "CLAUDE_PLUGIN_ROOT" || name === "CLAUDE_PLUGIN_DATA",
};
