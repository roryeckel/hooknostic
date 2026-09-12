# Claude project MCP environment references

Evidence class: **live-probe**. Tested Claude Code **2.1.268** on
**2026-09-12**, on Windows. The observations are loopback HTTP request effects,
not hook payload fixtures.

## Question

Does Claude project MCP expand `${NAME}` in remote URLs and headers, and is
there a spelling that preserves the exact literal when the named environment
variable is set?

## Method

`probe.test.ts` starts an isolated Streamable HTTP MCP server and the repository's
credential-free Anthropic playback server. It removes model credentials, gives
Claude a dummy key and isolated `CLAUDE_CONFIG_DIR`, then supplies a raw MCP
configuration with set and unset references plus percent-encoded, backslash,
and doubled-dollar candidates. Assertions inspect the request URL and
`Authorization` header received by the loopback server.

Reproduce from the repository root:

```powershell
pnpm test -- --config .capture/claude-project-mcp-environment/vitest.config.ts
```

## Observation

- A set `${NAME}` expanded in both the URL path and header.
- An unset `${NAME}` remained literal in both fields (the URL request target
  percent-encoded the braces as normal URL transport behavior).
- A backslash did not suppress expansion; it remained as an extra path separator
  or header character.
- A doubled dollar did not suppress expansion; it remained before the expanded
  value.
- Percent encoding preserved literal URL semantics but also remained percent
  encoded in the header, so it was not a lossless representation across both
  fields.

`observations.json` contains the normalized first request for each case. No
credential or resolved secret is recorded.

## Consequence

Direct project sources may pass `${NAME}` through for Claude to resolve at
runtime. Package-origin remote servers containing a reference cannot preserve
Agent Plugin's literal semantics when that name exists in the ambient
environment, so project delivery omits the affected server and reports HN205.
Remote servers without references remain exact.
