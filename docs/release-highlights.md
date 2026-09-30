# Skills name their own directory, and one-shot OpenCode runs keep their hooks

0.4.0 adds a portable way for a skill to name the scripts it ships, and fixes a
`turn.stop` hook being cut off when a one-shot `opencode run` exited.

- Write `${SKILL_DIR}` in a SKILL.md body to name the skill's own directory:
  `node "${SKILL_DIR}/scripts/status.mjs"`. Claude Code's projection writes
  `${CLAUDE_SKILL_DIR}`, which Claude expands to the absolute directory; Codex
  and OpenCode get `.`, a path their skill instructions resolve against the
  skill's directory. Package and project delivery alike, body only
  ([ADR-0028](decisions/0028-skill-directory-token.md)).
- A skill whose text keeps a reference its target shows the model as written,
  such as `${CLAUDE_PLUGIN_ROOT}` on Codex or `${PLUGIN_ROOT}` anywhere, fails
  the build as the `<adapter>:skill-reference-unexpanded` degradation (**HN101**).
  Shell parameters such as `${HOME}` are left alone.
- The OpenCode 1.x plugin now returns `dispose`, which OpenCode awaits before a
  one-shot `opencode run` exits. It waits for the hooks still running, for up to
  their timeouts plus one 10 s host round trip and never more than 15 s, so a
  `turn.stop` hook dispatched at `session.idle` finishes instead of being killed.

## Migrating

- A package with Claude-only text in a skill, such as `${CLAUDE_PLUGIN_ROOT}`,
  now fails its Codex and OpenCode targets. Replace a skill-relative path with
  `${SKILL_DIR}`, or accept the id you have handled:
  `components.accept: ["codex:skill-reference-unexpanded"]`.
- Project delivery reports degradations too: `target.project.degradations` in
  the build report, under the same `components.onDegraded` and `accept`.
- `projectSkillFiles` in `@hooknostic/core` takes the target's skill-text rules
  as a fourth argument; adapter authors pass their own.
- A one-shot `opencode run` on OpenCode 1.x can now take up to 15 s longer to
  return while its hooks finish.

## Limits

- On Codex and OpenCode the model still resolves `./...` against the skill's
  directory. A command that must run from the project should be given the
  project explicitly. Codex's guidance comes from its bundled models'
  instructions; a model behind a custom provider may not have it.
- A project skill that already sits at its destination is discovered in place
  and cannot be rewritten; a `${SKILL_DIR}` in it is reported.
- OpenCode 2.x: `run --standalone` terminates its private server without calling
  plugin cleanup, so a hook still running when the run ends is lost. Through the
  background service it completes there. Measured on Windows only.

Start with the [README](../README.md); [configuration](configuration.md) covers
skills that run their own scripts, and [OpenCode families](opencode-families.md)
covers one-shot runs.
