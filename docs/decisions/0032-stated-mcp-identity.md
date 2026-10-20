# ADR-0032: An MCP tool's server and tool may come from what the harness states

## Status

Accepted, 2026-10-19. Extends ADR-0023 (dispatch builds a test event's tool
view from `classifyTool`) and follows ADR-0029's pattern for a stated shell
dialect.

## Context

`tool.mcp` carries an MCP tool's server and tool "when the harness exposes the
split". Claude and Codex expose it through the tool name, `mcp__<server>__<tool>`,
and their classifiers parse it.

pi 1.x uses the same spelling, but its name is lossy. 1.3.0's
`createMcpToolName` replaces every non-identifier character with `_`, and
truncates and hashes a name that is too long or that collides
(`.capture/pi-mcp`). So `get__secret` on server `probe` and `secret` on server
`probe__get` produce the same name. Parsing it hands a server-scoped guard the
wrong identity, and the error is in the dangerous direction: a guard that
blocks one server's tool misses the call.

pi does state the identity outside the name, but on the result only:
`tool_result.details` is `{server, tool}` as pi registered them
(`fixtures/pi/1.3/tool-result-mcp`), including for a server's error result
(`tool-result-mcp-error`). A JSON-RPC failure arrives with empty `details`
(`tool-result-mcp-rpc-error`), and `tool_call` carries nothing.

ADR-0023 requires `classifyTool(nativeName, input)` to rebuild the decoder's
tool view exactly, because `hooknostic dispatch` builds a test event's view
from it and the contract suite holds it to every fixture. A decoder that took
the split from `details` would break that rule.

## Decision

1. **The identity is a reported fact.** `ReportedToolFacts.mcp` is
   `{server, tool}`, as the harness stated it. The decoder hands it to the
   classifier, as it does a stated dialect, so `classifyTool(name, input,
   reported)` rebuilds the same view.
2. **A lossy name yields no split.** pi's classifier marks any `mcp__…` tool
   `kind: "mcp"` and sets `tool.mcp` only from a reported fact. A call with
   none keeps the split absent, which is the documented signal to fall back to
   `nativeName` and `raw`.
3. **Classification follows the target's version line.** pi 0.84 has no native
   MCP channel, so an `mcp__` tool there is another extension's, and nothing
   establishes it as an MCP call. `classifyTool` takes the target's range
   (absent: the reference build), and pi's shim learns at build time whether
   its target is within `>=1 <2` through `ShimEntryOptions.targetRange`.
   Outside it, both keep an `mcp__` tool `other` and apply no stated split,
   so the shim never puts semver into an artifact and dispatch still builds
   what the shim decodes.
4. **The adapter declares the source.** `mcpIdentity` is `name`, `statement`
   (with the events that carry it, and the version range whose evidence
   establishes it) or `none`, with a rationale and evidence, like
   `shellDialect`. pi declares `statement` on `tool.after` and `tool.error` for
   `>=1 <2`. A pi `>=0.84 <1` target has no native MCP channel, so it states
   nothing. `inspect`, dispatch, and the contract suite ask core's
   `statedMcpEvents` whether a declaration holds for a range, so they cannot
   disagree. `inspect` prints the declaration for the requested range, and the
   generated support page lists it. An adapter that declares nothing leaves the
   split to its classifier.
5. **The contract suite holds fixtures to it.** It hands a fixture's split
   back as a reported fact only on a declared event. A `statement` source
   needs a fixture that carries the split on one of those events, and no
   fixture may carry one on any other event.
6. **`hooknostic dispatch` accepts a stated identity only where the harness
   states one.** A test's `tool.mcp` may be `{server, tool}`, both strings, on
   a declared event, for a target range within the declared one, and the
   classifier must apply it. Anywhere else it is derived and refused, with a
   hint naming the events that carry it, or the range it is stated for when
   the target's range is not within it. A test therefore cannot hand a pi
   `tool.before` hook, or a pi 0.84 hook, an identity pi never gives.

## Consequences

- On pi, a guard on `tool.before` sees an MCP call as `kind: "mcp"` with
  `nativeName`, but without a server or tool. A guard that needs the server
  matches on `nativeName` or reads `raw`, and must accept that pi's name may be
  ambiguous. `tool.after` and a server-reported `tool.error` carry the exact
  identity; a `tool.error` from a JSON-RPC failure does not.
- No capability or field rating: whether a call carries the split depends on
  the call (ADR-0026 decision 7, ADR-0029 decision 10).
- The shim does not see the running harness version, so it follows the
  target's range, settled at build time (decision 3). A `>=0.84 <2` target is
  not within the 1.x line, so its artifact treats `mcp__` tools as `other`
  even when the harness running it is 1.x: the conservative reading, and the
  one inspect and dispatch report.
- If a harness later states the identity on the call, through a captured
  channel, the adapter adds that event to its declaration; nothing else
  changes.
