# ADR-0021: OpenCode package skills are named for their plugin

## Status

Accepted, 2026-09-23. The policy for a skill that cannot be renamed is set by
[ADR-0022](0022-shortfall-policy.md).

## Context

Claude Code and Codex qualify an installed plugin's skills by the plugin, so a
`status` skill in two plugins is `alpha:status` and `beta:status`.
OpenCode does not (`.capture/opencode-skill-namespace`). With both packages
installed, `opencode debug skill` listed one `status`, the same plugin's in either
plugin order, and the other's could not be reached at all. A package that is
correct on two harnesses silently loses a skill on the third, and neither
author can see it from their own package.

Agent Plugins 1.0 says how skills are discovered in a package, not how a client
exposes them, so this is not a deviation under ADR-0019. It is a gap in what the
projection delivers.

The same capture shows what OpenCode identifies a skill by. With the directories
left as `skills/status`, changing only the frontmatter `name` to
`alpha-status` and `beta-status` listed both. Nothing was logged
about the name differing from its directory, and a model loaded
`alpha-status` through the skill tool.

## Decision

- **OpenCode package projection names each skill `<plugin>-<skill>`.** `:` is
  not a legal Agent Skills name character, so `-` is the nearest spelling of
  the other harnesses' qualified name. A plugin name may contain `.`, which a
  skill name may not, so dots in the prefix become `-`: `com.acme` qualifies
  `status` as `com-acme-status`.
- **Only the SKILL.md frontmatter `name` line changes.** The directory keeps its
  portable name, so `${PLUGIN_ROOT}/skills/<name>/...` paths and skill-relative
  scripts still resolve. The rest of the file keeps its bytes, including
  quoting, comments and line endings. The rewritten file is reported as
  generated rather than copied.
- **A skill already named for its plugin keeps its name.** That is the prefix
  itself, or any name starting with it and `-`, so `alpha-maintenance` is not
  doubled.
- **A skill keeps its bare name when renaming it would be wrong.** That happens
  when:
  - the qualified name would exceed the 64-character limit;
  - it would still break the Agent Skills name rules, as `a.-b` does by
    becoming `a--b-...`;
  - it would duplicate another skill in the same package;
  - the frontmatter has no single top-level `name` line that can be rewritten
    safely.

  The skill is still emitted, and each one is reported as the degradation
  `opencode:skill-name-unqualified` (HN101). It fails the build by default,
  because renaming the skill fixes it; `components.onDegraded: "warn"` or
  listing the id in `components.accept` ships it (ADR-0022).
- **The declaration is the switch.** The profile declares that degradation on
  `agent-plugin.skills`, and the projector renames only when the resolved
  profile declares it. A profile for an OpenCode that qualifies plugin skills
  itself drops the declaration, and with it both the renaming and the reports.
- **An author may keep authored names instead.** The target option
  `skillNames: "authored"` ships every skill exactly as written, so the emitted
  SKILL.md still matches its directory as Agent Skills requires, and accepts
  that another plugin's skill of the same name can hide it. It is a choice
  between two valid outputs, not a shortfall, so it is a target option and not
  a policy (ADR-0022). `"qualified"` is the default. Under `"authored"` the
  projector's `supportFor` reports skills as `exact` and drops the
  degradation, and since the declaration is the switch, nothing is renamed or
  reported. A projector declares `qualifiesSkillNames` to accept the option;
  on any other target, or with project delivery, setting it is an HN501 error,
  as `npmName` is where no npm package is emitted.
- **`agent-plugin.skills` is `emulated` on OpenCode package delivery** with
  the default. The emitted name no longer matches its directory, as Agent
  Skills requires. OpenCode accepts that, and the plugin-qualified naming the
  other harnesses provide is produced by the projection.

## Limits

**No readable prefix can keep every pair of plugins apart.** A skill name
allows only `[a-z0-9-]`, `-` is also the separator, and `--` is forbidden, so no
character is left to escape with. Plugin `a` with skill `b-status` and plugin
`a-b` with skill `status` both become `a-b-status`, and `com.acme` and
`com-acme` share a prefix. The scheme makes a clash between packages far less
likely; it cannot rule one out. Opaque suffixes, such as a hash of the plugin
name, would come closer at the cost of names people can type, and were
rejected for that reason.

**A clash between packages is visible only where packages meet.** One build
sees one package. The places that see several are:

- a marketplace index, such as Claude's `.claude-plugin/marketplace.json` or
  Codex's `.agents/plugins/marketplace.json`, and whatever composes one;
- a repository that builds several plugins;
- the end user's own installation, which may combine unrelated publishers and
  is visible to no build.

The first two can check. The class is named here so they check it the same
way: the id is `opencode:skill-name-clash`, the default is an error, and
acceptance is by id, as ADR-0022 sets out for every class. Hooknostic has no
multi-package build today. If it gains first-class support for composing
marketplaces, the check belongs there, under this id. Until then a composing
repository applies it itself. The third place is why the prefix is needed even
then.

## Not changed

- **Claude and Codex** keep the authored name, because they qualify it
  themselves.
- **Project delivery** is left as it is. Skills are copied into the project's
  own flat skills directory on every harness, and file ownership already
  refuses a second writer to one path.

## Consequences

- An OpenCode user invokes `alpha-status` where a Claude user invokes
  `alpha:status`. Skill text that tells the model to use another skill by
  its bare name would name the wrong one on OpenCode; authors should refer to
  skills by description, or accept that the text is harness-specific.
- If a later OpenCode qualifies plugin skills itself, that version's profile
  drops the degradation, and the capture has to be repeated to find out.
