# OpenCode session-start notice capture

Question: can an OpenCode plugin show the **user** a notice at session start
that the **model** never sees? It is asked for 1.x (`opencode-ai`) and 2.x
(`@opencode/cli`), under every launch mode. This is evidence only. It adds no
vocabulary, capability cell or adapter behaviour.

**Live probes over the loopback playback model, Windows, 2026-10-30.** Builds:
1.18.18 (v1 reference) and 1.19.5 (latest 1.x), each from a scratch
`npm install --prefix`; 2.0.17 (v2 reference, scratch install) and 2.2.0
(installed). No credential and no paid model were used. Every run recorded
2 to 5 loopback requests, so the model side was observed and not assumed.

## How to reproduce

After `pnpm build`, from the repository root:

```bash
HKN_OPENCODE_BINARY=<native opencode.exe> \
  node --experimental-strip-types .capture/opencode-notice/drive.mjs <v1|v2> <tui|attach|run|serve> [variant]
```

The variants are `toast`, `append` and `noreply` for v1, and `toast` and
`synthetic` for v2. Each run uses a fresh project, isolated XDG and home
directories, no inherited `CLAUDE*`, `AI_AGENT` or `OPENCODE*` variables, and a
top-level `model` pinned at the loopback. v1 runs also set `autoupdate: false`:
without it, 1.18.18 showed an update dialog that took the first typed Enter
and tried to self-update the scratch binary (the update failed). Every notice
carries the run nonce `HKN-NOTICE-<hex>` and a route code. A match therefore
names the route, and `noticeInAnyRequest` searches every recorded model
request body. Output lands in `captured/<family>-<version>-<mode>-<variant>/`
(git-ignored) as `summary.json`, `surface.txt` and `requests.json`. This file
is the durable record.

What counts as "shown" in each mode:

- **tui**: the rendered screen of a headless xterm fed by node-pty, sampled
  every 150 ms, because toasts are transient. Two prompts are typed.
- **attach**: the same screen, but for a TUI attached to a separate
  `opencode serve` (v1 `opencode attach <url>`, v2 `opencode --server <url>`).
- **run**: stdout and stderr.
- **serve**: the server's event stream (`/event` on v1, `/api/event` on v2).
  An event there is only what a client would receive. It is not proof that
  anything rendered.

The probe plugins are `v1-plugin.js` and `v2-plugin.js`. The v2 plugin is
server-only, a project `.opencode/plugins/` file with no `./tui` entry.

## Findings

Table cells read *shown / reached the model*. "—" means the route was not
reached in that mode: `opencode run` exits before a delayed call fires.

### v1 (1.18.18 and 1.19.5 alike unless noted)

| Route | tui | attach | run | serve stream |
| --- | --- | --- | --- | --- |
| `client.tui.showToast` at plugin init (IT) | no / no | no / no | no / no | event / no |
| `showToast` 3 s after init (DT) | **yes** / no | **yes** / no | no / no | event / no |
| `showToast` at `session.created` (CT) | **yes** / no | **yes** / no | no / no | event / no |
| `client.tui.publish(tui.toast.show)` 6 s after `session.created` (CP) | **yes** / no | yes on 1.19.5, not observed on 1.18.18 / no | — | event / no |
| `client.tui.appendPrompt` at `session.created` (CA) | in the input box / **yes**, sent with the next prompt | | | |
| `client.session.promptAsync` with `noReply` (CN) | **yes**, as a user message / **yes**, in both later requests | | | message event / **yes** |

- `client.tui` exposes `appendPrompt, openHelp, openSessions, openThemes,
  openModels, submitPrompt, clearPrompt, executeCommand, showToast, publish`
  plus a `control` namespace. Every toast call returned HTTP 200 with
  `true` in every mode, whether or not anything rendered. A successful call is
  not evidence of display.
- The toast is a genuine user-only channel **only under a TUI**, the local
  TUI or one attached to `serve`. It never appeared in any model request.
  Under `opencode run` nothing renders. Under `serve` it becomes a
  `tui.toast.show` event that only an attached TUI turns into a toast.
- **A toast sent during plugin init is lost** under the TUI, even though the
  same event reaches the serve stream. The TUI subscribes after init. The same
  call 3 s later renders. A "session start" notice therefore has to be sent at
  `session.created` or later, not at load.
- On 1.18.18 `opencode run`, **awaiting** `showToast` inside plugin init hung
  the process silently for the full 90 s timeout, with no model request
  (`HKN_NOTICE_AWAIT_INIT=1` reproduces it). Not awaited, the same call
  returned 200 at once. That run was not repeated on 1.19.5.
