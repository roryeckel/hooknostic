# ADR-0028: A portable token for a skill's own directory

## Status

Accepted, 2026-09-30. Applies the shortfall policy of
[ADR-0022](0022-shortfall-policy.md) to skill text.
Amended 2026-10-19 after [issue #113](https://github.com/roryeckel/hooknostic/issues/113):
Codex uses an explicit absolute-path placeholder with a conditional degradation for
model-dependent substitution.

## Context

A skill that runs a script it ships has to tell the model where that script is.
The Agent Skills specification leaves it to relative paths: a skill's files are
referred to relative to the skill's folder. Every measured harness agrees on
that folder, but not on how the model learns it (`.capture/skill-directory`):

- **Claude Code** prints `Base directory for this skill: <absolute path>` above
  the body. It also expands `${CLAUDE_SKILL_DIR}` in the body to that directory,
  in a plugin skill and a project skill alike, and `${CLAUDE_PLUGIN_ROOT}`,
  `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SESSION_ID}` in a plugin skill. It
  expands nothing else: `${PLUGIN_ROOT}` and `${HOME}` reach the model as
  written.
- **OpenCode**, both families, expands nothing, and follows the body with the
  base directory and "Relative paths in this skill (e.g., scripts/, reference/)
  are relative to this base directory."
- **Codex** expands nothing and hands the model the SKILL.md's absolute path.
  The base instructions of every model it bundles say to resolve relative paths
  against the directory containing the SKILL.md.

The model does the resolving on all three, and a skill's author cannot see how.
In a consumer's live sessions on 2026-09-30 (a smoke test outside this
repository, so weaker provenance than a capture), command skills that ran
`bash scripts/status.sh` and expected the project as their working directory
failed on the model's first try on Claude Code and Codex: the model resolved the
path against the skill's folder, as it is told to, and ran it from there. A skill
needs to name its launcher unambiguously and pass the project separately. The
only spelling of the first that needs no resolving by the model is Claude's
absolute `${CLAUDE_SKILL_DIR}`, and it exists on one harness. A package that uses
it reaches every other harness with the literal text.

Hooknostic copies skills byte for byte, except OpenCode's renamed frontmatter
(ADR-0021). Its design lists an Agent Skills authoring abstraction as a
non-goal: skills define their own portable convention.

## Decision

- **`${SKILL_DIR}` in a SKILL.md body names the skill's own directory.** The
  projection writes each target's form in its place:

  | Target | `${SKILL_DIR}` becomes | Resolution |
  | --- | --- | --- |
  | Claude Code, package and project delivery | `${CLAUDE_SKILL_DIR}` | Claude expands it to the absolute directory |
  | Codex, package and project delivery | `<absolute path of the directory containing this SKILL.md>` | the model must substitute the installed directory from the supplied SKILL.md path; reported as `codex:skill-directory-model-substitution` |
  | OpenCode 1.x and 2.x, package and project delivery | `.` | the skill tool says relative paths are relative to the base directory it prints |

  So `node "${SKILL_DIR}/scripts/status.mjs"` becomes
  `node "${CLAUDE_SKILL_DIR}/scripts/status.mjs"` on Claude Code,
  `node "<absolute path of the directory containing this SKILL.md>/scripts/status.mjs"`
  on Codex, and `node "./scripts/status.mjs"` on OpenCode and Pi.
- **Only the body is rewritten.** The frontmatter is the harness's metadata, a
  name or description is not a path anyone resolves, and ADR-0021's rename
  already owns the one frontmatter line Hooknostic changes. Everything outside
  the replaced tokens keeps its bytes. A rewritten SKILL.md is reported as
  generated, not copied.
