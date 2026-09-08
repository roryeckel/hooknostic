# Decision 0011 — Project Agent Plugins into native plugins

**Status:** Accepted — 2026-09-04 · Supersedes [ADR-0004](0004-agent-plugins-relationship.md)

**In short:** Agent Plugins remains a peer standard and the portable source of truth.
Hooknostic may now compile a validated Agent Plugins 1.0 package into a complete
harness-native plugin, independently of whether the package also contains Hooknostic
hooks. Projection never mutates the source package.

## Context

Agent Plugins 1.0 standardizes manifests, Agent Skills, MCP servers, and namespaced
client extensions. Codex consumes that package model natively. Claude Code and OpenCode
have their own plugin surfaces, so authors otherwise need to maintain parallel package
trees even when the underlying components are representable.

ADR-0004 limited Hooknostic to adding hook artifacts under a client-extension directory
inside the portable package. That kept the package conforming, but it did not solve the
inverse problem: producing an installable native plugin from the portable package, and
it required a source-side generated tree.

## Decision

- `@hooknostic/agent-plugin` owns offline Agent Plugins 1.0 loading, validation, secure
  file inventory, and target-neutral projection contracts.
- A harness adapter may expose a versioned `agentPluginProjector`. Component support is
  reported with the same exact/emulated/approximate/unsupported vocabulary used for
  hooks, but component IDs are a separate public vocabulary.
- `hooknostic build` composes package files, target-specific overlay files, native
  metadata, and optional compiled hook artifacts into one staged target output. The
  existing transaction commits all selected targets or none.
- `entry` is optional when `agentPlugin` is present. A hookless build performs no runtime
  bundle. Projection targets are explicit and default to failing on an unrepresentable
  valid component; `onUnsupported: "warn"` records precise omissions instead.
- The Agent Plugin root is read-only input. Configured outputs and transaction paths are
  excluded from inventory, and the old source-side namespaced output is removed. A
  non-excluded symbolic link that escapes the package rejects the whole package before
  component contents are parsed; this deliberately strengthens the standard's narrower
  component failure boundary so projection never reads outside its declared input root.
- Claude Code is the first projector. Codex and OpenCode projection are deferred
  until their plugin APIs have their own capture and adapter work.
  (Codex landed in the 2026-09-08 amendment; OpenCode is still deferred.)

## Consequences

- An Agent Plugin author can produce a Claude Code plugin without authoring any hooks.
- Harness-specific merge and transport rules remain in adapters; core coordinates
  validation, reporting, and atomicity only.
- The public projection interface can accommodate another versioned projector without a
  core redesign.
- Hooknostic remains a compiler. It does not install plugins, manage marketplaces, run
  MCP servers, or become an Agent Skills authoring framework.

## Amendments — 2026-09-06

Hardening after external review of the first projection release. None of these change
the boundary above; they close gaps between what the build reported and what it did.

- **A projection target without a projector is an error.** `onUnsupported` degrades
  individual components. It never applied to a whole projection, and a `"warn"` policy
  on a projector-less target used to commit an empty (or hook-only) output while
  reporting the target built. Core also refuses any projector plan with zero files.
- **Inventory is deny-listed by default.** The loader always omits `.git`,
  `node_modules`, `.env`, `.env.*`, and `.npmrc` at any depth; core omits the config
  file and hook `entry` alongside the outputs and transaction paths it already omitted.
  A deny-list was chosen over an `include` allow-list because authors — human or agent —
  forget to extend allow-lists when adding a skill or a server script, and a silently
  incomplete package is worse than an over-inclusive one. The build report lists every
  inventoried path (`agentPlugin.sourceFiles`).
- **Skipped components fail the build by default.** The loader keeps the specification's
  lenient skip-and-continue for library consumers; the build maps those skips to errors
  unless `agentPlugin.onInvalid: "warn"`. The shipped JSON schemas are the
  specification's own and are not tightened; the loader's stricter rules are documented
  instead.
- **`check` runs the whole pipeline.** Bundling, projection, overlay merging, and
  artifact validation all run in memory under `check`; only staging and the commit are
  skipped. Projector-time failures were previously reachable only from `build`; a write
  the target filesystem itself refuses (path length, reserved names) still is.
