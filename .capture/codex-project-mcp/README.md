# Codex project MCP investigation

Evidence class: **live-probe**. Measured Codex CLI **0.153.2**, native Windows,
2026-09-11. The initial probes established native semantics; the follow-up below validates
the generated project integration.

## Questions and method

Can trusted repository configuration discover and start MCP servers without a
plugin? What are the trust, layering, path, transport, and diagnostic boundaries?

Run from the source checkout with Node and the installed Codex CLI on PATH:

```sh
node .capture/codex-project-mcp/probe.mjs
node .capture/codex-project-mcp/startup.mjs
```

Both scripts create disposable synthetic repositories and isolated CODEX_HOME
settings under a directory containing spaces, remove credential environment
variables, and remove their scratch directories afterwards. No personal trust or
installation settings are changed. `observations.json` records configuration
readback; `startup-observations.json` records child-process markers and loopback
requests. Temporary paths are redacted.

The startup probe configures a synthetic model provider pointing exclusively to
its loopback HTTP listener. That listener deliberately returns HTTP 503 for model
requests, after MCP initialization. Codex's session exits 1 as expected; this is
not a successful model conversation. MCP process startup and HTTP initialize /
tools/list exchanges are measured before that failure. No paid model is called.
Codex may still make its own unauthenticated background catalog requests; this
probe is not a claim that the harness performs no other network traffic.

## Observations

- Missing trust and explicit untrusted state exclude the project servers. Trusted
  state discovers `.codex/config.toml` servers without a plugin manifest.
- Invocation from a nested directory discovers the parent repository config.
  A nested `.codex/config.toml` overrides matching parent fields.
- Same-named server definitions merge across layers: a project command replaces
  the home command but inherits home args and environment entries. A server name
  is not an isolated, whole-object override.
- Both omitted `cwd` and `cwd = "."` start the stdio child in the nested invocation
  directory. Neither anchors it to the project or configuration directory.
- `${SYNTHETIC_VALUE}` remains literal in declared arguments and environment values
  at actual startup. `env_vars = ["SYNTHETIC_VALUE"]` forwards the variable value.
  Without that listing the same variable, set in Codex's own environment, does not
  reach the stdio child (`undeclaredEnvVar`), so the project projector lists every
  variable its launcher expands in `env_vars`.
- Streamable HTTP reaches initialize, notifications/initialized, and tools/list.
  `env_http_headers` reads a synthetic environment variable at runtime and sends
  the resulting header. The reference is not expanded during generation.
- `type = "sse"` is accepted in TOML but read back as streamable_http. This does
  not establish legacy SSE support; no legacy SSE session was exercised.
- `codex mcp list --json` does not start the stdio fixture, but does send HTTP GET
  requests to the MCP URL and an OAuth protected-resource discovery URL, including
  the configured synthetic header. It is unsuitable for a no-server-contact doctor.

The discovery script deliberately uses nonexistent commands: its output proves
configuration discovery only. The startup script uses an absolute fixture path
to isolate cwd behavior; that absolute path is not a proposed portable artifact.

## Implementation design

1. Add format-aware structural TOML edits to the existing ownership engine.
   Own the semantic subtree `mcp_servers.<name>`, including nested env/header
   tables, and hash canonical values. Preserve unrelated tables, comments, and
   formatting. Handle quoted keys, dotted keys, inline tables, and tables split
   across multiple declarations. Reject malformed or ambiguous documents. Reuse
   current byte-level transaction, recovery, containment, and precondition checks.
2. Have the Codex adapter translate project MCP to these entries. Share reusable
   transport translation with the package projector, without a synthetic package
   manifest. Reject unowned local name collisions even when values look equivalent.
3. For stdio, reuse the project launcher for source-relative paths and runtime
   environment handling. Add a small inline Node bootstrap that locates the owned
   project integration from the invocation directory and imports its launcher.
   Validate configuration identity and target before selecting a root, handle
   nested projects and worktrees explicitly, and fail closed when no matching root
   exists. The generated bootstrap is validated by the follow-up below.
4. Project streamable HTTP natively, preserving header environment references.
   Keep legacy SSE unsupported unless a separate evidenced translation is added.
5. Keep generation independent of installed versions and personal configuration.
   Doctor should inspect configuration files without native MCP list/get calls;
   report trust prerequisites and known same-name layer interactions without
   changing them. Dynamic overrides or unread layers must remain uncertainty.
6. Add reconciliation regression and focused mutant coverage for TOML preservation,
   server-name collisions, edits/removal, drift, and recovery. Add complete
   credential-free playback for the generated bootstrap, nested invocation,
   worktrees, paths with spaces, and environment references before promotion.

## Generated integration follow-up

The installed Codex loopback playback now includes project stdio and Streamable
HTTP declarations alongside the synthetic skill and hooks. It passes using the
production projector, TOML reconciliation, ownership manifest, generated inline
bootstrap, and portable launcher. No plugin is installed. The stdio marker proves
the declared source-root cwd and PLUGIN_ROOT/PLUGIN_DATA values; the HTTP fixture
records protocol initialization. The model sees the skill, and the hook marker
proves execution. Run:

```sh
HOOKNOSTIC_PLAYBACK=codex HOOKNOSTIC_PLAYBACK_VERSION=0.153.2 pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Constructed regression tests cover nested invocation, linked Git worktrees,
quoted/dotted/inline/nested TOML definitions, comment preservation, edited or
missing output, collisions, target removal, and source-relative runtime paths.
The worktree test enables Git automatic line-ending conversion: owned
`.gitattributes` files preserve exact generated MCP bytes and their hashes.
Mutation records are beside these notes.

## Limits

Native harness playback was measured on Windows at Codex 0.153.2. POSIX native
harness behavior and legacy SSE remain unestablished by this capture. Codex's
same-name cross-layer merging remains an activation prerequisite to review;
Hooknostic owns project entries and does not edit personal configuration.
Streamable HTTP header text is preserved through the existing native translator;
the portable schema does not add a new environment-header declaration syntax.
The `bearer_token_env_var` mapping is **doc-derived**, not live-probed: the
official documentation defines it as the environment variable whose token is
sent in the `Authorization` header. This capture did not configure a nonempty
bearer variable or observe that header.

Official documentation independently describes trusted project MCP configuration:
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
