# pi native MCP

Evidence class: **live-probe** (spawned-child records, loopback HTTP request
headers, declared tool lists, and the extension tee's `tool_call` and
`tool_result` payloads), plus **captured** payloads promoted to
`fixtures/pi/1.3`. Tested pi **1.3.0** on native Windows, **2026-10-19**,
against the scripted loopback model. No model provider was contacted.

## Question

pi 1.x ships a native MCP client (since 0.99.0). Can an Agent Plugins
package or a project's MCP servers be projected into it faithfully, given
that the portable contract expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
in stdio args, env values, and cwd, and nothing in a command, URL, or header?
Which routes does pi read, what does it do with each field, and what do tool
hooks see when the model uses an MCP tool?

## Method

`probe.mjs` runs one disposable pi session per case: a fresh home, agent
directory, and project with a repository boundary; the passive tee from
`.capture/pi`; and the loopback model, scripted to call the probe tool.
`recording-server.mjs` is a constructed stdio MCP server. It records its argv,
cwd, the presence of `PATH`, the environment size, and a watched set of
variables before serving one tool. Its stdio declaration references a set
parent variable as `${NAME}`, as `$NAME`, escaped as `$${NAME}` and `$!`, and
as a literal, and puts `${…}`, `$NAME`, `~/`, and `${PLUGIN_ROOT}` in its
args. The HTTP case serves a loopback streamable-HTTP endpoint that records
each request's headers.

| Case | Route |
|---|---|
| `extension-direct` | `pi.registerMcpServer` from a `-e` extension, `exposure: "direct"` |
| `extension-unset-env` | the same, with one env value naming an unset variable |
| `extension-default-exposure` | the same registration with pi's default exposure |
| `codemode-nested` | default exposure; the model calls `codemode` with a script that calls the tool |
| `project-file-trusted` | the declaration in `.pi/mcp.json`, project trusted with `--approve` |
| `project-file-untrusted` | the same file without `--approve` |
| `package-register` | a local pi package whose manifest extension registers the server, installed with `pi install -l --approve` |
| `sse-rejected` | `pi.registerMcpServer` with `type: "sse"`, recording what the call did |
| `http-headers` | a streamable-HTTP registration with `${NAME}`, `$!…`, and `${NAME}` header values |

Reproduce from the repository root, after `pnpm run bundle`, with
`HKN_PI_BINARY` naming the build:

```sh
node --experimental-strip-types .capture/pi-mcp/probe.mjs
node --experimental-strip-types .capture/pi-mcp/promote.mjs
node --experimental-strip-types .capture/pi/make-canonical.mjs
```

Raw results stay in ignored `captured/<platform>/`.

## Observations

- **Routes.** An extension's `pi.registerMcpServer`, a pi package's manifest
  extension, and a trusted project's `.pi/mcp.json` each started the server.
  The untrusted project's `.pi/mcp.json` was not read: no spawn and no tool.
- **stdio args** reached the child literally (`${NAME}`, `$NAME`, and
  `${PLUGIN_ROOT}/arg` unchanged), except that a leading `~/` became the home
  directory.
- **stdio env** was merged over the full parent environment: the child saw
  `PATH`, a parent-only variable, and about 126 variables. `${NAME}` and `$NAME`
  resolved from the parent, `$${NAME}` arrived as `${NAME}`, and `$!x` as `!x`.
  pi's source runs a value beginning with `!` as a shell command.
- **An unset reference** in an env value silently kept the server from
  starting in print mode: no spawn, no tool, nothing on stderr.
- **cwd**: an explicit absolute `cwd` was honoured.
- **HTTP headers**: `Bearer $${NAME}` arrived as `Bearer ${NAME}`, `$!x` as
  `!x`, and `${NAME}` was resolved. pi passes the URL through unchanged.
