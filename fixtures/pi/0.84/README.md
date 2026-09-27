# pi 0.84 fixtures

Captured from live pi (`@earendil-works/pi-coding-agent` 0.84.4) sessions on
Windows, 2026-09-27, via `.capture/pi/` (tee extension, print mode, model
routed through the local ollama daemon — execution-environment provenance
only). Canonical files are the decode result **minus `raw`**; output files
are the expected native application of effects. The account name is redacted
to `user` in all path forms; the compact fixture's embedded environment dump
(a bash toolResult in session content, which contained a live credential)
is replaced wholesale with a placeholder — content, not wire shape.

## Invocation shape

The shim receives each event as the live native object plus the extension
context fields it needs: `{ event: <pi event object>, ctx: { cwd, mode } }`.
Fixture `input.json` files are exactly that shape (post-capture, pre-decode).

## Provenance table

| Case | Class | Notes |
|---|---|---|
| `session-start` | captured | reason `"startup"` |
| `before-agent-start` | captured | full `systemPrompt` incl. project context block; `systemPromptOptions` |
| `before-agent-start-isolated` | captured | 2026-09-27, same reference build, Windows; free loopback drift driver in a fresh temporary project and agent home, without user skills, context files, or third-party tool snippets. Account-name path segments redacted as above. |
| `agent-start` | captured | |
| `context` | captured | messages deep copy handed to handler |
| `tool-call-write` | captured | write tool `{path, content}` |
| `tool-call-bash` | captured | **bash `{command}`** — the ShellShapes evidence |
| `tool-result-write` | captured | |
| `tool-result-bash` | captured | bash result content + `details` |
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

- `powershell`, `grep`, `find`, `ls`, `edit`, `read` tool input shapes —
  schema-derived only (installed 0.84.4 type defs); absent from the decoder's
  classification map pending a live capture, or classified without a
  shell-shape entry.
- `tool_execution_*`, `message_*`, `user_bash`, `before_provider_request`,
  `before_provider_headers`, `after_provider_response`, session tree/switch
  events — observed in the type surface; no fixtures (not adapter-observed
  channels, or not yet probed).
- `input` event — fires per token in print mode; not a semantic boundary;
  deliberately unfixture'd.
