# pi 0.84 fixtures

Captured from live pi (`@earendil-works/pi-coding-agent` 0.84.4) sessions on
Windows, 2026-09-27, via `.capture/pi/` (tee extension, print mode). The
original cases used the local ollama daemon; the PowerShell pair used a
loopback model server. Model routing is execution-environment provenance
only. Canonical files are the decode result **minus `raw`**; output files
are the expected native application of effects. The account name is redacted
to `user` in all path forms; the compact fixture's embedded environment dump
(a bash toolResult in session content, which contained a live credential)
is replaced wholesale with a placeholder — content, not wire shape.

The original `run-capture.mjs` split multiword prompts into separate Pi
submissions. The `before-agent-start` fixture's `"Create"` prompt is one such
submission; the surrounding payload shapes are still captured evidence, but
that run cannot establish per-prompt cadence. The isolated loopback fixture
used an intact prompt, and a later single-prompt loopback probe confirmed one
full-text `input` event per submitted print-mode prompt.

## Invocation shape

The shim receives each event as the live native object plus the extension
context fields it needs: `{ event: <pi event object>, ctx: { cwd, mode } }`.
Fixture `input.json` files are exactly that shape (post-capture, pre-decode).

## Provenance table

| Case | Class | Notes |
|---|---|---|
| `session-start` | captured | reason `"startup"` |
| `before-agent-start` | captured | `"Create"` is the first shell-split prompt; full `systemPrompt` incl. project context block; `systemPromptOptions` |
| `before-agent-start-isolated` | captured | 2026-09-27, same reference build, Windows; free loopback drift driver in a fresh temporary project and agent home, without user skills, context files, or third-party tool snippets. Account-name path segments redacted as above. |
| `agent-start` | captured | |
| `context` | captured | messages deep copy handed to handler |
| `tool-call-write` | captured | write tool `{path, content}` |
| `tool-call-bash` | captured | **bash `{command}`** — the ShellShapes evidence |
| `tool-call-powershell` | captured | Windows `--tools powershell` against loopback model; **powershell `{command}`** — ShellShapes evidence. The forced tool set changes prompt snippets, so the alternate-tool drift driver's generic bash comparator reports expected differences. |
| `tool-result-write` | captured | |
| `tool-result-bash` | captured | bash result content + `details` |
| `tool-result-powershell` | captured | Same Windows loopback session, successful command with text content |
| `tool-result-error` | captured | `isError: true`, `exit 7` |
| `turn-start` | captured | `{turnIndex, timestamp}` |
| `turn-end` | captured | `{turnIndex, message, toolResults}` |
| `agent-end` | captured | `{messages}` |
| `agent-settled` | captured | fires after retries/compactions settle |
| `session-shutdown` | captured | reason `"quit"` |
| `session-before-compact` | captured | `preparation` + `branchEntries`; env-dump content redacted (see above) |
| `session-compact` | captured | successful compaction; `compactionEntry` carries the summary |
| `session-compact-failed` | captured | cancel-by-extension path (`aborted: true`) |

Effect-channel evidence (block, in-place input mutation, result replacement,
system-prompt injection, prompt suppression, compaction cancel, turn
injection via `sendMessage({triggerTurn: true})`) lives in
`.capture/pi/README.md` — verified by effect, not represented as fixtures.

## Not captured (declined, not defaulted)

- `grep`, `find`, `ls`, `edit`, `read` tool input shapes remain schema-derived
  only (installed 0.84.4 type defs); non-shell tools classify by name and raw
  input remains available.
- `tool_execution_*`, `message_*`, `user_bash`, `before_provider_request`,
  `before_provider_headers`, `after_provider_response`, session tree/switch
  events — observed in the type surface; no fixtures (not adapter-observed
  channels, or not yet probed).
- `input` event — corrected single-prompt print-mode probe captured the full
  submitted text in one event; deliberately unfixture'd because the adapter
  observes `before_agent_start` instead.
