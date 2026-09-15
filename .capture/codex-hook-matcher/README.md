# Codex PreToolUse matcher investigation

Evidence class: **live-probe**. Measured Codex CLI **0.153.2**, native Windows,
2026-09-14. No model credits: the model is the loopback playback server.

## Question

Does a project `.codex/hooks.json` `PreToolUse` group honour `matcher`, what
name is it compared against, and is it an exact name, a word list, or a regex?
The answer decides whether the Codex generator can register the dispatcher for
only the tools a plugin's hooks can match.

## Method

```sh
pnpm run bundle
pnpm exec vitest run --config .capture/codex-hook-matcher/vitest.config.ts
```

The probe writes one `PreToolUse` group per candidate matcher into a scratch
project, each recording the `tool_name` it received, then drives one scripted
shell call through `codex exec` with an isolated `CODEX_HOME`, credential
variables removed, and `--dangerously-bypass-hook-trust` (the scratch home has
no recorded trust, which is the state that flag was observed to cover). The
scratch tree is deleted afterwards. `observations.json` is the record.

## Observations

| Matcher | Dispatched |
|---|---|
| (omitted) | `Bash` |
| `*` | `Bash` |
| `Bash` | `Bash` |
| `exec_command` | nothing |
| `Bash\|PowerShell` | `Bash` |
| `^(?:Bash\|exec_command)$` | `Bash` |
| `Ba` | nothing |
| `Read` | nothing |

- The matcher is honoured and compared against the **hook-boundary** tool name.
  The shell call reached every hook as `Bash`; a matcher naming the router tool
  `exec_command` did not fire, consistent with `.capture/codex-tools`.
- A `|` word list matches its names exactly, an anchored regex matches, and a
  bare prefix does not, so a word list or an anchored, escaped alternation is a
  safe encoding. Whether an unanchored regex is full-match or the word-list rule
  applies to `Ba` is not separated by this probe and is not relied on.

## Limits

Only `PreToolUse` and a shell tool were exercised. `PostToolUse`,
`PermissionRequest`, and MCP tool names under a matcher remain uncaptured, so
the generator filters `PreToolUse` only and leaves the `mcp` kind unfiltered.
POSIX harness behaviour is not established here.
