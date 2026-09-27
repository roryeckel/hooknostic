# ADR-0024: Resolve incompatible harness families before compilation

Status: accepted

## Context

OpenCode v2 ships as `@opencode/cli` and changes plugin loading, callback
envelopes, tool names, MCP configuration and event subscriptions. V1 remains
available as `opencode-ai`. A capability intersection cannot make one v1
artifact executable on v2. Evidence is in `fixtures/opencode/2.0` and
`.capture/opencode-v2`.

## Decision

Keep the public adapter id `opencode`. An optional adapter-owned
`resolveTarget(TargetSpec)` returns a concrete adapter or diagnostics. The
shared resolver runs before capability analysis, generation, projection,
inspection and portable-event dispatch. A selected adapter includes its
decoder, shell codec, shim and component projector; shared code contains no
OpenCode family conditions. Detection never changes compilation.

Each target range must be fully covered by one family. Mixed or uncovered
ranges produce HN203. Authors needing both configure two named targets with
`adapter: "opencode"` and separate output directories. No dual-loader artifact
is promised. Multiple project artifacts can be built into separate output directories;
`project.root` integration still permits only one target per adapter because
both families activate the same native paths. Existing explicit v1 configurations retain their implementation.

The facade recommends v2 for new configurations. Its `harnessFamilies` exposes
both independently maintained metadata records. Historical v1 helper exports
remain available for existing internal callers. Family-specific records,
fixtures and rolling scheduled validation remain separate. Automation selectors
are `opencode-v1` and `opencode-v2`; the historical `opencode` automation selector
remains a v1 alias. Each lane owns its npm coordinate and bootstrap script.

V2 starts with the existing portable vocabulary. Observed channels receive
their actual support level; unsupported or unverified channels remain absent
or explicitly unsupported. Context covers separately captured ordinary,
title, generation and compaction routes. It remains approximate because
callback cadence across HTTP retries and other providers is not established.
One compaction registration dispatches model context followed by compaction
context; both preserve the original callback in raw.

Only permission evaluations whose current effect is `ask` become portable
permission requests. Their action/resources are not tool name/input: the
normalized tool stays unknown/other, with the native fields in raw. Blocking
changes ask to deny before approval admission. This limited coverage is
approximate. Completed, failed and interrupted execution events approximate
turn completion; this includes manual compaction executions and does not
provide native stop prevention. Stop prevention and notification are emulated
by admitting `session.synthetic` messages, only after a succeeded execution of
a session not created with a `parentID`, so an interrupt, a model failure or a
subagent child is never re-prompted. Both are approximate: the execution has
already completed, the text is a user-role message the model reads, and a notice
stays pending until the session next runs.

V2 project discovery walks every ancestor of the session directory and keeps
the outermost copy of a plugin id. Its project modules therefore take a
per-checkout id and serve only sessions whose nearest integration they own,
the rule the Codex command bootstrap already applies. The event subscription
is not location-scoped, so bus-driven dispatch is limited to sessions created
in or prompted through the plugin's own location.

Package/project assembly can share portable file and launcher machinery, but
each family supplies its own native entry and component registration code.
V2 packages compose hook and component setup in one default definition and
register components through domain transforms.

### MCP identity

Do not derive v2 MCP identity from underscore-delimited tool IDs or membership
in a connected server's namespace. Captures in `.capture/opencode-v2-mcp`
show a custom tool sharing that namespace and the same registry field shapes.
The hook envelope has no ownership discriminator. Keep both invocations raw
and classified as `other` until authoritative origin is available for the
executed tool. Exact `nativeName` matching is the verified guard fallback:
the compiled portable hook prevents the server from receiving the MCP call
while allowing the neighboring custom tool. This does not establish portable
`kind: "mcp"` matching on v2.

## Consequences

Both families carry ongoing fixture, contract and offline playback obligations.
V2 does not inherit v1 behavioral evidence or parity. The private-server v2
driver uses scratch state and a loopback model; paid capture remains a separate
owner-requested activity. See [Contributing](../../CONTRIBUTING.md) for scope
and evidence requirements, and [OpenCode families](../opencode-families.md)
for migration guidance.
