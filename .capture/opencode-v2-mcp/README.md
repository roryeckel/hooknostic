# OpenCode v2 MCP identity and blocking

## Question

Can the adapter distinguish MCP tools from custom tools using public v2
metadata, and can a portable guard stop an inner Code Mode MCP call?

## Evidence

Windows, `@opencode/cli` 2.0.17, 2026-09-26. Captured with the existing private
server driver and loopback scripted model. No paid model or publication.

From the repository root, after `pnpm run bundle`:

```
node --experimental-strip-types .capture/opencode-v2/drive.mjs mcp-allow
node --experimental-strip-types .capture/opencode-v2/drive.mjs mcp-block
```

Each run prints its scratch root. The capture plugin registers the repository's
stdio MCP fixture as server `hooknostic`, and a custom `custom_echo` tool in
the same namespace. It waits for the MCP catalog before admitting the prompt.
The model calls both through Code Mode. The generated plugin uses `guard.ts`:
the ordinary portable SDK, exact `nativeName` matching, and `block()`.

The server records actual incoming `tools/call` requests in `mcp-calls.jsonl`.
The portable guard records its invocations in `guard.jsonl`. Model requests,
hook envelopes, and registry snapshots are retained under the scratch root.

## Findings

| Probe | Result |
| --- | --- |
| MCP registry | Server `hooknostic` is connected |
| Tool registry | Both tools have `options.namespace: hooknostic`, `codemode: true`, name, input/output schemas and effective ID |
| Ownership | No MCP discriminator is present in either captured hook envelope or JSON-serializable tool registry snapshot |
| Allowed control | Guard sees the inner MCP tool once; server receives one `tools/call`; model receives its output |
| Denied run | Guard sees the same inner tool once; server receives no `tools/call`; model receives `hooknostic-mcp-denied` |
| Custom-tool control | `hooknostic_custom_echo` completes and returns its output in both runs; the guard does not match it |

Registry snapshots omit executable functions when serialized. They establish
the public data fields, not function identity or undocumented internals. The
installed plugin/schema declarations were also inspected; they expose tool
name, schemas, options and executor, but no ownership tag. The
[upstream tool-domain documentation](https://opencode.ai/v2/docs/build/plugins/#tools)
was probe guidance; the live records establish the observations above.

Connecting the namespace to `ctx.mcp.list()` is insufficient: this experiment
deliberately puts a custom tool into that connected server's namespace. Splitting
underscores is also insufficient. Both tools therefore remain `kind: other`.
Automatic MCP identity normalization is still unsupported. This probe does
not establish `match: { kind: "mcp" }`; it establishes the explicit native-name
fallback without changing the portable vocabulary or raw events.

An initial run called MCP before its catalog became available. Both nominal
allow/block runs returned an unknown-tool error and no server calls. That is
not denial evidence. The readiness wait and required successful control make
the final test discriminate this failure from actual blocking.

## Committed evidence and regressions

`fixtures/opencode/2.0/mcp-identity/` contains redacted, captured registry JSON.
`tool-custom-namespace-{before,after}` contain the custom tool's captured hook
envelopes and canonical decode results. `promote.mjs <allowed-scratch-root>`
performs the usual account-path redaction and regenerates these files. The
existing `tool-mcp-inner-*` fixtures establish the MCP envelope independently.

The v2 adapter suite rejects namespace-based inference. The v2 playback lane
drives both allow and deny controls through the generated production shim.
Mutation checks `mcp-namespace`, `mcp-block`, and `mcp-match` respectively add
an underscore heuristic, remove denial, and remove the exact matcher. Each
must fail its regression. Run them with `.capture/opencode-v2/verify-mutations.mjs`
after bundling. Originals are restored byte-for-byte.

To implement automatic normalization, we still need authoritative MCP origin,
server ID and original tool name tied to the executed tool snapshot. A current
registry lookup alone must not turn a custom or replaced tool into an MCP tool.
