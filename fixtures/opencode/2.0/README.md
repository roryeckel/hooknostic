# OpenCode v2 hook boundary

Captured on Windows, 2026-09-26, using `@opencode/cli` 2.0.17 and
`.capture/opencode-v2/drive.mjs observe`. The CLI used a private server,
fresh scratch state, and the repository's loopback scripted model.

| Fixtures | Provenance | Observation |
| --- | --- | --- |
| tool-before, tool-after | captured | `shell` command input and structured completion result |
| prompt | captured | Prompt admission callback |
| context, title | captured | Distinct ordinary-agent and title request callbacks |
| session-created, execution-succeeded | captured | Public event subscription envelopes |
| tool-write/read/edit/glob/grep-before/after | captured | Successful file operations from the `tools` drive |
| tool-patch-before/after | captured | A GPT-like model id (`HKN_MODEL_ID=gpt-5-playback`, `tools-patch` drive, 2026-09-27) replaces edit/write with `patch`; its `patchText` holds a Codex-grammar patch that applied |
| tool-shell-workdir-before/after | captured | Explicit working directory containing a space; command output confirms cwd |
| tool-webfetch-before/after | captured | Fetch from the loopback fixture endpoint |
| tool-websearch/subagent-before | captured | Admission boundary only; capture hook deliberately blocks execution |
| tool-skill-before/after | captured | Native skill loaded by directory ID, preserving its authored name |
| tool-execute-before/after, tool-mcp-inner-before/after | captured | Code Mode emits outer `execute` and inner MCP tool hooks; fixture output reaches the model |
| tool-custom-namespace-before/after | captured | A custom tool uses the same namespace as a connected MCP server and remains `kind: other` |
| mcp-identity/*.json | captured | Public registry snapshots during an inner MCP call; executable functions omitted by JSON serialization |

Input records are verbatim JSON snapshots of the live callback objects,
wrapped with callback name and plugin directory by the tee. Canonical files
are decoder output minus `raw`. The capturing account segment is redacted to
`user`; Windows path syntax and scratch names are preserved.

Behavioral probes and limitations are recorded in `.capture/opencode-v2`.
Follow-up OAuth, native TUI and stop evidence is documented below; a user-only
notification remains unsupported.

| Additional case | Provenance | Observed boundary |
| --- | --- | --- |
| generate, compaction | captured | Separate mutable system-part callbacks; generated markers reach successful requests |
| compaction-ended | captured | Successful summary completion, after template validation |
| permission-ask | captured | Ask evaluation; action/resources and call ID, no tool input/name |
| execution-failed/interrupted | captured | Deliberate HTTP 400 and rejected approval, respectively |
| session-audit/permissions.json | captured + constructed labels/counts | Allow, accept, reject and configured-deny controls |
| remote/observations.json | captured + constructed scenario labels | HTTP execution/headers and absent legacy SSE fallback |
| session-created-child | captured | Subagent child creation carrying the parent as `parentID` |
| tool-read-in-subagent-before/after | captured (2026-09-29, `.capture/agents` `direct` case, `promote.mjs`) | A `read` inside a delegated project subagent: `agent` names the subagent, where the parent's own tool events name its primary agent (`build`). Delegation and read arguments scripted; the `directory` envelope is the plugin's `ctx.location.directory`, as the shim wraps it |
| execution-interrupted-user | captured | User interrupt of a pending request (`reason: "user"`) |
| stop-audit/outcomes.json | captured counts + constructed labels | Execution counts per session for the `stop` drive |

These additions use the same version/date on Windows. Procedures and limits:
`.capture/opencode-v2-session` and `.capture/opencode-v2-remote`.

The tool expansion was captured with `drive.mjs tools`, also on Windows with
the same version/date. `promote-tools.mjs <scratch-root>` promotes only reviewed
tool snapshots and regenerates their canonical forms. Model replies are
constructed; hook snapshots are captured. Skill calls exercise only the
scratch native/injected skills. The MCP result is model-visible. Both outer
`execute` and inner `hooknostic_hooknostic_echo` envelopes are captured; neither
contains an MCP discriminator, so both currently retain `kind: other`.

The namespace ambiguity and exact-native-name guard were probed separately
with `drive.mjs mcp-allow` / `mcp-block`, at the same version/date. See
`.capture/opencode-v2-mcp` for the positive execution control, denied MCP
request, and custom-tool control. Registry evidence is kept in a subdirectory
because these reads are not portable hook envelopes.

## Remaining-capability audit

Same version/date and Windows platform; procedure: `.capture/opencode-v2-audit`.

| Case | Provenance | Observation |
| --- | --- | --- |
| tool-read-error | captured | Typed missing-file error, input and call ID |
| tool-rich-after | captured | Custom tool result with content, structured output and metadata |
| tool-subagent-after | captured | Completed foreground child; result returned to parent model request |
| audits/providers.json | constructed summary of captured callbacks/requests | Anthropic Messages and Responses HTTP context across four routes, including successful compaction |
| audits/oauth-project.json, audits/oauth-package.json | captured HTTP rows + constructed labels and output check | Discovery, dynamic registration, PKCE, refresh after rejected expiry and authenticated execution |
| audits/notifications.json | captured plugin records | Server RPC received by companion TUI, attention disabled under defaults, cleanup on exit; terminal rendering separately asserted in playback |

OAuth tokens and authorization material are synthetic fixture values, not account
credentials. Provider/request summaries are not standalone hook payloads. Their
complete source recordings remain in the scratch roots printed by the driver.

**Turn fields (2.0.18, Windows, 2026-09-28).** `drive.mjs observe` against
`@opencode/cli` 2.0.18, with every state directory isolated as the driver
always does. The plugin's event subscription received
`session.text.ended { sessionID, assistantMessageID, ordinal, text }` before
`session.execution.succeeded { sessionID }`, and each model step had its own
`assistantMessageID` (ADR-0027).

| Fixture | Provenance | Observed boundary |
| --- | --- | --- |
| turn-fields/events.jsonl | captured | One session in capture order: the prompt hook, then its inbox, execution, step and text events from the subscription. Deltas and unrelated events omitted |
| execution-succeeded-with-turn | captured events, constructed enrichment | The captured completion envelope; `.enrichment.json` holds the `execution` the shim hands the decoder beside it (never in `raw`): the prompt hook's `sessionID`/`messageID` and the captured `session.text.ended` data. Canonical `harness.version` is the test's reference build |
