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

## Additional context option (Linux, 2.0.22, 2026-10-04)

| Fixture | Provenance | Observed boundary |
| --- | --- | --- |
| context-max-tokens | captured | The `context` callback contains numeric `event.options.maxTokens`, observed as `4096` in both context callbacks of the session |

Promoted during the owner-requested review in [issue #82](https://github.com/roryeckel/hooknostic/issues/82)
from [harness-watch run 37241402964](https://github.com/roryeckel/hooknostic/actions/runs/37241402964),
artifact `drift-verdict-opencode-v2`, `captured-opencode-v2/events.jsonl`.
The Linux runner drove `@opencode/cli` 2.0.22 inside `node:24.21.0-bookworm`,
with isolated state and the scripted loopback model (`dry_run=true`,
`force_llm=false`). The model replies and shell argument values were scripted;
the callback envelope is native harness output.

The input is the first complete `context` JSON snapshot, selected without
projecting or deleting fields. Its container paths contain no capturing account,
so no redaction was needed. The original JSONL file's SHA-256 is
`33fe769a9861e588c1d432ca5f8c6d0acf06f2339a737a1264b3c7add6d83f4e`.
The canonical file comes from `decodeOpenCodeV2` minus `raw`; as in the existing
fixture replay suite, its injected `harness.version` is the adapter's reference
build, not the capture version above.

The older `context` fixture remains intact. Both observed shapes are accepted;
wrong types and unseen options still report drift. The complete saved session
changed from advisory drift to clean after adding this variant. This establishes
the field's presence in this configuration, not when it was introduced or its
behavior under mutation. No capability, range, reference version, or rolling
playback record changes.
