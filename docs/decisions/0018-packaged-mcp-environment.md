# ADR-0018: A packaged MCP server's environment is declared in build config

## Status

Accepted, 2026-09-21.

## Context

A packaged MCP server may need an ambient value the user has already set —
an API key, a user id, a tuning variable. On Claude and OpenCode it gets one:
both start the server with the environment they were launched with. Codex does
not. It starts a stdio child with a fixed platform allowlist and nothing else,
and a variable reaches the child only by being named in that server's
`env_vars` (`.capture/codex-plugin-mcp-environment`). The same plugin's command
hooks inherit the environment whole, so without something, a plugin's two
halves see different environments and only one of them works.

The obvious move is to let the package ask, by writing `${NAME}` in its
`mcp.json` `env` and expanding it. That is exactly what the standard forbids.
Agent Plugins 1.0 defines two placeholders and states that "unrecognized
placeholder-like text MUST remain literal. Clients MUST NOT perform any other
placeholder or environment-variable expansion." ADR-0011 records removing a
projection that expanded host variables anyway: a package could name any host
variable and have its value sent wherever the package chose.

So the question is not how to expand a reference. It is where a *request* to
forward a name may be stated at all, given that the package format has no way
to state one.

## Decision

The request lives in `components.mcpEnvironment` in `hooknostic.config.ts`,
keyed by MCP server name, holding variable **names** only. Hooknostic reads no
value and embeds none in an artifact. A projector whose harness already passes
its environment through ignores the declaration; the Codex projector renders it
as that server's `env_vars`, which is Codex's own documented field.

Rejected alternatives:

- **Expanding `${NAME}` for packages.** Violates the MUST above and reinstates
  the defect ADR-0011 removed. It also fails on its own terms: the launcher
  refuses to start when a reference is unset, so a plugin that degrades
  gracefully on a missing credential would instead not start at all.
- **`extensions["com.openai"]`.** A namespace names whoever consumes the
  object, and Codex consumes this one natively. `env_vars` is OpenAI's field,
  but Codex's plugin manifest takes `mcpServers` as a path string, so the
  nesting would be ours; the projector would have to interpret and strip a key
  Codex never reads, while the namespace advertised native consumption. Per
  `docs/adding-an-adapter.md`, that also reports a client-extension component
  the projector cannot faithfully deliver.
- **Adding a field to `mcp.json`.** The right long-term home — a package
  genuinely cannot express "I need a credential" — but the loader would accept
  a field no published schema defines, and packages built here would stop being
  portable-conformant. That is a change to the standard, not to this project,
  and it is not made by one repository deciding to accept an extra key.

## Consequences

- The declaration is build input, not payload. It does not travel with a
  package consumed by some other Agent Plugins client, which is the honest
  price of not forking the format. If the standard later gains a field, this
  becomes a compatibility shim rather than a fork to unwind.
- Only Codex renders anything today. A harness that starts changing this is a
  capture and a projector change, not a change to what packages declare.
- A name matching no declared server forwards nothing, and forwarding that
  silently stops looks exactly like a credential the user forgot to set, so the
  build reports it as `HN105` rather than passing it through.
- Package sources only. A direct MCP source resolves `${NAME}` from the launch
  environment already and states what it needs in the declaration itself, so
  the schema refuses the key there rather than accepting one that does nothing.