- **Exposure.** With `exposure: "direct"`, the tool was declared to the model
  as `mcp__probe__probe_echo`, and the first prompt waited for the server.
  With pi's default (`codemode`), only `codemode` was declared; the server
  still started.
- **Tool hooks.** A direct call reached `tool_call` as
  `{toolName: "mcp__probe__probe_echo", toolCallId, input}`, and `tool_result`
  added `details: {server, tool}` and `structuredContent`. A codemode script's
  call reached both events as a nested call: `toolCallId` `<parent>/1` and
  `parentToolCallId` naming the codemode call, which itself reached the hooks
  as `codemode` with `{code}`.
- **SSE**: `pi.registerMcpServer` threw "legacy SSE transport is not
  supported; use the streamable HTTP URL", and nothing connected.

## Consequences

- The projection registers servers from a generated pi extension rather than
  writing `.pi/mcp.json`, so a project's own file stays the user's. Project
  delivery declares `.pi/mcp.json` `mcpServers.<name>` absent under any
  key that differs from it only in `-` and `_`, because a file server takes
  precedence over a registered one whose name pi treats as the same. pi 1.3.0's
  `docs/mcp.md` gives the user-level `~/.pi/agent/mcp.json` the same
  precedence; that file is outside the project, so no sync can check it, and
  the component rationales say so.
- A stdio server is registered as pi's own Node running the shared launcher
  with an index, anchored on the plugin root. pi never sees the package's
  command, args, or env, so its `~/`, `$NAME`, and `!command` expansion
  cannot reach portable text. The launcher binds `PLUGIN_ROOT` and a
  Hooknostic-managed `PLUGIN_DATA`, which makes the stdio cell emulated.
- A streamable-HTTP server keeps its URL, and each header value is escaped
  (`$` → `$$`, a leading `!` → `$!`), so pi sends exactly the declared text.
  pi 1.3.0's `resolveHeadersOrThrow` copies headers into a plain object, so a
  header named `__proto__` is lost; playback showed it never reached the
  server. Header names are case-insensitive, so that one is registered under a
  spelling differing only in case, which arrives.
  A direct project source resolves its own `${NAME}` and `${NAME:-default}`
  first, as on the other targets; a missing variable registers the server
  disabled, with a warning.
- SSE stays unsupported. A registration that throws is caught, so a
  refused server does not stop the others. A server name outside
  `[A-Za-z0-9_-]`, or one that differs from an earlier name only in `-` and
  `_`, is omitted, because pi would reject it; the omission goes through
  `components.onUnsupported` like any other.
- pi's default exposure is kept: the tools are reached through codemode, whose
  nested calls still reach `tool.before` and `tool.after`.
- A tool named `mcp__…` classifies as an `mcp` tool. Its name is lossy:
  pi 1.3.0's `createMcpToolName` replaces every non-identifier character with
  `_` and hashes a name that is too long or collides, so `get__secret` on
  `probe` and `secret` on `probe__get` share a name. The server/tool split is
  therefore never parsed from the name. `tool_result.details` names both as pi
  registered them. The decoder hands that over as a reported fact, so
  `tool.after` and `tool.error` carry `tool.mcp`, and `classifyTool` rebuilds the
  same view (ADR-0023, ADR-0032). `tool_call` states nothing, so `tool.before`
  carries `kind: "mcp"` without the split (`fixtures/pi/1.3/tool-*-mcp*`). The
  adapter declares the statement for `>=1 <2` only.
- Model-free playback drives all of this on the reference build: package
  installation by local path and by npm coordinate, repository-local
  integration, and the fixture MCP tool through a project `.pi/mcp.json`.

## Not established

- Whether a `.pi/mcp.json` entry holding only `exposure` overrides a
  registered server's exposure. The documentation describes such overrides
  for user-level servers only.
- Interactive and RPC modes. Only print mode was observed.
- OAuth, `auth.provider`, resources, and `toolExposure`.
- macOS and Linux. Playback on the scheduled Linux lane will exercise the
  projected routes there.
