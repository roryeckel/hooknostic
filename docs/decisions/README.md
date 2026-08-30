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

Each record is immutable once accepted; a change of course gets a new record that
supersedes the old one rather than a silent edit.
