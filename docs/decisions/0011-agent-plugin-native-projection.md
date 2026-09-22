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

## Amendments — 2026-09-08 (fourth)

`deliversHooks` and `packageOutput` are removed. They were the two halves of one
premise — that a harness might install an Agent Plugins package and load its
hooks from elsewhere — and the second amendment above falsified it for the only
adapter that was ever believed to hold it.

- **A projected package is always the hook channel.** All three shipped
  projectors deliver their own hooks, so the `false` branch had no user, and its
  two HN204 pairing errors had no test. Keeping the option would also not have
  bought back the case it was written for: `deliversHooks` was flat on the
  projector while `profiles` carries the version ranges, so an adapter could not
  have said "false below 0.149, true above it" — the shape a Codex that really
  had lost `plugin_hooks` would need.
- **The declaration is replaced by a check, which is strictly stronger.** Core
  never verified that a `deliversHooks: true` projector actually emitted
  `context.hookArtifacts`; it assigned the plan wholesale. A projector that
  dropped one shipped an installable package that runs no hooks, with a
  non-empty plan, valid paths and an accurate component summary — nothing in the
  build could see it. Core now fails the target with HN301 naming the dropped
  paths. Contents may still be rewritten, which is what lets Claude merge its own
  hooks document into the generated one.
- **Re-adding it later is additive.** `packageOutput` was an optional config
  field and nothing publishes from this repository yet, so the option value of
  keeping an untested branch against a hypothetical harness was smaller than the
  cost of carrying it.

## Amendments — 2026-09-08 (fifth)

`createNativeAgentPluginProjector` is removed, and its discovery logic promoted
to `componentSummary`, which every shipped projector now calls.

- **Identity projection contradicted the rule the second amendment set.** It
  held that an unsupported component is *reported, not filtered*, on the
  forward-compatibility grounds that the harness ignores it today and would
  start honouring it on an upgrade. The `sse` probe refuted the premise: an
  unsupported component is not necessarily ignored, and Codex misreads that one
  as a `streamable_http` connection to the same url. Since the projector could
  not filter without re-serializing — forfeiting the byte-identity its value
  rested on — its usable domain was "a harness probed and found to safely ignore
  everything it does not support", which cannot be known before writing it.
- **It stopped being an identity projection when hooks became mandatory.** Once
  the package is always the hook channel (fourth amendment), the projector
  appends generated hook artifacts to a tree it documented as byte-identical to
  the filtered source, at paths the harness must independently know to read.
  That is translation with the translation hardcoded, not the absence of one.
- **The counting was the reusable part, and it was quadrupled.** Discovery
  mirrors core's `discoveredComponents` so that a component the analysis phase
  counted cannot vanish from the build report, which replaces the analyzed
  counts with the projector's. All four projectors had written it out
  separately, so the mirror had four independent chances to drift. It is now one
  exported helper taking a per-harness `skipped` verdict, and it clamps that
  verdict to what was discovered — a projector's arithmetic reporting more
  skipped than found would read as a component the harness gains.

## Amendments — 2026-09-08 (sixth)

A `codex review` of the whole branch found seven defects in the projection paths.
Five were one shape: a component claimed at a fidelity the projection did not
deliver. The structural invariant — hooks must reach the harness — was enforced;
the fidelity claims sitting beside it were not.

- **Switching Codex to the native manifest silently dropped the placeholder
  contract.** `.capture/codex-agent-plugin` recorded that on the portable route
  "Codex implements the Agent Plugins placeholder contract itself": `PLUGIN_ROOT`
  and `PLUGIN_DATA` bound in `env`, `cwd` defaulting to the plugin root. The
  second amendment moved the projection to the native `.codex-plugin` route
  because a portable manifest suppresses hooks — and did not re-check the
  contract. It does not hold there (`.capture/codex-native-mcp`): placeholders
  reach the server as literal text and no variable is bound. A package
  referencing its own shipped code — the ordinary case, and what the committed
  example does — registered an argv that cannot resolve, reported `exact`. The
  projector now carries the contract itself, through the one anchor the route
  does provide: a `cwd` resolved against the plugin root, with `command` and
  `args` rewritten relative to it. `agent-plugin.mcp.stdio` becomes `emulated`.
