import {
  type AgentPluginDegradationDeclaration,
  RELATIVE_SKILL_TEXT,
  type SkillTextTarget,
} from "@hooknostic/agent-plugin";

export const codexSkillDirectoryDegradation: AgentPluginDegradationDeclaration = {
  id: "skill-directory-model-substitution",
  summary:
    "A ${SKILL_DIR} in a SKILL.md body becomes `<absolute path of the directory containing this SKILL.md>`. The model must substitute the installed skill directory before execution; Codex does not expand this text. The explicit placeholder improved the measured command bodies, but substitution remains model-dependent (ADR-0028, issue #113).",
  evidence: ".capture/skill-directory",
};

export const CODEX_SKILL_TEXT: SkillTextTarget = {
  ...RELATIVE_SKILL_TEXT,
  skillDirectory: "<absolute path of the directory containing this SKILL.md>",
  directoryDegradation: {
    id: codexSkillDirectoryDegradation.id,
    reason:
      "${SKILL_DIR} in this skill's body becomes `<absolute path of the directory containing this SKILL.md>`. The model must substitute the installed skill directory from the SKILL.md path Codex supplies; Codex performs no runtime expansion. The explicit placeholder improved the measured command bodies, but does not guarantee correct substitution. Accept codex:skill-directory-model-substitution after reviewing the skill (ADR-0028, issue #113).",
  },
};

export const codexSkillDirectoryValidation = {
  version: "0.163.0",
  date: "2026-10-19",
  method: "live-probe" as const,
  artifact: ".capture/skill-directory",
  what: "Owner-reported live probe in issue #113, not independently rerun: on Windows 11 with gpt-6-luna and package delivery from an isolated local marketplace, simple projected ./scripts/where.sh commands used the skill directory, but command bodies with a longer argument-quoting instruction succeeded in only 1/3 runs with extra frontmatter and 0/3 without. Failing commands ran from the session directory; additional command skills also ran from the plugin root. The model instructions still prescribed skill-relative paths. Project delivery is conservatively treated as having the same model-dependent limitation, not separately probed.",
};

export const codexSkillDirectoryComparisonValidation = {
  version: codexSkillDirectoryValidation.version,
  date: "2026-10-19",
  method: "live-probe" as const,
  artifact: ".capture/skill-directory",
  what: "Controlled package-delivery comparison on native Windows with gpt-6-luna, Git Bash and owner-authorized unsandboxed execution after sandboxed controls stalled: five sessions per projection for the exact failing body F and a declared reconstruction of E. The explicit `<absolute path of the directory containing this SKILL.md>` placeholder succeeded on 10/10 first launcher attempts; the former dot projection on 1/10, with one additional recovery after failure. All 20 sessions completed. Commands and script markers are recorded in comparison.md and its redacted evidence JSON. These counts support adopting the explicit placeholder with a model-substitution degradation, not an exact guarantee. Project delivery was not separately probed.",
};
