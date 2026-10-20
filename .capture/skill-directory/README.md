# Skill directory and skill-text references

Question: when a harness loads a skill, what text reaches the model, and which
`${...}` references in the SKILL.md does the harness expand? A skill that runs a
script it ships has to name that script's path. The answer decides what a
portable `${SKILL_DIR}` token must become on each target (ADR-0028).

## Method

`SKILL.md` here is the probe: a skill whose body asks the model to repeat nine
lines, each holding one reference: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_SESSION_ID}`, `${SKILL_DIR}`, `${PLUGIN_ROOT}`,
`${PLUGIN_DATA}`, `${HOME}` and a plain `./scripts/where.mjs`.

```bash
node --experimental-strip-types .capture/skill-directory/drive.mjs opencode-v1
node --experimental-strip-types .capture/skill-directory/drive.mjs opencode-v2
node --experimental-strip-types .capture/skill-directory/drive.mjs codex
node --experimental-strip-types .capture/skill-directory/drive.mjs claude   # spends three small Sonnet turns
```

Every state directory (`HOME`, `USERPROFILE`, all four XDG homes, and
`CODEX_HOME` for Codex) is redirected into a fresh OS-temp root, which also holds
the recorded requests.

- **OpenCode 1.x and 2.x.** No model spend. The loopback playback model
  (`packages/cli/test/harness-playback.ts`) calls the harness's `skill` tool for
  the project skill in `.agents/skills/where` (`{ name }` on 1.x, `{ id }` on
  2.x). The tool result in the next request is what the harness gave the model.
- **Codex.** No model spend. `codex exec` with the prompt `$where print the
  lines.` against the loopback model through a custom provider; the first
  request carries the skill Codex injected for the mention.
  `codex debug models` separately lists the bundled models' base instructions.
- **Claude Code.** A real model, because Claude Code's skill text is only
  observable in a session: `claude -p` with `--model sonnet`, once with
  `--plugin-dir` on a one-skill plugin and once in a project with the skill in
  `.claude/skills`. `stream-json` output carries the text the Skill tool handed
  the model. The plugin run creates an empty
  `~/.claude/plugins/data/skilldir-probe-inline`, which can be deleted.

The loopback model's calls are constructed; the text each harness handed the
model is its own.

## Observations (Windows, 2026-09-30)

| Reference | Claude Code 2.1.285, plugin | Claude Code, project skill | Codex 0.154.0 | OpenCode 1.18.33 | OpenCode 2.0.18 |
| --- | --- | --- | --- | --- | --- |
| `${CLAUDE_SKILL_DIR}` | absolute skill directory, `/` separators | absolute skill directory | as written | as written | as written |
| `${CLAUDE_PLUGIN_ROOT}` | absolute plugin root | as written | as written | as written | as written |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<plugin>-<marketplace>` | as written | as written | as written | as written |
| `${CLAUDE_SESSION_ID}` | session id | session id | as written | as written | as written |
| `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, `${HOME}` | as written | as written | as written | as written | as written |

What surrounds the body:

- **Claude Code** prefixes it with `Base directory for this skill: <absolute
  path>` (backslashes on Windows), in both runs, and drops the frontmatter.
  The frontmatter reaches the model only through the skill listing. Asked to
  quote, without loading the skill, a plugin skill's description holding
  `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SESSION_ID}`,
  `${PLUGIN_ROOT}` and `${SKILL_DIR}`, Sonnet returned every one as written
  (the `claude` drive's third turn). That is the model's quote rather than the
  prompt itself, so it is weaker evidence than the body rows above.
- **OpenCode**, both families, wraps it in `<skill_content name="where">`, drops
  the frontmatter, and follows it with `Base directory for this skill: <absolute
  path>` and `Relative paths in this skill (e.g., scripts/, reference/) are
  relative to this base directory.`
- **Codex** injects `<skill><name>where</name><path><absolute SKILL.md
  path></path>` and the whole file, frontmatter included. The request carries
  no instruction about relative paths. The base instructions of all seven
  models `codex debug models` lists do: "Resolve relative paths against the
  directory containing a filesystem-backed `SKILL.md`." The loopback model,
  served through a custom provider with no catalog entry, received none.

## Follow-up: Codex command resolution (2026-10-19)

The owner-reported live probe in [issue #113](https://github.com/roryeckel/hooknostic/issues/113)
shows that those bundled-model instructions do not reliably carry through to
executed commands on Codex 0.163.0. A projected `./scripts/where.sh` sometimes ran
from the session directory or plugin root. See [method, reproduction and evidence
limits](codex-command.md). This follow-up was not independently rerun here and is
live-probe evidence, not a hook-boundary capture or a loopback execution claim.

A later [controlled live comparison](comparison.md), also on 2026-10-19 with
Codex 0.163.0 and `gpt-6-luna`, tested the exact failing body F and a declared
reconstruction of E. The explicit absolute-path placeholder succeeded on the
first launcher attempt in 10/10 sessions; `.` in 1/10, with one additional recovery
after failure. The completed comparison used Git Bash and owner-authorized
unsandboxed execution after both native sandbox modes stalled. Its sample and
scope do not establish an exact guarantee. Codex now emits that tested explicit
placeholder with a model-substitution degradation; see the adoption note in the
comparison record.

## Consequences

Pi's later [feature probes](../pi/FEATURES.md) establish the same relative-path
instruction for project and installed-package skills. All tested references,
including `${SKILL_DIR}` in descriptions, remain literal. Pi therefore uses the
relative body projection and unsupported-reference diagnostics too.

- `${SKILL_DIR}` in a SKILL.md body projects to `${CLAUDE_SKILL_DIR}` on Claude
  Code, package and project delivery alike; to
  `<absolute path of the directory containing this SKILL.md>` on Codex; and to
  `.` on both OpenCode families, where the model is instructed to resolve a path
  relative to the skill's directory. Codex body rewrites report the conditional
  `skill-directory-model-substitution` degradation (HN101, an error by default):
  the model must substitute the installed directory, without runtime expansion
  by Codex. Project delivery conservatively reports the same dependency; the
  follow-up measured installed packages only.
  The frontmatter is never rewritten.
- A skill-text reference the target shows as written is the degradation
  `skill-reference-unexpanded` (HN101, an error by default): the Agent Plugins
  placeholders anywhere; any `${CLAUDE_...}` variable on Codex and OpenCode;
  `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in a Claude project skill;
  `${SKILL_DIR}` and any `${CLAUDE_...}` variable in the frontmatter, on every
  target; and `${SKILL_DIR}` where it cannot be rewritten. `${HOME}` and other shell
  parameters are not reported: a command the model runs is expanded by its
  shell.
- The original expansion probes measured project skills on Codex and OpenCode;
  the later Codex command comparison measured installed packages. Package skills reach
  the model through the same skill mechanisms: OpenCode 1.x discovers them
  through `skills.paths`, OpenCode 2.x registers them with `skill.transform`
  from the file's own text, and Codex lists an installed plugin's skills beside
  project skills.
