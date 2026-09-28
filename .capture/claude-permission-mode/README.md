# Claude interactive permission mode

Evidence class: **live-probe**, corroborated by **schema-derived** reads of the
installed binaries. Run on **2026-09-27** on Windows against Claude Code
**2.1.238** (npm package, installed into an isolated directory) and **2.1.283**
(native installer build). The observations are terminal frames and selected
hook-payload fields from pty sessions against the loopback model. They are not
hook-input fixtures.

## Questions

1. Which permission mode does an interactive session start in? Does the
   scripted shell call still reach `PermissionRequest`?
2. Which switch selects the prompting mode on both builds: the
   `--permission-mode` flag (as `manual` or the older `default`), or the
   `permissions.defaultMode` setting?
3. Which interstitials does the TUI render on the way, and where?
4. What does a session started from inside a Claude session inherit, and what
   does it change?

## Method

`probe.test.ts` gives each variant a fresh project and an isolated
`CLAUDE_CONFIG_DIR`. It seeds the same onboarding state as the playback pty
lane and registers user-settings hooks for `PreToolUse` and
`PermissionRequest` that tee their stdin. It then starts the interactive TUI
under `node-pty` against the repository's loopback Anthropic server. The model
is scripted to make one Bash call that would write a marker file.

The probe walks the first-run dialogs and records the startup screen. It sends
the prompt, then answers what renders:

- the classifier billing notice, with Enter;
- a native permission prompt, with Esc (deny), so the command never runs.

The environment follows the pty lane's rule: no credentials, and no
`CLAUDECODE`, `CLAUDE_*` (except `CLAUDE_CODE_GIT_BASH_PATH`), `AI_AGENT`, or
`TRACEPARENT`. The nested variant adds back the two markers the harness itself
sets on child processes, with the harness's own values.

| Variant | Switch |
| --- | --- |
| `no-switch` | none |
| `no-switch, nested markers` | none; `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1` |
| `--permission-mode manual` | CLI flag |
| `--permission-mode default` | CLI flag, older spelling |
| `settings permissions.defaultMode=default` | user `settings.json` |

Reproduce from the repository root. Set `HOOKNOSTIC_CLAUDE_BIN` to probe a
build other than the `claude` on `PATH`:

```powershell
pnpm run bundle
pnpm exec vitest run --config .capture/claude-permission-mode/vitest.config.ts
```

Each run writes `observations-<version>.json`. The files record only
`hook_event_name`, `permission_mode`, and `tool_name` from each hook payload,
because full payloads carry local paths.

## Observations

| Variant | 2.1.238 `permission_mode` | 2.1.238 `PermissionRequest` | 2.1.283 `permission_mode` | 2.1.283 `PermissionRequest` |
| --- | --- | --- | --- | --- |
| `no-switch` | `default` | fired | `auto` | never fired |
| `no-switch, nested markers` | `default` | fired | `auto` | never fired |
| `--permission-mode manual` | `default` | fired | `default` | fired |
| `--permission-mode default` | `default` | fired | `default` | fired |
| `settings permissions.defaultMode=default` | `default` | fired | `default` | fired |

- **2.1.283 starts interactive sessions in auto mode.** The startup screen
  announced "Auto mode is now Claude Code's default permission mode", and the
  footer read "auto mode on". The Bash call reached `PreToolUse` with
  `permission_mode: "auto"`, no native prompt rendered, and `PermissionRequest`
  never fired. 2.1.238 started in the prompting mode.
- **Every switch selected the prompting mode on both builds.** Hooks received
  `permission_mode: "default"`, the native prompt rendered, and
  `PermissionRequest` fired. No auto-mode notice rendered. `manual` is the
  spelling both builds list in `--help`; `default` was accepted too.
- **The classifier billing notice is an auto-mode interstitial.** On 2.1.283
  without a switch, a modal rendered after the Bash call's `PreToolUse`: auto
  mode no longer charges for classifier requests, "However, this session isn't
  eligible" because requests go through the loopback address, "Nothing
  breaks", "Enter to continue · Esc to cancel". It did not render at startup or
  in any variant with a switch. `classifierBillingModalFrame` holds the frame.
  The probe pressed Enter, the notice's continue option. The scripted command
  did not run. How auto mode settled the call against the loopback varied
  between runs and was not a question here.
- **The first-run walk saw only the trust dialog** on both builds, given the
  seeded onboarding state.
- **The nested markers turned transcript saving off** on both builds, with the
  notice "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker". They changed nothing else the probe observed.

### Schema-derived corroboration

Read from the installed binaries, not observed:

- Both builds map `manual` to the internal mode `default`. 2.1.238 exports
  this as `normalizePermissionModeAlias`. So the two spellings are one mode,
  which the identical hook payloads confirm.
- Both builds have a child-process environment builder that sets
  `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION=1`, and
  `CLAUDE_PID`. It adds `AI_AGENT`, `CLAUDE_EFFORT`, and `TRACEPARENT` under
  some conditions. The 2.1.283 builder also sets
  `CLAUDE_CODE_SESSION_ATTENDED`, so the set grows between builds.
- 2.1.283 reads `CLAUDE_CODE_CHILD_SESSION` and `CLAUDECODE` back at startup.
  The transcript notice's internal cause is named `nested_marker`.
- 2.1.283 keeps an inherited `CLAUDE_CODE_ENTRYPOINT` instead of computing
  `cli`.
- 2.1.283 records `CLAUDE_CODE_MESSAGING_SOCKET` as `messagingSocketPath` in
  the session metadata it registers. A child that inherits it names the
  enclosing session's socket as its own.

## Consequences

- **The playback pty lane passes `--permission-mode manual`** on every drive.
  It is the spelling both builds advertise in `--help`, and a flag keeps the
  choice in the drive's own code rather than in seeded settings. The lane does
  not rely on either build's default.
- **The first-run walk knows the classifier billing notice** by the marker
  "changing auto mode to no longer charge for classifier requests", and presses
  Enter. With the forced mode it should not render. The walk handles it in case
  a build renders it before the main prompt.
- **The lane drops inherited Claude session variables.** It removes
  `CLAUDECODE`, `AI_AGENT`, `TRACEPARENT`, and every `CLAUDE_*` variable except
  `CLAUDE_CODE_GIT_BASH_PATH`, which the harness reads to find its Windows
  shell. A prefix rule covers markers that later builds add. CI has none of
  these variables.
- No capability rating, hook fixture, or adapter shape changes. The adapter
  already rates `permission.request.*` interactive-only; this capture is about
  how the test lane reaches an interactive prompt.