- **A capability recorded on one route is not evidence for another.** That is the
  general lesson, and it is why `${PLUGIN_DATA}` is now dropped with an omission
  on both Codex and OpenCode rather than emitted: neither route can express it,
  and the loader forbids an author from defining the variable themselves.
- **A projection ships the package, not the components it recognises.** The
  OpenCode projector copied skill trees only, so an MCP server's implementation
  never reached the output while the component was reported emitted and exact.
  The whole package is now nested under `.opencode/plugins/package/`, below the
  flat scan, and `${PLUGIN_ROOT}` resolves there.
- **`mode: "plugin"` must produce a plugin on its own.** Widening Codex's
  supported modes made an unprojected plugin-mode target reachable, and it built
  a tree with no manifest — undiscoverable by `codex plugin add`, with a
  `${PLUGIN_ROOT}` hook command that only resolves inside an installed plugin.
  Generation now emits a hooks-only native manifest, which the projector replaces
  with a fuller one, mirroring what Claude has always done.
- **A schema-valid name can be a prototype key.** An MCP server named
  `__proto__` assigned into `{}` reaches the inherited setter and vanishes from
  the emitted JSON while the summary counts it emitted. Both translators build
  null-prototype maps, and the OpenCode module embeds its servers as JSON text
  parsed at load time rather than as an object literal.

## Amendments — 2026-09-08 (seventh)

A second review round found six more, five of them in the previous round's
fixes. The cluster is one under-designed primitive: round six answered "how do I
anchor `${PLUGIN_ROOT}`?" with an ad-hoc string-prefix rewriter, and there were
three separate ways it was wrong. The rewriter is replaced by the specification's
own rules, shared by both projectors in `@hooknostic/agent-plugin`.

- **The placeholder rules are narrower than being helpful suggests.** Agent
  Plugins 1.0 defines exactly two placeholders and expands them in stdio `args`,
  `env` VALUES and `cwd` only -- "it does not apply to `env` keys, `command`, or
  fixed component locations" -- while for remote servers a client "MUST NOT
  perform placeholder or environment-variable expansion in `url`, header names,
  or header values", and "unrecognized placeholder-like text MUST remain
  literal". The OpenCode module resolved every `${VAR}` from the host
  environment, in remote headers included, and a probe had recorded that as a
  success. A package could therefore name any host variable and any URL and have
  the value sent there. It now substitutes the install directory and nothing
  else. `docs/baseline-2026-08-20.md` had recorded half this rule since August;
  it was not consulted.
- **An omitted `cwd` is a value, not an absence.** The specification says a
  client "MUST use the plugin root" when `cwd` is missing. OpenCode's
  `McpLocalConfig` has a `cwd` whose own description says a relative one
  "resolves from the workspace directory" -- so the projection emits it
  absolutely, always, including for the default. The previous amendment claimed
  OpenCode "declares an argv and an environment and nothing else" and omitted
  servers on that basis: a limitation inferred from a probe that had not tested
  it, which is the same error as assuming a capability.
- **Rewriting only the leading placeholder is not rewriting.**
  `--config=${PLUGIN_ROOT}/c.json` and every `env` value were passed through
  literally onto a route that expands nothing. And the depth used for relative
  paths counted raw path segments, so a valid `./worker/` produced one `..` too
  many. Both are gone with the shared helper, which normalizes before counting.
- **A capability is claimed for the range it was captured on.** The Codex
  projector advertised `>=0.148 <1` while its own capture says only 0.153.2 was
  established and the 0.148.0 binary was read as having REMOVED plugin hooks.
  Plugin mode is now refused below 0.153, and the versions beneath it carry a
  profile that declines every component with that reason attached, so `inspect`
  answers for them rather than failing and a range spanning the boundary
  resolves to the declining side.

## Amendments — 2026-09-08 (eighth)

A third review round: four findings, one of them inside the previous round's
work. The count is falling (seven, six, four) and the remaining defects are
runtime-shape rather than contract-shape.

