# Codex hook command form probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-08**,
on native Windows, with one `codex exec` session on `gpt-5.3-codex-spark`.

## Question

A plugin hook command is a single string, and `${PLUGIN_ROOT}` expands inside it
to an absolute install path under the user's home directory — which on Windows
routinely contains a space. Unquoted, such a command splits and the hook never
starts.

Claude avoids this entirely: it emits the **exec form**, `command: "node"` with
`args: ["${CLAUDE_PLUGIN_ROOT}/…"]`, and `docs/baseline-2026-08-20.md` records
that form as bypassing the shell. Does Codex accept it? If not, does quoting the
path work, or does Codex tokenize the string itself and leave the quotes literal?

Guessing between those two is unsafe in both directions: the exec form silently
does nothing if `args` is ignored, and quotes become part of the path if there is
no shell.

## Method

One plugin, one `UserPromptSubmit` event, three command spellings side by side,
each running the same script with a distinct label that writes a marker file
recording its own `process.argv`. The session is `codex exec
--skip-git-repo-check --dangerously-bypass-hook-trust` in an empty scratch
directory.

| Spelling | Form |
|---|---|
| `exec` | `command: "node"`, `args: ["${PLUGIN_ROOT}/probe.mjs", "exec"]` |
| `quoted` | `command: "node \"${PLUGIN_ROOT}/probe.mjs\" quoted"` |
| `plain` | `command: "node ${PLUGIN_ROOT}/probe.mjs plain"` |

## Observations

The run logged three `hook: UserPromptSubmit` lines, then **two Completed and one
Failed**. Two markers were written:

| Spelling | Marker | `process.argv[1..]` |
|---|---|---|
| `exec` | **absent** | — |
| `quoted` | written | `…\cmdmkt\cmdprobe\1.0.0\probe.mjs`, `quoted` |
| `plain` | written | `…\cmdmkt\cmdprobe\1.0.0\probe.mjs`, `plain` |

**Codex does not accept the exec form.** `args` beside `command` is the spelling
that failed. Claude's approach does not transfer, and the baseline's "use the
exec form for generated hooks" is a Claude fact, not a Codex one.

**The command string is parsed with quoting honoured.** The quoted spelling ran
and its argv came through as one path plus one argument, so the quotes were
consumed as syntax rather than passed through as characters.

## Consequences

- The generated plugin-mode hook command quotes the substituted path:
  `node "${PLUGIN_ROOT}/hooknostic/hooknostic.mjs"`. The bare form works only
  while the install path happens to contain no space.
- The local-mode command is unaffected: it is a project-relative path this
  build controls, not a substituted absolute one.

## Not established

- Behaviour with a space actually present in the install path. It could not be
  reproduced here: marketplace names are restricted to ASCII letters, digits,
  `_` and `-`, plugin names are constrained by the manifest schema, and the
  remaining segment is the user's home directory. The quoting above is the fix
  for a hazard demonstrated by construction rather than reproduced.
- Whether `commandWindows`, which the binary's strings mention, offers a
  separate argv channel.
- Linux and macOS behaviour. Windows only.