- **The runtime package pair is validated as `npm ci` would validate it** (see
  [ADR-0012](0012-claude-plugin-runtime-dependencies.md)): npm lockfile v2/v3 only,
  root dependencies equal to the manifest, every dependency locked at a satisfying
  version and resolution, the transitive graph complete. The validator lives in
  `@hooknostic/agent-plugin` so a future projector can reuse it.
- **`defineConfig` is generic** over the configured target names, so
  `agentPlugin.targets` and the entry-or-agentPlugin requirement are checked by the
  editor as well as by the schema.

## Amendments — 2026-09-07

- **A projector's own output paths are reserved against the package root.** The
  boundary above is stated as input safety; this is its output half. The Claude
  projector copies the portable base tree into the same keyed set it later reads
  its native overlay from, so a package-root `.mcp.json`, `hooks/hooks.json`, or
  `.claude-plugin/` file became that overlay — its MCP servers reaching Claude's
  configuration without the validation `mcp.json` servers receive, its hook
  entries running ahead of the Hooknostic dispatcher. Such a file is now a fatal
  HN503 naming the path and the `com.anthropic.claude-code/` prefix that would
  declare it as a client extension. Fatal rather than `onUnsupported`-governed:
  the package is claiming the projector's output, which is not a valid component
  the harness cannot represent, so the policy for degrading components does not
  apply. The whole `.claude-plugin/` directory is reserved, not just
  `plugin.json`, because Claude reads its own metadata from that directory. The
  comparison case-folds, like the npm manifest rule it parallels.
- **A projection plan reports which files it copied, not how many.**
  `summary.copiedPaths` replaces `copiedFileCount`, which the build report still
  derives from its length. Core needs the split — its report distinguishes
  generated artifacts from copied package content — and it had been getting it
  from a hardcoded list of Claude's own paths, the one piece of harness layout
  knowledge left in core after this ADR moved the rest into adapters. Every
  projector already knows the answer exactly; now it says so.

## Amendments — 2026-09-08

Codex becomes the second projection target, and it is the first that consumes the
specification directly.

- **A harness may need no projection at all.** Probing `codex-cli` 0.153.2
  (`.capture/codex-agent-plugin`) established that a package whose only manifest is a
  root `plugin.json` installs through `codex plugin add`, its `skills/` tree is
  discovered, and its `mcp.json` servers register with `PLUGIN_ROOT`/`PLUGIN_DATA`
  bound. None of the translation the Claude projector performs has a counterpart.
  Rather than making native conformance an untracked special case outside the projector
  slot, `@hooknostic/agent-plugin` gained `createNativeAgentPluginProjector`: an
  identity projection whose value is the *filtered* package, since Codex's installer
  copies the plugin source directory wholesale and has no exclusion mechanism. The
  capability table, the build report and `inspect` then cover this target like any other.
- **Hook delivery is a property of the projector, not the target id.** A projector
  declares `deliversHooks`. When it is true the plan carries the compiled hook
  artifacts and the package shares the target's `output` (Claude). When false the
  harness installs a package but loads hooks from elsewhere (Codex reads the repository
  `.codex/` directory), so the package is written to a separate `packageOutput` and
  `output` keeps the hook artifacts. Folding them together would ship the hook artifact
  inside the install cache: unreadable there, and beyond `agentPlugin.exclude`, which
  filters source files rather than generated ones. The pairing is required rather than
  defaulted — HN204 both ways — so the split is visible in the config instead of
  inferred from an adapter's internals. `packageOutput` is a managed output like
  `output`: sandboxed, overlap-checked, and excluded from the package inventory (a
  `root: "."` package whose destination is not excluded copies the previous build into
  the next one and nests a level deeper every run).
- **An unsupported component is reported, not filtered.** Codex ignores an `sse`
  server and drops a `streamable-http` server's literal headers. Filtering either out
  would mean re-serializing `mcp.json`, forfeiting both the byte-identical guarantee a
  native projection rests on and forward compatibility — the component would fail to
  reappear when the harness gains support, absent a rebuild. The summary counts it as
  `skipped` with an omission instead, because the report answers what the harness will
  act on rather than which bytes are on disk. Making that possible, the projection
  context now carries `support`: this projector's own profiles, already resolved
  against the target range by core. Supplied rather than re-derived, so a projector
  cannot disagree with the matrix the build reports and `onUnsupported` acts on.

