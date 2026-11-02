# A notice when a session opens, without the model seeing it

0.10.0 adds `session.start.notify`. A hook can show the user a short message as
a session opens — a required tool is missing, a policy is active, a check was
skipped — and no harness puts that message in front of the model. The
capability is a new scope for the existing `notify` effect, decided in
[ADR-0036](decisions/0036-session-start-notify.md); text the model should read
is still `session.start.context.add`. It is delivered on four of the five
harnesses and stated as unsupported on the other two, where no user-only
channel exists. See the versioned [harness support table](harness-support.md)
for the builds behind each rating.

## What is included

- **One capability, four harnesses.** Claude Code, Codex CLI, OpenCode v1 and
  pi 1.x each deliver the notice, rated `approximate` with the loss named. The
  contract is user-only: a channel the model reads does not qualify, so the
  transcript routes `turn.stop.notify` accepts on OpenCode are refused at
  session start.
  - **Claude:** `systemMessage` on `SessionStart` renders in the interactive
    TUI for startup, `/clear`, `/compact` and resume. A `-p` consumer loses it
    except at `/compact`, and a resumed session redraws an earlier notice.
  - **Codex:** `systemMessage` renders in the interactive TUI for every source.
    `codex exec`, plain or `--json`, shows it nowhere. The TUI dispatches
    `SessionStart` with the first submitted prompt, so the notice appears then,
    not when the TUI opens.
  - **OpenCode v1:** a TUI toast (`client.tui.showToast`) at `session.created`,
    shown for 15 seconds when a TUI is attached, local or through `serve`. It is
    inert under `opencode run`.
  - **pi 1.x:** `ctx.ui.notify` at warning level, in the TUI and over RPC.
    Print mode shows nothing, `--continue` can lose a notice, and pi's own
    status line can replace it.
- **Unsupported where it must be stated.** GitHub Copilot CLI drops a
  `sessionStart` `systemMessage` at parse, and an OpenCode v2 server plugin has
  no user-only route: only a companion `./tui` entry could show one, and it
  would not reach OpenCode Desktop, so Hooknostic generates none. Both are
  rated `unsupported` rather than silently dropped, so a build that requires
  the capability fails there with a diagnostic.
- **Declared like any other capability.** A hook declares
  `capabilities: { notify: "optional" }` on its `session.start` hook and gates
  on `ctx.capabilities.has("notify")`. A `required` declaration fails the build
  for Copilot and OpenCode v2.
- **Playback covers it.** The `session-start-notify` scenario runs on every
  lane and asserts the two halves a lane can see: no model request carries the
  notice, and headless output does not show it.
- **Support evidence refreshed.** The playback lanes re-ran against Claude
  2.1.310, Codex 0.164.0, OpenCode 1.19.4 and 2.1.4, and pi 1.4.0. The notice
  probes add Claude 2.1.238 and 2.1.312, Codex 0.148.0 and 0.166.0, Copilot
  1.0.102, OpenCode 1.18.18, 1.19.5, 2.0.17 and 2.2.0, and pi 1.3.0 and 1.4.0.
  Recommended target ranges and reference builds are unchanged.

## Upgrading from 0.9.0

- **Nothing changes for a hook that does not use it.** Artifacts, effects, exit
  codes and diagnostics are the same as 0.9.0.
- **New scope on an old effect.** `notify` returned from a `session.start` hook
  is now licensed, so the SDK accepts what 0.9.0 rejected at compile time.
  Declare the capability and keep it optional wherever the plugin is built for
  more than the four harnesses above.
- **Re-sync a project that adopts it.** The OpenCode shim and the pi extension
  carry the call, so a package needs a rebuild to pick it up, and a
  project-delivered install needs `sync` to rewrite the generated shim and
  extension.

## Limits

- **Best-effort, interactive.** A notice is not a delivery guarantee. Do not
  rely on one for anything that has to reach the user; nothing in a probe
  survived every launch mode.
- **It can arrive late or more than once.** Codex dispatches `SessionStart`
  with the first prompt. Claude fires it twice around `/compact` (`resume`, then
  `compact`) and redraws earlier notices on resume. OpenCode v1 raises
  `session.start` for every `session.created`, including a child session.
- **One toast at a time on OpenCode v1.** A newer notice replaces an older one,
  and a toast sent during plugin initialization is lost under the TUI.
- **Headless and desktop surfaces.** `opencode run`, `codex exec`, print mode
  and Claude's `-p` show nothing in most sources, and OpenCode Desktop cannot
  show an OpenCode v2 notice at all.
- **Only the pi 1.x line is rated.** The 0.84 line was not probed for session
  start.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