- **A substituted absolute path needs quoting, and the sibling harness's answer
  does not transfer.** `${PLUGIN_ROOT}` expands into a path under the user's home
  directory, which on Windows routinely contains a space, so the unquoted command
  splits and no hook starts. Claude sidesteps this with the exec form
  (`command` + `args`), and the August baseline recommends that form -- but that
  entry is in the Claude section. Probing three spellings on one event
  (`.capture/codex-hook-command`) showed Codex FAILS the exec form and honours
  quoting, so the command is quoted instead. Recording which harness a baseline
  fact belongs to is the recurring lesson of this ADR.
- **A projection ships directories, not only files.** Staging creates parents for
  emitted files, so a package directory carrying none -- a server's `cwd`, the
  case the Claude projection already had a test for -- existed in the package and
  not in the output. The OpenCode plan now carries `directories` as Codex's
  already did.
- **An exclusion is only justified by the harness that needs it.** OpenCode
  dropped `plugin.json` and `mcp.json` from the copied package, a rule inherited
  from Codex, where a root manifest outranks the native one. Nested under
  `package/` they outrank nothing, and a server may name one with
  `${PLUGIN_ROOT}`, so they ship.
- **Textual substitution has to be scoped and guarded.** The generated module
  walked every field of every server, so the marker was replaced in remote urls
  and headers too -- fields the specification requires to stay literal -- and a
  package whose own text contained the marker would have been rewritten.
  Substitution is now confined to a local server's argv, cwd and environment,
  and a package already containing the marker is declined rather than altered.

## Amendments — 2026-09-08 (ninth)

The mechanical half of a fourth review round. The substantive half -- that
Agent Plugins 1.0 requires an absolute `PLUGIN_ROOT` and `PLUGIN_DATA` in every
stdio subprocess environment, which no projection here provides -- is a separate
decision and is NOT addressed by this change.

- **A guard belongs on the path every build takes.** Codex plugin mode is
  refused below 0.153, but that check sat in artifact generation, which a
  package-only config (no `entry`) never reaches. Under `onUnsupported: "warn"`
  such a target projected a native package for a range the projector's own
  profile declines. The refusal now also sits in `project()`.
- **"Not an accepted skill" is not the same as "a rejected skill".** Under
  `onInvalid: "warn"` a rejected skill leaves `source.skills` and stays in
  `source.files`, so a projection that copies the package and points the harness
  at its `skills/` tree ships what the loader said it skipped. The fix is to drop
  the rejected subtree -- but the obvious predicate, "a `skills/<name>/` prefix
  not in `source.skills`", also deletes a directory that never declared a skill.
  A package with shared assets under `skills/shared/` and nothing wrong with it
  loses them. `isRejectedSkillPath` therefore requires the directory to contain a
  `SKILL.md` before treating its absence from `source.skills` as rejection, and
  all three projectors now share it. Claude carried the imprecise version from
  the beginning; this corrects it too.

## Amendments — 2026-09-08 (tenth)

This discharges the ninth amendment's own note: the substantive half it deferred
-- that Agent Plugins 1.0 requires an absolute `PLUGIN_ROOT` and `PLUGIN_DATA` in
every stdio subprocess environment, which no projection here provided -- is
decided here.

- **A client obligation a harness does not meet is met by generated code, not by
  this compiler's own process.** Claude expands both placeholders, binds both
  variables and owns the data directory. Codex and OpenCode do none of it: the
  native Codex MCP route reads placeholders as literal text and binds neither
  variable, and OpenCode passes through only what the package itself declared.
  Both nonetheless advertised `agent-plugin.mcp.stdio` as `emulated` while
  dropping every server that named `${PLUGIN_DATA}`. The projection now emits a
  Node launcher per output; the harness runs it, and it supplies the contract
  before spawning the real server. Hooknostic's own process still creates
  nothing and spawns nothing -- the launcher has the same standing as the
  generated hook dispatcher, and the "remains a compiler" boundary holds.
- **The data directory is chosen by Hooknostic, which is what keeps the level at
  `emulated`.** `PLUGIN_DATA` must "preserve its contents across updates", and
  Codex installs into a version-scoped directory, so a conformant location
  cannot live inside the install root: it is `~/.hooknostic/plugin-data/<name>/`.
  That is a real semantic gap, not a formality -- a different client, including
  a future Codex that implements the contract natively, chooses a different
  directory and does not see the data. The stated criterion is therefore
  `exact` when the *harness* implements the contract and the projection merely
  arranges the declaration, `emulated` when *Hooknostic* implements it on the
  harness's behalf. The launcher defers when the client already sets a matching
  `PLUGIN_ROOT` and an absolute `PLUGIN_DATA`, so a harness that later
  implements the contract keeps ownership rather than being silently overridden.
