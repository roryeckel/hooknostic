# Claude project MCP environment references

Evidence class: **live-probe**. First tested on Claude Code **2.1.268** on
**2026-09-12**. Re-run on **2.1.278** on **2026-09-21**, which added the
`${NAME:-default}` cases; every earlier observation reproduced. Both runs were
on Windows. The observations are loopback HTTP request effects, not hook
payload fixtures.

## Question

Does Claude project MCP expand `${NAME}` in remote URLs and headers, and is
there a spelling that preserves the exact literal when the named environment
variable is set?

## Method

`probe.test.ts` starts an isolated Streamable HTTP MCP server and the repository's
credential-free Anthropic playback server. It removes model credentials, gives
Claude a dummy key and isolated `CLAUDE_CONFIG_DIR`, then supplies a raw MCP
configuration with set and unset references, set and unset `${NAME:-default}`
references, and percent-encoded, backslash, and doubled-dollar candidates.
Assertions inspect the request URL and `Authorization` header received by the
loopback server.

Reproduce from the repository root:

```powershell
pnpm test -- --config .capture/claude-project-mcp-environment/vitest.config.ts
```

## Observation

- A set `${NAME}` expanded in both the URL path and header.
- An unset `${NAME}` remained literal in both fields (the URL request target
  percent-encoded the braces as normal URL transport behavior).
- `${NAME:-default}` expanded to the value when the name was set and to the
  default when it was not, in both fields.
- A backslash did not suppress expansion; it remained as an extra path separator
  or header character.
- A doubled dollar did not suppress expansion; it remained before the expanded
  value.
- Percent encoding preserved literal URL semantics but also remained percent
  encoded in the header, so it was not a lossless representation across both
  fields.

`observations.json` contains the normalized first request for each case from
the 2.1.278 run. No credential or resolved secret is recorded.

## Consequence

Direct project sources may pass `${NAME}` through for Claude to resolve at
runtime. A package-origin remote server containing a reference cannot keep the
text literal as Agent Plugins requires, and no escape exists. Project delivery
therefore emits the server and reports the `claude:mcp-environment-expansion`
deviation (HN106, ADR-0019). The build fails only under
`components.onDeviation: "error"`. Remote servers without references are
unaffected.
