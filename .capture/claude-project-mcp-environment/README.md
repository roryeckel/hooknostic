# Claude project MCP environment references

Evidence class: **live-probe**. The remote probe was first run on Claude Code
**2.1.268** on **2026-09-12**, then re-run on **2.1.278** on **2026-09-21** with
the `${NAME:-default}` cases added. Every earlier observation reproduced. The
stdio probe was added on **2.1.278** on **2026-09-21**. All runs were on
Windows. The observations are loopback HTTP request effects and records written
by spawned stdio children, not hook payload fixtures.

## Questions

1. **Remote:** Does Claude project MCP expand `${NAME}` in remote URLs and
   headers? Is there a spelling that keeps the exact literal when the named
   environment variable is set?
2. **Stdio:** What does a projected package's stdio server receive under project
   delivery, compared with the same text in a native declaration? Can a project
   `.mcp.json` name the project, so that it could anchor a package root the way
   `${CLAUDE_PLUGIN_ROOT}` does under package delivery?

## Method

**Remote.** `probe.test.ts` starts an isolated Streamable HTTP MCP server and
the repository's credential-free Anthropic playback server. It removes model
credentials and gives Claude a dummy key and an isolated `CLAUDE_CONFIG_DIR`.
It then supplies a raw MCP configuration with:

- set and unset references;
- set and unset `${NAME:-default}` references;
- percent-encoded, backslash, and doubled-dollar candidates.

Assertions inspect the request URL and `Authorization` header the loopback
server received.

**Stdio.** `stdio.test.ts` runs the production `hooknostic sync` on a synthetic
project that uses one Agent Plugin package. The package's stdio server passes a
set `${NAME}` and an unset `${NAME:-default}` in its args, plus a set `${NAME}`
in its env. Beside the projection, the project's `.mcp.json` holds two native
controls:

- one with the same text;
- one that starts its server through `${CLAUDE_PROJECT_DIR}`.

Every server records its argv, cwd, and selected environment values when it
starts, then completes the MCP handshake. The test pre-approves the three
servers in an isolated `CLAUDE_CONFIG_DIR` and runs `claude mcp list` from the
project root. That health check starts each server. No model is contacted.

Reproduce from the repository root:

```powershell
pnpm run bundle
pnpm exec vitest run --config .capture/claude-project-mcp-environment/vitest.config.ts
```

## Observations

### Remote

- A set `${NAME}` expanded in both the URL path and the header.
- An unset `${NAME}` remained literal in both fields. The URL request target
  percent-encoded the braces, which is normal URL transport behavior.
- `${NAME:-default}` became the value when the name was set, and the default
  when it was not, in both fields.
- A backslash did not suppress expansion. It stayed in the text as an extra
  path separator or header character.
- A doubled dollar did not suppress expansion. It stayed in the text before the
  expanded value.
- Percent encoding kept the URL's literal meaning, but the header also stayed
  percent-encoded. So it was not a lossless spelling for both fields.

### Stdio

- **Claude saw none of the package's text.** The projection declared
  `node ./.hooknostic/artifacts/claude/mcp-launcher.mjs 0`, and Claude reported
  it connected.
- **The package's references reached the server literally**, in args and env
  alike. The generated launcher bound `PLUGIN_ROOT` and established the package
  root as the working directory.
- **Claude expanded the same text in its own declaration:**
  - the set reference became its value in args and env;
  - the unset `${NAME:-default}` became its default.
- **`${CLAUDE_PROJECT_DIR}` does not expand in `.mcp.json`.** Claude reported
  `Missing environment variables: CLAUDE_PROJECT_DIR`, and that server never
  started.
  - Claude does set `CLAUDE_PROJECT_DIR` in every stdio child's environment.
  - Native servers started in the directory Claude was launched from.

`observations.json` holds the normalized first request for each remote case
from the 2.1.278 run. `stdio-observations.json` holds the projected declaration,
Claude's status lines and configuration warnings, and each child's record. The
project path is normalized to `<project>`. No credential or resolved secret is
recorded.

## Consequences

- **Direct project sources** may pass `${NAME}` through for Claude to resolve at
  runtime.
- **A package's remote server** cannot keep its text literal, as Agent Plugins
  requires, and no escape exists. Project delivery therefore emits the server
  and reports the `claude:mcp-environment-expansion` deviation (HN106,
  ADR-0019). The build fails only under `components.onDeviation: "error"`.
  Remote servers without references are unaffected.
- **A package's stdio server conforms under project delivery**, unlike under
  package delivery, where Claude expands the same text. The difference is a
  consequence of the harness, not a choice:
  - A project `.mcp.json` has no variable that names the project or a package
    root.
  - So the projection cannot hand Claude a declaration whose paths resolve,
    which is how package delivery works through `${CLAUDE_PLUGIN_ROOT}`.
  - The generated launcher has to resolve the package's paths from its own
    location, so it also holds the package's text.
  - Project stdio therefore declares no deviation (ADR-0019, "Delivery routes").

## Not measured

- POSIX behavior. Both probes are Windows-only.
- Launching Claude from a subdirectory. The project guidance already says to
  launch from the project root.