- **One shared spawn core, two front ends; Claude is not migrated.**
  `${CLAUDE_PLUGIN_DATA}` is genuinely client-managed and survives plugin
  updates, so replacing it with one this compiler invents would trade the real
  thing for an emulation and strand data users already have. Claude keeps its
  own convention and its `exact` level; only the spawn machinery is shared.
- **The launcher selects its server by position in a document the projector
  writes, and that document has exactly one enumeration.** `load.ts` drops
  invalid servers before a projector sees them, so a package that built with a
  warning has positions its own `mcp.json` does not share. Relocating the
  portable document and indexing it would launch one server under another's
  declaration -- silently, and indistinguishably in `codex mcp get`. The
  generated array removes the class by construction rather than adding a mapping
  layer to survive it, and it dissolves the `__proto__`/integer-like-name
  ordering question too: an array has no keys for two sides to order.
- **A `./` command resolves against the plugin root, not against `cwd`.** The
  specification says plugin-relative paths resolve "against the plugin root",
  and Claude already did this; Codex and OpenCode did not, and a comment in
  `placeholders.ts` asserted the wrong reading, which is why the bug existed.
  Corrected in the same change.
- **Node on PATH is now required for every projected stdio server on Codex and
  OpenCode.** The launcher is a Node program, so a package whose server is
  `python`, `deno` or a native binary previously worked on Codex and now needs
  Node as well. Unavoidable under this design and already true on Claude, but it
  is a genuine narrowing and is documented for all three harnesses rather than
  Claude alone.
- **A guard is only worth keeping where it guards something.** OpenCode's
  reserved-marker refusal existed because package-controlled text flowed through
  the generated module's textual substitution. It no longer does -- the portable
  declaration goes to the servers document, which the module never reads -- so
  the refusal is deleted rather than extended to the second marker; keeping it
  would newly reject packages with nothing wrong in them. The equivalent guard
  on Claude's launcher path is *not* redundant and stays: that projector
  accumulates into a `Map`, so a collision there is a silent overwrite rather
  than a duplicate-path failure core would catch.

## Amendments — 2026-09-15 (eleventh)

- **OpenCode package delivery now emits an npm package, and its projection *is*
  an installable unit.** Two statements above are superseded. "A projection is
  not always an installable unit … OpenCode reads `.opencode/plugins/` from the
  project directory, so its projection is project-scoped by construction"
  described the only route then established. It generalised from the route
  Hooknostic targeted to the harness: OpenCode also loads a plugin named in a
  project's `opencode.json` `plugin` array, resolving it as an npm package
  through `exports["./server"]`, and a **local directory path is accepted with no
  registry publication** (`.capture/opencode-plugin-routes`, 1.18.30). Package
  delivery emits that package; project delivery is unchanged and still writes a
  module into the scanned directory.

- **The package root, not `.opencode/plugins/`, is the projection root.** The
  nesting rule that put everything under `.opencode/plugins/package/` existed
  because the flat scan loads every module it finds and a non-function export
  fails the whole module. Nothing scans a package's interior, so that constraint
  does not apply; the author's package still nests under `package/`, now for a
  different and narrower reason — it must not collide with a generated root name
  such as the `index.js` entry.

- **A single entry re-exports both plugins.** A package exposes one module, while
  the layout needs two: compiled hooks and the component injector. Measured on
  1.18.30, two distinct functions exported from one module are each loaded
  exactly once, so the generated `index.js` re-exports both. The same probe
  showed one function exported as both a named export and `default` is loaded
  once rather than twice; the entry nonetheless re-exports no `default`, because
  an entry whose correctness depends on the harness de-duplicating an alias is
  worse than one that never creates the ambiguity.

- **`agent-plugin.manifest` rises from `emulated` to `exact` on OpenCode.** The
  `emulated` rating recorded that a path-resolved project plugin has no manifest,
  so identity survived only as a comment in the generated module. A package has
  `package.json`, and every portable identity field — name, version, description,
  author, homepage, repository, license, keywords — has an npm equivalent and is
  emitted. `extensions` is not, and correctly so: it belongs to the
  client-extension component, which OpenCode does not read.

