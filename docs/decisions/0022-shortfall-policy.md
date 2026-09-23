# ADR-0022: Every shortfall has a class, a default, and an id to accept

## Status

Accepted, 2026-09-23. Refines [ADR-0019](0019-agent-plugin-spec-deviations.md),
whose rejected per-id acknowledgement this adopts.

## Context

A build can fall short of what the author wrote in several ways, and Hooknostic
already had one policy option for each:

| Class                                     | Example                                    | Option                   | Default    |
| ----------------------------------------- | ------------------------------------------ | ------------------------ | ---------- |
| Invalid input                             | a malformed skill                          | `onInvalid`              | error      |
| Omitted                                   | a component the harness cannot take        | `onUnsupported`          | error      |
| A whole component at a lower fidelity     | OpenCode skills are `emulated`             | `compatibility.minimum`  | `emulated` |
| The harness departs from the specification | Claude expands `${NAME}` in MCP text       | `onDeviation`            | warn       |

ADR-0021 added a case none of these fit. An OpenCode skill that cannot be named
for its plugin is still emitted, so it is not omitted. The spec says nothing
about how skills are exposed, so it is not a deviation. The component as a
whole is still `emulated`, so it is not a level. The first implementation
reported it as a warning chosen by the projector, which no author could make
fatal and no author could quiet for one known case.

Authors differ. Some want any shortfall to fail the build. Others accept a
specific, understood one. Hooknostic is not yet published, so the shape of this
configuration can still change; once published, each option is API.

## Decision

- **Every shortfall belongs to a class, and severity comes from the class's
  option, never from the code that finds it.** A projector or integrator
  reports instances; core applies the policy. This already held for
  deviations (ADR-0019) and now holds for every class.
- **A new class, degradation.** An item the projection emits but cannot deliver
  at its component's level. It is declared on the profile beside the level,
  under `degradations`, with the same `{ id, summary, evidence }` shape as a
  deviation. The evidence is the capture that makes the translation
  necessary, and it must be one of the profile's `validatedOn` artifacts.
  Instances go in `summary.degradations`. Core reports each as HN101 and
  records it in the build report under `projection.degradations`. An id the
  resolved profile does not declare fails the target with HN301, as for
  deviations. The first is `opencode:skill-name-unqualified` (ADR-0021).
- **Defaults follow who can fix it.**
  - When the author can fix it in their own package, the default is an error:
    invalid input, an omitted component, and a degradation
    (`components.onDegraded`, default `"error"`).
  - When only the harness can fix it, the default is a warning: a deviation.

  Starting strict is the safer direction for an unpublished tool, because
  relaxing a default later breaks no build and tightening one does.
- **`components.accept` lists qualified ids to ship whatever the policy says.**
  It covers deviations and degradations, on package and project delivery. An
  accepted instance is still reported, as `info`, and still recorded in the
  build report: an author who has seen it and chosen to ship it is different
  from nobody having looked. An id that no configured target's adapter
  declares in any profile is an HN501 error, so a typo cannot silently accept
  nothing. Any profile counts, because an accepted id may belong to a version
  range the build does not cover yet.
- **Nothing short of exact is silent.** Every instance is a diagnostic and a
  report entry with a stable qualified id, whatever its severity.

## Consequences

- An author who wants rigour sets `onDeviation: "error"` and
  `compatibility.minimum: "exact"`; the other defaults are already strict. An
  author who accepts one known shortfall names its id in `accept` and keeps
  everything else strict.
- A preference between two valid outputs is not a policy. It gets an option of
  its own on the target, as ADR-0021's `skillNames` is.
- A check outside a single build, such as a clash between packages found where
  a marketplace is composed, uses the same shape: a stable id, an error by
  default, and acceptance by id (ADR-0021).
- A new shortfall is a capture, a profile declaration and a detector. It is
  never a new option, unless it is a new class.
