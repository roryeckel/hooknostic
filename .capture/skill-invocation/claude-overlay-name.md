# Claude package skill identity after a native overlay

Evidence class: **live-probe**, native Windows, 2026-11-06, Claude Code 2.1.238
(the adapter's reference build). This follows the loopback `anthropic-messages`
procedure in `drive.mjs`; model replies and Skill calls were scripted. No model
credentials or model spend were used. This is a bounded observation, not a
claim about every native name override or TUI picker behavior.

Question for issue #157: does a native overlay that changes the frontmatter
name make the portable directory-based sibling reference unusable?

## Method

Create an isolated project and plugin. The plugin manifest names
`context-probe`; its `skills/setup/SKILL.md` contains:

```markdown
---
name: renamed
description: Naming probe
---
HOOKNOSTIC_CONTEXT_NAME_BODY
```

Run two fresh sessions with `--plugin-dir` pointing to that plugin, isolated
HOME/USERPROFILE/CLAUDE_CONFIG_DIR, credentials removed, and ANTHROPIC_BASE_URL
pointing only at the local playback server. Use `-p "Load the requested skill."`,
`--model hooknostic-playback`, `--dangerously-skip-permissions`, `--max-turns 4`,
`--output-format stream-json`, and `--verbose`. Script a `Skill` call with each
reference below, then a text completion. Look for the body-only marker in the
actual model requests rather than accepting the harness's completion message.

| Scripted `Skill` argument | Exit | Model requests | Body marker observed | Playback errors |
| --- | --- | --- | --- | --- |
| `{"skill":"context-probe:setup"}` | 0 | 3 | yes | none |
| `{"skill":"context-probe:renamed"}` | 0 | 3 | yes | none |

Both references delivered the skill body. The authored directory-based reference
remains usable in this overlay case, so Claude's sibling map retains the canonical
skill name. The body is still projected from the effective overlaid file. No
additional alias is promised by the portable token.
