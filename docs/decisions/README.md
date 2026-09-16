# Design decisions

The load-bearing choices behind Hooknostic, each written down with the context that
forced it and the consequences it commits us to. (In software-architecture circles
these are called *architecture decision records*, or ADRs — code comments and the
design document reference them by their `ADR-000N` ids.)

Read these when you want to know *why* something works the way it does, not just how:

| Decision | The question it answers |
| --- | --- |
| [0001 — Capabilities are separate from events](0001-semantic-capability-model.md) | Why doesn't "the event exists" mean "you can block it"? |
| [0002 — Hooks can't keep state between calls](0002-invocation-stateless-contract.md) | Why is there no place to stash data between hook invocations? |
| [0003 — One entry point runs all your hooks, in order](0003-one-dispatcher-composition.md) | Who decides the order when several hooks match the same event? |
| [0004 — Agent Plugins is a peer, not a dependency](0004-agent-plugins-relationship.md) | How does Hooknostic relate to the Agent Plugins packaging standard? |
| [0005 — Which effects end a dispatch, stated once](0005-terminal-effects.md) | Which effects stop the remaining hooks, and which just add to the result? |
| [0006 — Commit the built artifacts](0006-artifact-distribution.md) | Should build output be checked into the consumer's repository, or generated? |
| [0007 — Portable shell write-back](0007-portable-shell-write-back.md) | How does a hook rewrite a shell command without knowing each harness's native key? |
| [0008 — Harness version metadata](0008-harness-version-metadata.md) | Where do harness version facts live, and what keeps every other mention honest? |
| [0009 — Rolling scheduled-playback record](0009-rolling-scheduled-validation-record.md) | Why does one profile validation record get rewritten in place while every other stays append-only? |
| [0010 — Capability coverage policy](0010-capability-coverage-policy.md) | What does "full automated coverage" of the capability profiles mean, and what enforces it? |
| [0011 — Project Agent Plugins into native plugins](0011-agent-plugin-native-projection.md) | How are portable Agent Plugins compiled into harness-native plugins? |
| [0012 — Claude plugin runtime dependencies](0012-claude-plugin-runtime-dependencies.md) | How can projected Claude MCP servers resolve Node dependencies? |
| [0013 — Explicit executable files](0013-portable-file-permissions.md) | Why does a file need declaring to be executable, rather than inheriting the bit it has on disk? |
| [0014 — First publication bootstrap](0014-first-publication-bootstrap.md) | How does a package reach npm the first time, when trusted publishing requires it to exist already? |
| [0015 — First-class repository-local integration](0015-project-integration.md) | Who wires generated artifacts into a project — the consumer, or Hooknostic? |
| [0016 — A portable model.request.before event](0016-model-request-before-event.md) | Why does a moment only OpenCode exposes a hook at get its own normalized event? |
| [0017 — MCP runtime dependencies are language-neutral](0017-mcp-runtime-dependencies.md) | How does an MCP server written in Python, Go, Rust or C# say what it needs at run time? |

Each record is immutable once accepted; a change of course gets a new record that
supersedes the old one rather than a silent edit.
