# Decision 0036 — A session-start notification

**Status:** Accepted — 2026-10-30 · Referenced from code and docs as **ADR-0036**
**Extends:** ADR-0005's `notify` effect, which was introduced for the stop events.
ADR-0025's effect lists and the dispatch budgets apply unchanged.

**In short:** `notify` is now available at `session.start`, through the new
`session.start.notify` capability. It means: show the user this text in an interactive
session, and never put it in front of the model. It is rated `approximate` wherever it
exists, because no harness delivers it in every launch mode.

## Context

A hook often has something to say when a session opens: a tool is missing, a policy is
active, a check was skipped. `session.start.context.add` tells the model, not the user.
The only way to reach the user was to wait for a stop event.

A capability that one harness offers is not portable, so every plugin-visible surface
was probed first. Each probe ran the real binary over the loopback model, with a nonce
in every notice, and searched every model request for it.

| Harness | Channel | Shown | Lost | Evidence |
| --- | --- | --- | --- | --- |
| Claude | `systemMessage` | TUI, every source | `-p` streams it for `compact` only | `.capture/claude-output` |
| Codex | `systemMessage` | TUI, every source | `codex exec` | `.capture/codex-session-start` |
| Copilot | none | nowhere | `systemMessage` is dropped at parse | `.capture/copilot` |
| OpenCode v1 | `client.tui.showToast` at `session.created` | TUI, local or attached | `opencode run` | `.capture/opencode-notice` |
| OpenCode v2 | none for a server plugin | nowhere | needs a `./tui` entry | `.capture/opencode-notice` |
| Pi 1.x | `ctx.ui.notify` | TUI and RPC | print mode, `--continue` | `.capture/pi` |

No model request carried a notice on any harness. Four of the six deliver one, while
`turn.stop.notify` reaches the user without the model reading it only on Claude.

## Decision

1. **`session.start.notify` is a capability on the existing `notify` effect.** No new
   effect kind: the meaning is the same as at the stop events, and the budget and
   composition rules carry over.
2. **User-only is the contract, and a channel the model reads does not qualify.** The
   transcript routes that work in every mode (`promptAsync` with `noReply`,
   `session.synthetic`, a displayed `pi.sendMessage`) are refused here, although
   `turn.stop.notify` accepts such a route on OpenCode. A session-start message the
   model reads is `addContext`, which already exists.
3. **Delivery is interactive and best-effort.** A hook must not rely on a notice for
   anything that has to reach the user. Claude, Codex, OpenCode v1 and Pi are therefore
   `approximate`, each rationale naming what is lost.
4. **OpenCode v2 and Copilot are `unsupported`, stated explicitly.** Hooknostic generates
   no `./tui` entry, and this decision does not add one: it would serve terminal users
   only, because OpenCode Desktop does not load that part (see Consequences).
5. **Pi uses warning level, and only the 1.x line is rated.** Pi's status line replaced
   an info notice after reload, resume and fork. The 0.84 line was not probed.
6. **OpenCode joins notices into one toast.** The TUI shows one toast at a time and a
   newer one replaces it.

## Consequences

- The `session-start-notify` scenario runs on every lane and asserts two things: no
  model request carries the notice, and headless output does not show it. A headless
  drive cannot see a TUI, so the shown half of each cell is held by its `.capture`
  probe and not by the scheduled lanes. The Claude and Codex probes can be rerun under
  node-pty; a harness change there would surface only on a rerun.
- A notice can arrive late or more than once. Codex dispatches SessionStart with the
  first submitted prompt, Claude fires it twice around `/compact` (`resume`, then
  `compact`), and its TUI redraws earlier notices on resume.
- A `./tui` entry would not reach OpenCode Desktop. Desktop loads a separate
  `./gui-experimental` part, a prebuilt CommonJS bundle, from the plugins in the global
  `opencode.json`, so project delivery could not reach it either. Its API is marked
  experimental and has its own toast call. If v2 notices become a priority, the design to
  evaluate is one server RPC event with thin `./tui` and `./gui-experimental`
  subscribers. This rests on a source read (`.capture/opencode-notice`), not a capture:
  Desktop was not run, so it supports the decision not to build, and no rating cites it.
- OpenCode v1 raises `session.start` for every `session.created`. Whether a child
  session's toast is wanted was not probed.
- Hooks should gate on `ctx.capabilities.has("session.start.notify")` and declare it
  `optional`, or a build for Copilot or OpenCode v2 fails on a `required` capability.
