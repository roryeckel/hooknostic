# OpenCode v2 remaining-capability audit

Windows, `@opencode/cli` 2.0.17, 2026-09-26. Each drive uses fresh scratch
state and a private server. Model responses and OAuth services are constructed
loopback fixtures. Hook payloads and recorded HTTP requests come from the real
harness. No paid model or real credential is involved.

After `pnpm run bundle`, run from the repository root:

```sh
node --experimental-strip-types .capture/opencode-v2/drive.mjs results
node --experimental-strip-types .capture/opencode-v2/drive.mjs notifications
node --experimental-strip-types .capture/opencode-v2/drive.mjs provider-anthropic
node --experimental-strip-types .capture/opencode-v2/drive.mjs provider-responses
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent
node --experimental-strip-types .capture/opencode-v2/drive.mjs project-oauth
node --experimental-strip-types .capture/opencode-v2/drive.mjs package-oauth
```

Use `HKN_OPENCODE_BINARY` for a native executable override. Each command prints
its scratch root. Notifications require `node-pty`; the drive creates a private
terminal, sends Ctrl+C to exit, and kills the child in `finally` if necessary.

## Observations and limits

| Probe | Evidence |
| --- | --- |
| Tool error | Missing-file `read` yields `execute.after`, `status: error`, `_tag: Tool.Error` and a message. Generated hooks dispatch `tool.error` with input and call ID. A plain custom `Error` reaches the model but bypasses this callback; shell nonzero exit remains a completed result. Observation is approximate. |
| Rich output | Text and object replacements reach the next model request; objects become JSON text. Original content, structured `output` and metadata survive in the captured raw event. Structured output/metadata are not replaced, so support stays approximate. |
| Notifications | A companion `./tui` entry receives a server RPC event, renders its sentinel in terminal output and records cleanup on normal exit. Attention returns `attention_disabled` under scratch defaults. A generated user-only notification, OS delivery, remote-client routing and disconnected delivery remain unverified; portable `notify` is emulated with `session.synthetic` (`../opencode-v2`). |
| Providers | Anthropic Messages and OpenAI Responses HTTP each exercise ordinary, title, generation and successful compaction with injected context. Shell markers establish execution. WebSocket, other providers and provider OAuth remain unverified. |
| Subagent | A foreground `general` child returns its sentinel to the parent's recorded request. Session IDs differ. Background completion and deeper nesting are unverified. |
| MCP OAuth | Project and packed relocated package reach `needs_auth`, discover metadata, dynamically register and complete S256 PKCE. The issuer checks the verifier, rejects the expired token and observes a refresh grant. The tool executes with the refreshed bearer. Custom options, real issuers, cancellation and restart persistence remain unverified. |

## Probe corrections

The initial Responses fixture omitted streamed text. Generation returned text,
but compaction failed with `Compaction produced no summary`. Adding the complete
text event sequence made successful compaction observable; playback now requires
the ended event and rejects failed compaction.

The initial OAuth fixture accepted the expired token. That did not establish
refresh. The committed fixture enforces expiry, and playback requires a refresh
grant and refreshed bearer on `tools/call`.

The first RPC probe could not resolve `@opencode/plugin/rpc` from a bare local
package. Inspection of the matching SDK showed `Rpc.define` returns its argument
after checking reserved names. The final probe uses that structural contract and
the harness-resolved TUI import, with no dependency installation. Explicit RPC
method input/output schemas were needed on the tested route.

## Evidence and regressions

`promote-results.mjs <results-root>` preserves reviewed hook payloads.
`promote-audits.mjs` takes six roots: Anthropic, Responses, subagent, project
OAuth, package OAuth, notifications. Redacted records land in
`fixtures/opencode/2.0/audits`, plus the subagent completion fixture.
Provider summaries are constructed from captured requests; OAuth HTTP rows
and notification callbacks are captured. OAuth tokens, codes and verifiers
belong only to the disposable local issuer.

Playback enforces effects; fixtures enforce decoding. Drift comparison separates
typed failures from successful results for the same tool. The named audit
mutants in `verify-mutations.mjs` exercise those assertions. SSE remains
unsupported.

Final check exit codes, test counts and mutation outcomes are in
`validation.json`. Both offline families passed on Windows. Hosted Linux
execution and paid smoke were not run here.