- **An invalid package name is an error, not a coercion.** The Agent Plugins
  manifest name becomes the npm package name verbatim, validated with npm's own
  rules. Silently rewriting it would publish under a name the author never chose
  and never sees.

## Amendments — 2026-09-17 (twelfth)

- **A projector namespace may be an evidence-backed bridge, not only a native
  read path.** The earlier projector guidance said to declare a namespace only
  when the harness reads it. That made discovery describe the harness while the
  rest of projection describes what the emitted package delivers. OpenAI's
  documented `com.openai` extension exposes the mismatch: Codex 0.154.0 did not
  run a supported inline `hooks` declaration while the equivalent native
  `.codex-plugin/plugin.json` control fired
  (`.capture/codex-client-extension`). The Codex projector therefore declares
  that namespace and translates its settings into the native manifest. This is
  still `exact`: the documented setting is preserved, and the compiler supplies
  the missing route without changing its meaning.

- **Inline OpenAI settings replace the compatibility overlay; they do not merge
  with it.** Official OpenAI documentation defines the
  `extensions.com.openai` object as replacing `.codex-plugin/plugin.json` when
  both exist. Root identity and the portable `skills/` and `mcp.json` components
  remain canonical, so client-extension values for those fields are ignored.
  Other OpenAI-owned settings pass through without Hooknostic attempting to own
  the vendor schema.

- **Authored and generated hooks compose.** `hooks` is an OpenAI extension
  setting rather than a portable component. The projector preserves the
  selected authored declaration; when Hooknostic also emits a hooks document,
  it combines both using the corresponding documented path-array or
  inline-object-array form instead of overwriting the author's hooks. The two
  forms are never mixed in one array.

## Amendments — 2026-09-17 (thirteenth)

- **The output-path reservation applies to Codex, not only to Claude.** The
  2026-09-07 amendment stated the rule — a projector's own output paths are
  reserved against the package root — and the Claude projector implemented it.
  The Codex projector implemented a third of it: `.codex-plugin/plugin.json` was
  refused, while a package-root `.mcp.json` or any other `.codex-plugin/` file
  was copied verbatim. A copied `.mcp.json` reached Codex's native MCP
  configuration without passing `translateMcp`, and beside a build that
  generates one the path was emitted twice — the only complaint being core's
  duplicate-artifact-path error, which blames the adapter for a file the package
  wrote. Both are now a fatal `HN503` naming the path, fatal for the reason
  already recorded for Claude: the package is claiming the projector's output,
  which is not a valid component the harness cannot represent.
- **Reserved against a hoist is not the same set as reserved against the package
  root.** `skills/`, `runtime/` and `hooks.json` are refused as hoist targets and
  deliberately not as package-root paths. `skills/` is the portable tree the copy
  loop exists to copy; `runtime/` is inert package content whose one real
  collision — the generated launcher — is already reported where the launcher is
  emitted; a root `hooks.json` the native manifest never names is inert on
  0.154.0 (`.capture/codex-client-extension`), and a collision with a generated
  hook artifact is likewise already reported. What makes those three dangerous
  under hoisting is the rewrite, not the path, so completing the two lists into
  one would newly reject packages with nothing wrong in them — the test the
  tenth amendment applied to OpenCode's reserved-marker refusal.

## Amendments — 2026-09-17 (fourteenth)

- **An unpublishable package name is two different verdicts.** The eleventh
  amendment made an invalid name an error rather than a coercion, reading npm's
  rules as one gate. They are two: a name npm will not install produces a
  directory that cannot be packed, and stays an error; a name npm installs but
  will not publish — `MyPlugin`, `http`, anything past 214 characters — costs
  only publication, and warns. `PluginSpec.name` is `string().min(1)`, so those
  names are reachable, and they built and loaded before this branch. The
  distinction matches the sibling version check, which was left a warning for
  exactly this reason: the package still loads from a local path, and npm does
  not object until `npm publish`, long after the build. The coercion refusal is
  unchanged in both tiers — neither rewrites the author's name.