## Amendments — 2026-09-08 (second)

The Codex projection is rewritten as a translation. The previous amendment
described it as an identity pass-through on the grounds that Codex consumes the
specification directly; that is true for skills and MCP and false once hooks are
a requirement.

- **A projector emits the harness's plugin format, not the portable one.** Codex
  does run an installed plugin's hooks — the earlier "the `plugin_hooks` feature
  is removed" reading of the 0.148.0 binary does not hold on 0.153.2 — but only
  from a native `.codex-plugin/plugin.json` `hooks` key, and a valid root
  `plugin.json` outranks that manifest. A package carrying both loads its skills
  and silently ignores every hook, and there is no convention fall-back. So the
  projection now removes the portable manifest and `mcp.json` and writes native
  replacements, exactly as the Claude projection has always done. Neither output
  is a portable package; the *source* is the portable artifact
  (`.capture/codex-plugin-hooks`).
- **`deliversHooks` is `true` for Codex, and `mode: "plugin"` is supported.**
  One installed plugin now carries skills, MCP and hooks together, which is the
  requirement a projection exists to meet. The generated hook command is anchored
  with `${PLUGIN_ROOT}`: inside an install cache a relative command resolves
  against the session cwd and silently finds nothing.
- **A component that would be misread is dropped, not translated.** Codex selects
  an MCP transport from `command` vs `url` and ignores the portable `type`, so an
  `sse` server passed through registers as a `streamable_http` connection to the
  same url. Filtering it is not a loss of fidelity but the avoidance of a
  wrong-protocol connection, and it is the general rule: `unsupported` means the
  component must not reach the harness, not merely that it will be ignored.
  Conversely `streamable-http` improves to `exact` here, because the native
  `http_headers` key preserves a literal header the portable route drops.
- **`createNativeAgentPluginProjector` keeps no shipped user.** It remains
  correct for a harness that consumes the specification and needs no hook
  channel, but no adapter is in that position today, and the belief that Codex
  was is what this amendment corrects.

## Amendments — 2026-09-08 (third)

OpenCode gains a projector, completing the set. A plugin on every harness can now
carry skills, MCP and hooks together, which was the point of projecting a package
at all.

- **A projection is not always an installable unit.** OpenCode reads
  `.opencode/plugins/` from the project directory, so its projection is
  project-scoped by construction and needs no install. It is the only harness
  where that is true: Claude and Codex both install into a user-level cache, and
  Codex's binary carries `repository-scoped plugin migration is not allowed`.
  This is worth stating because the earlier amendments generalised from those two.
- **A projector may have to generate executable glue.** OpenCode has no manifest
  for a project plugin, so the components are contributed by a generated module
  through the `config` hook rather than declared in a file the harness reads.
  Consequences the projection is shaped by, each measured
  (`.capture/opencode-agent-plugin`): every export of a plugin module is loaded as
  a plugin, so package identity survives only as a comment; the module scan is
  flat, so copied content nests safely one level down; and `skills.paths` is
  additive, so an injected path displaces nothing.
- **Deferred substitution is part of the contract.** `${PLUGIN_ROOT}` cannot be
  resolved at build time because the directory is unknown, and `${VAR}` must not
  be, because a committed artifact would then hold a secret. Both are resolved by
  the generated module at load time. Emitting OpenCode's own `{env:VAR}` syntax
  would not work: interpolation runs BEFORE plugin config hooks, so a value a
  plugin injects reaches the server as literal text. The same probe found that a
  `JSON.stringify`/`JSON.parse` round trip corrupts a Windows plugin root, whose
  backslashes are not valid JSON escapes; substitution walks the value instead.
- **`unsupported` still means "must not reach the harness", but the levels differ
  per harness for real reasons.** `sse` is `unsupported` on Codex, which would
  mis-register it as streamable-http, and `emulated` on OpenCode, whose client
  negotiates `[StreamableHTTP, SSE]` and simply connects.