- **A reference the target shows as written is a degradation**,
  `skill-reference-unexpanded`, reported as HN101 for the skill. The skill is
  emitted, but its text is not delivered as the author meant on that target.
  The author can fix it in the package, so it fails the build by default, and
  `components.onDegraded` or `components.accept` ship it (ADR-0022). The
  references checked are the ones some harness is measured to expand in skill
  text, or that a package could mistake for one:
  - `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` anywhere, on every target: Agent
    Plugins 1.0 defines them for configuration fields, and no harness expands
    them in a skill.
  - Any `${CLAUDE_...}` variable on Codex and OpenCode.
  - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in a Claude project
    skill, where there is no plugin.
  - In the frontmatter, `${SKILL_DIR}` and every `${CLAUDE_...}` variable, on
    every target, Claude Code included. No harness is measured to expand a
    reference there: Claude Code 2.1.285, asked to quote a plugin skill's
    description, returned its `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and
    `${CLAUDE_SESSION_ID}` as written, though it expands all three in the body.
    That quote is the model's, so it is weaker than reading the prompt, but it
    is the only view of the listing a session gives, and treating the text as
    literal is the safe reading if it is wrong. Codex hands the model the whole
    file as written, and OpenCode expands nothing anywhere.
  - `${SKILL_DIR}` anywhere in a project skill the target discovers in place,
    which Hooknostic does not own and so cannot rewrite.

  Each is declared on the profiles of the delivery it applies to, with this
  capture as evidence.
- **Other `${...}` text is left alone and not reported.** A skill's commands
  are run by a shell, and `${HOME}` or `${VAR:-default}` in one is the shell's
  to expand. Refusing every `${...}` would reject valid skills, and reporting
  every one would bury the few that matter.
- **Codex writes the tested explicit absolute-path placeholder.** The
  owner-reported live probe in issue #113 observed command failures on Codex
  0.163.0 with its bundled `gpt-6-luna`, despite the base instructions still
  prescribing skill-relative paths. Short bodies passed, but bodies with a
  longer argument-quoting paragraph ran `./scripts/where.sh` from the session
  directory; additional command skills also ran from the plugin root. The
  command's location depended on the model choosing the working directory.
  The evidence and its limits are in
  [the probe record](../../.capture/skill-directory/codex-command.md).

  A [controlled live comparison](../../.capture/skill-directory/comparison.md)
  on the same date with Codex 0.163.0 and `gpt-6-luna` found 10/10 first launcher
  attempts succeeded with `<absolute path of the directory containing this SKILL.md>`,
  versus 1/10 with `.` (2/10 after retries). It tested the exact failing body F
  and a declared reconstruction of E, with Git Bash and owner-authorized
  unsandboxed execution. Adopt that exact placeholder: the model can substitute
  the installed skill directory from the absolute SKILL.md path Codex supplies.
  The build does not know the eventual install path, and Codex does not expand
  the placeholder at runtime.

  **Each rewrite remains a degradation, `skill-directory-model-substitution`.**
  The bounded comparison supports the change, but correct substitution still
  depends on the model. Report each rewritten skill as HN101, an error by default
  under ADR-0022. `components.accept: ["codex:skill-directory-model-substitution"]`
  ships an explicitly reviewed exception and still records it as information.
  The component's baseline level stays `exact`: skills without a body token
  are copied as authored, and this particular shortfall is conditional on the
  translation. A token confined to frontmatter, or in a skill discovered in
  place, remains `skill-reference-unexpanded`; it was never rewritten.
  Package and project profiles declare the degradation. Project delivery is a
  conservative application of the same model-dependent substitution,
  not a claim that the comparison separately probed project skills. No version
  boundary is invented: earlier evidence established instructions and literal
  text, not reliable execution of every projected command.

## Alternatives considered

- **Leave skills byte for byte and let authors write relative paths.** That is
  the specification's convention and it already fails first attempts on two
  harnesses, which is what prompted this record.
- **Write an absolute path at build time.** The install location is unknown when
  the package is built: it is a marketplace cache, an npm cache or a project
  path chosen later.
- **Resolve at load time.** OpenCode 2.x registers package skills through a
  generated module that reads each SKILL.md, and could substitute the absolute
  path there. No other target runs Hooknostic code when a skill loads, so it
  would help one family and leave the rest on `.`. It remains an option for
  that family if `.` proves unreliable there.
- **Keep `.` on Codex with a degradation.** This describes the risk honestly,
  but the controlled comparison above supports the explicit placeholder over
  the relative projection for the failing command bodies. The new projection
  retains a degradation for its model-dependent substitution.
- **Reuse `${PLUGIN_ROOT}`.** It names the package, not the skill, it belongs to
  Agent Plugins configuration fields, and the specification requires
  unrecognised placeholder text to stay literal. A skill-scoped name avoids
  implying either.
- **Emit `${CLAUDE_SKILL_DIR}` everywhere.** Only Claude expands it; elsewhere
  the model would receive text naming a variable that does not exist.
- **Refuse every `${...}` a target leaves literal.** See above: it cannot tell a
  harness reference from a shell parameter.

## Consequences

- A consumer writes `${SKILL_DIR}` where it would have written a path relative
  to the skill, and each target gets the form it resolves best. A source
  package that uses the token is a Hooknostic source: installed directly into a
  harness without a build, it shows `${SKILL_DIR}` as written.
- On Codex the model must fill an explicit absolute-directory placeholder; on
  OpenCode and Pi it must resolve `./...` against the skill's directory. Codex's
  substitution remains model-dependent, so the rewrite is reported rather than
  silently treated as exact.
  A skill whose command must run from the project should pass the project
  directory to its launcher explicitly; this alone does not fix the launcher's
  own location.
- Codex's guidance lives in its bundled models' instructions. A model behind a
  custom provider may lack it, and the capture's loopback model did.
- Codex and OpenCode share the `.agents/skills` project destination. When a body
  token produces different bytes there, combined project sync rejects the
  duplicate integration destination before writing. Consumers can use package
  delivery for separate projections, or author text both targets can share.
- A package with Claude-only text in a skill now fails on the other targets
  until it is changed or accepted by id, which is the point.
- The design's non-goal stands with one exception: Hooknostic still defines no
  skill format and validates skills as the specification does, but rewrites
  this one token.