- The TUI shows one toast at a time and a newer one replaces it. In a first
  run that fired CT and CP together, only CP was observed. The probe now spaces
  them out.
- The approximate route, `promptAsync` with `noReply`, is shown, but as a
  user-role transcript message. The model reads it on every later request,
  confirming `.capture/opencode-client`. `appendPrompt` is visible but sits in
  the user's input, so the next submission carries it to the model.

### v2 (2.0.17 and 2.2.0 alike)

| Route (server-only plugin) | tui | attach | run | serve stream |
| --- | --- | --- | --- | --- |
| `ctx.ui.toast.show` (IU/CU) | absent | absent | absent | absent |
| `ctx.attention.notify` (IA/CA) | absent | absent | absent | absent |
| `ctx.rpc.register` + `events.emit`, no TUI subscriber (IR/CR) | no / no | no / no | no / no | `rpc.<id>.message` event / no |
| `ctx.session.synthetic` with `resume:false` at `session.created` (CS) | **no** / **yes**, in both later requests | | | inbox events / **yes** |

- The live server `ctx` keys are `app, location, options, agent, aisdk,
  command, credential (2.2.0), event, experimental, generate, model, provider,
  integration, mcp, permission, plugin, reference, rpc, skill, storage, tool,
  vcs, websearch, worktree, session, shell`. Neither `ui` nor `attention`
  exists at runtime, matching `@opencode/plugin`'s typings. Those live only on
  the TUI plugin context. A walk of every ctx path finds no other user surface:
  the only names that match are `integration.*.status` and `vcs.status`.
  `ctx.rpc` offers only `register`.
- A server plugin's RPC event reaches the server event stream. **No built-in
  TUI renders it**, neither the local TUI nor one attached to `serve`. Only a
  companion `./tui` entry that subscribes to it can. That companion route
  still works on 2.2.0: `../opencode-v2/drive.mjs notifications` rendered the
  server-emitted sentinel and made no model request. `ctx.attention.notify`
  on the TUI side still returned `attention_disabled` under scratch defaults.
- **A server-only plugin with no `./tui` entry can show the user nothing** at
  session start that the model does not also see.
- `session.synthetic` with `resume:false` is not rendered by the TUI, which
  confirms the 2.0.17 stop audit. It reaches the model with the next prompt.
  It is the opposite of the wanted semantics.
- On `serve`, plugin setup is lazy and ran only after the **first prompt**:
  both sessions created before it were missed by the subscription. The serve
  drive therefore prompts a warm-up session before the probed one. This
  extends the v2 profile note "a server session created before lazy plugin
  setup is missed".

## Consequence

A portable `session.start.notify` has these OpenCode cells:

- **v1**: a real user-only channel exists, `client.tui.showToast` at
  `session.created`, but **only under a TUI**. Under `opencode run` it is
  inert, and under `serve` it reaches only attached TUIs.
- **v2**: a user-only route needs a companion `./tui` entry. A server-only
  plugin, which is what hooknostic generates today, has none.

Neither family offers a mode-independent route. The only route that works in
every mode, a transcript message (`noReply` / `synthetic`), is read by the
model.

## OpenCode Desktop (doc-derived, source read 2026-10-30)

Desktop was **not run**. No probe here observed it, and nothing above covers
it. This records a read of the `anomalyco/opencode` `dev` branch and its plugin
docs; `packages/plugin/src/gui/plugin.ts` was also confirmed in tag `v2.2.0`.

- A v2 plugin has separate parts. `./tui` runs in the terminal UI, and
  `./gui-experimental`, a prebuilt CommonJS bundle using
  `@opencode/plugin/gui`, runs in Desktop windows and its main process.
- Desktop loads GUI parts from the plugins in the global `opencode.json`, so a
  project-level plugin would not reach it.
- The GUI context has its own toast API, in `packages/plugin/src/gui/host-apis.ts`.
- Only the desktop app's own server runs a plugin's GUI. Other servers and the
  web app list plugin names (`packages/app/src/runtime/plugin/extension-plugins.tsx`).
- A code search found no `tui.toast` handling under `packages/app`,
  `packages/desktop`, `packages/ui` or `packages/session-ui`, which suggests the
  v1 toast does not reach Desktop either. A code search can miss files, so this
  is not established.

Consequence: a companion `./tui` entry serves terminal users only (ADR-0036).
