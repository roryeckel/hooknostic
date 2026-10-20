# Pi 1.x with native MCP, and a stated MCP identity

0.8.0 adds pi 1.x as a second supported pi line. Project and package delivery
now hand stdio and streamable-HTTP MCP servers to pi's own MCP client through a
generated extension, where 0.7.0 could only omit them. Because pi's MCP tool
names are lossy, the server and tool split for those calls comes from what pi
states beside the call, not from the name. See the versioned
[harness support table](harness-support.md) for support levels and their
evidence.

## What is included

- A `>=1 <2` pi profile referencing 1.3.0, beside the retained `>=0.84 <1`
  line. A target pinned to either line gets that line's support; a range
  spanning both keeps resolving to the least capable level.
- Pi 1.x package and project delivery project stdio and streamable-HTTP MCP
  servers into pi's native client. stdio runs through the shared launcher,
  which binds the package root and a Hooknostic-managed data directory; header
  values are escaped for pi's `$` and `$!` expansion. pi rejects the legacy SSE
  transport, so that single omission is named `pi:mcp-sse-omitted`.
- `tool.mcp` on pi 1.x carries the server and tool pi registered, on
  `tool.after` and on a server-reported `tool.error`. The shim reads the
  registration source so only tools pi's own MCP extension registered supply
  it; another extension's `mcp__` tool, a JSON-RPC failure and a `tool.before`
  call keep the split absent. [ADR-0032](decisions/0032-stated-mcp-identity.md)
  records the model.
- An adapter now declares where its `tool.mcp` split comes from, and
  `inspect`, `hooknostic dispatch` and the contract suite hold a test or a
  fixture to that declaration, so none of them can claim an identity the
  harness never states.
- `${SKILL_DIR}` in a Codex SKILL.md body becomes
  `<absolute path of the directory containing this SKILL.md>` instead of `.`.
  In a controlled package-delivery comparison the explicit placeholder
  succeeded on 10 of 10 first launcher attempts against 1 of 10, so the build
  now treats the remaining substitution as a model dependency rather than a
  solved path.
- Generated launchers and OpenCode project delivery resolve project-relative
  paths through one shared helper, which fixes a stdio server started with a
  missing `cwd` when the project was reached through a junction, symlink or
  another Windows drive or UNC share.
- Harness evidence was refreshed by the scheduled model-free playback lanes:
  Claude Code 2.1.303, Codex CLI 0.163.0, OpenCode v1 1.19.3 and OpenCode v2
  2.0.32. Automatic harness-watch merges are now guarded and serialized.

## Upgrading from 0.7.0

- **Node.** The supported range is now `^22.22.2 || ^24.15.0 || >=26.0.0`, in
  all three published packages. Node 22 before 22.22.2, Node 24 before
  24.15.0, and the odd 23 and 25 lines are no longer supported; see
  [dependencies](dependencies.md).
- **Codex skills.** A rewritten Codex skill body now fails the build as
  `codex:skill-directory-model-substitution` (HN101). Review the skill, then
  add `components.accept: ["codex:skill-directory-model-substitution"]` to ship
  it with an informational diagnostic. Acceptance records the dependency on
  the model.
- **Shared skill paths.** Codex and OpenCode both write project skills to
  `.agents/skills`. A combined sync whose two projections would differ at the
  same path is now rejected before anything is written; use package delivery
  for separate projections, or skill text both targets can share.
- **Pi MCP omissions.** A `>=1 <2` target no longer needs
  `pi:mcp-stdio-omitted` or `pi:mcp-streamable-http-omitted`; remove them and
  accept `pi:mcp-sse-omitted` only if a server uses SSE. A `>=0.84 <1` target
  keeps the previous omissions and support levels.
- **Pi MCP guards.** On pi 1.x, guard `tool.before` on `kind: "mcp"`,
  `nativeName` or `raw`. Use `tool.mcp` on `tool.after` and on a
  server-reported `tool.error`, and keep a `nativeName` fallback because pi's
  spelling of a name can be ambiguous.

## Limits

- Pi's `mcp__` name is never parsed for the split: pi rewrites characters and
  hashes collisions, so the name alone cannot identify the server. An MCP call
  whose harness-stated identity is absent stays absent, which is the documented
  signal to fall back to `nativeName` and the raw form.
- The pi shim follows the target's version range, settled at build time, and
  never sees the running harness version. A target spanning `>=0.84 <2` treats
  `mcp__` tools conservatively; pin a single line to get the 1.x behavior.
- Codex performs no runtime expansion in skill text. Correct substitution of
  the explicit placeholder remains the model's job, and project delivery was
  conservatively treated as having the same limitation rather than separately
  probed.
- Pi 1.x still has no native permission or subagent lifecycle channel, turn-stop
  and session-end mappings remain emulated, and output replacement is
  approximate. SSE remains unsupported.
- Harness evidence for pi remains Windows and Linux; no macOS harness captures
  exist.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
