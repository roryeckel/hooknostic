# OpenCode skill namespace probe

Evidence class: **live-probe**. Tested `opencode` **1.18.31** on **2026-09-23**,
on native Windows. Observations are `opencode debug skill` (the skills a session
would offer) and one `opencode run` model call.

## Question

Claude Code and Codex qualify a plugin's skills by the plugin, so two plugins can
each ship a `status` skill. Does OpenCode, and if not, what identifies a skill
there: its directory or its frontmatter `name`?

## Method

Two of a consumer's packages built by this projector, called `alpha` and `beta`
here, each shipping `skills/status/SKILL.md` with `name: status`. Both were named by
absolute path in the `plugin` array of a config selected with `OPENCODE_CONFIG`,
in a fresh git repository, and `debug skill` was read back:

1. unchanged, `alpha` first;
2. unchanged, `beta` first;
3. with only the two frontmatter lines edited, to `name: alpha-status` and
   `name: beta-status`, and the directories left as `skills/status`.

## Observations

**Skill names are flat.** Runs 1 and 2 each listed a single `status`, located at
`alpha`'s `package/skills/status/SKILL.md` in both orders. `beta`'s
`status` was not listed at all, so it was unreachable, and which one survives
does not follow the plugin order.

**A skill is identified by its frontmatter `name`, not its directory.** Run 3
listed both `alpha-status` and `beta-status`, each at its original
`skills/status/SKILL.md` location. Every other skill of both plugins was listed
unchanged.

**A name that differs from its directory is accepted silently.** Agent Skills
requires the two to match. With `--print-logs --log-level DEBUG`, run 3 logged
nothing about skills.

**The model can load the renamed skill.** `opencode run` with
`openai/gpt-5.6-luna`, asked to load `alpha-status` through its skill tool,
called `Skill "alpha-status"` and received the skill content
(`# Skill: alpha-status`).

**Control: Codex qualifies them.** The same two packages' Codex builds, installed
from a local marketplace into an isolated `CODEX_HOME` with `codex-cli` 0.154.0,
appeared in `codex debug prompt-input` as `alpha:status` and
`beta:status`, and every other plugin skill was prefixed the same way.
The flat namespace is therefore OpenCode's, not something the packages cause.
Claude Code's `/alpha:status` naming is its documented plugin-skill namespace.

## Consequence

The package projection names each skill `<plugin>-<skill>` by rewriting only the
frontmatter `name` (`packages/adapter-opencode/src/skill-names.ts`). Keeping the
directory means `${PLUGIN_ROOT}/skills/<name>/...` paths and skill-relative
scripts still resolve. If a later OpenCode qualifies plugin skills itself, that
version's profile should stop renaming.

Not probed: Linux or macOS, and project delivery, where skills are copied into
the project's own skills directory and ownership guards the names.