- **A target may name the npm coordinate its output publishes under.** The
  Agent Plugins name grammar admits only `[a-z0-9.-]`, so `@scope/name` is
  unspellable in a manifest, and the generated npm manifest takes its name from
  the manifest. `TargetConfig.npmName` is the only route to a scoped package. It
  sits on the target rather than the plugin because each target's output is a
  different npm package — an OpenCode package and a plugin directory are not
  interchangeable contents, so publishing two means two coordinates. It is also
  the one place the tier split above does not apply: a coordinate that exists for
  no purpose other than publishing is fatal when npm would refuse to publish it.

- **`npmName` is gated by an adapter declaration, and confirmed against the
  emitted manifest.** Asking only whether the coordinate reached a
  `package.json` in the output answers the wrong question: emitting a root
  manifest is not publishing one, and two adapters that never read `npmName`
  emit one anyway — Codex copied the source project's until this branch stopped
  it, Claude builds one from `components.runtimePackage` — so either name
  matching by coincidence passed a guard whose whole purpose is catching a
  setting that quietly does nothing. An adapter now declares
  `publishesNpmPackage`. That question needs only the config and a static flag,
  so it is answered in `analyzeCapabilities` beside the other declarative
  refusals: `check` reports it without generating anything, and `build` never
  bundles a target it is about to fail. The emitted manifest is still confirmed
  afterwards, because the two answer different questions — a mismatch there is
  the adapter breaking its own declaration, and the remediation says so rather
  than sending the author to a different harness. Undeclared reads as no, so an
  adapter that gains npm packaging later refuses the coordinate loudly until it
  says otherwise; for a field that decides where a package is published, failing
  closed is the safe direction.

## Amendments — 2026-09-21 (fifteenth)

- **Claude's native substitution is broader than the portable contract.** A
  package probe on 2.1.278 (`.capture/agent-plugin-mcp-placeholders`) showed
  that Claude substitutes any set environment variable into a projected
  package's stdio args, env values and launcher cwd argument, and into remote
  urls and header values. An unset name remains literal. This is Claude's
  documented `.mcp.json` expansion, not something specific to plugins, and
  neither that probe nor `.capture/claude-project-mcp-environment` found an
  escape. Agent Plugins 1.0 requires every name except `PLUGIN_ROOT` and
  `PLUGIN_DATA` to remain literal on stdio fields and forbids all remote
  expansion.
- **The deviation is reported, not engineered around.** The projection keeps
  its native declaration. Each server containing text Claude would expand gets
  an `HN205` warning naming the server and the references, and is still
  emitted. The severity is fixed at warn rather than following
  `onUnsupported`: nothing is omitted, and when the variable is set the server
  gets what its author almost certainly meant. The three MCP components stay
  `exact` and their rationales state the deviation, as the manifest's author
  caveat already does: Claude implements the contract. It is just broader than
  the contract.
- **An opaque server document was prototyped and rejected.** Moving every
  server's command, args, env and cwd into a generated document that the
  launcher reads by index kept the text literal on 2.1.278. But it charged
  every package for a rare one:
  - Claude's `.mcp.json` would show only `node <launcher> <index>`. `/mcp`,
    `claude mcp get`, and anyone reviewing an installed plugin would lose sight
    of what runs.
  - It moved Claude onto the self-resolving front end that the tenth amendment
    kept it off.
  - It protected text whose author almost always meant expansion.

  Refusing remote servers that contain a reference was rejected with it.
  Claude's own documentation uses `Authorization: Bearer ${API_KEY}` as its
  example. Under the default policy the refusal failed the build for a server
  that works on Claude as its author intended, and left the author to strip the
  header or wrap the server in a stdio proxy.
- **The seventh amendment's security argument does not transfer.** That removal
  concerned expansion that Hooknostic's generated OpenCode module performed, a
  capability the harness itself did not grant. Claude grants this one to every
  native plugin, so passing the text through gives a projected package nothing
  a hand-written Claude plugin lacks. The warning makes the departure from the
  portable contract visible; the projection does not widen it.
- **Project delivery is unchanged here.** Claude project integration still omits
  a package-origin remote server containing a reference
  (`.capture/claude-project-mcp-environment`). Whether it should warn instead
  is a separate decision.

