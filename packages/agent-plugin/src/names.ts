const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `name` satisfies the Agent Skills name rules, including the 64-character limit. */
export function isAgentSkillName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME.test(name);
}
