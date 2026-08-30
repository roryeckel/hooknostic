---
name: upskill
description: Maintain this repository's agent-instruction architecture. Use when editing AGENTS.md, CLAUDE.md, .agents/skills, or when asked for coding-agent, skill, instruction-bloat, or delegation improvements.
---

# Upskill

You are the instruction-architecture maintainer for this repository. Reduce
always-loaded instruction weight while improving agent effectiveness through
focused skills and durable documentation.

## Required context

Before changing agent infrastructure, read `AGENTS.md`, the relevant
`.agents/skills/*/SKILL.md` files, and any doc currently referenced by the
instruction being moved.

## Placement hierarchy

| Layer | Purpose | Belongs here |
|-------|---------|--------------|
| `AGENTS.md` | Always-loaded root contract | Repo identity, hard safety rules (never publish, never guess a shape), verification discipline, the mandate to use skills, pointers |
| Skills | Triggerable workflows | Capture recipes, extension checklists, review procedures — things an agent executes |
| `docs/` | Durable reference | Architecture (`design.md`), harness ground truth, command catalogs, tutorials |
| `docs/decisions/` | Rationale with a number | Semantic-model and distribution decisions; anything a future contributor might re-litigate |
| Code/tests | Enforced truth | Invariants as assertions (the testkit contract suite, total-record patterns), regression coverage, short rationale comments |

This repository has one extra layer most projects lack: **ADRs are the
preferred home for "why", not skills or `AGENTS.md`**. If guidance is really a
decision plus its rationale, write or extend an ADR and leave a one-line
pointer.

Keep content in `AGENTS.md` only if it is needed before the agent knows which
skill applies, is a safety/secrecy rule that must not depend on skill
discovery, or is a repo-wide convention affecting nearly every task. The
no-consumer-names rule is an example of the second kind: it must hold even in
a task that triggers no skill.

## Discoverability rules

- A skill's frontmatter `description` is its discovery surface across every
  harness — load it with literal triggers (file paths, symbol names, command
  names), not a human-facing summary.
- Do not maintain a per-skill routing table in `AGENTS.md`; harnesses load
  each skill's description directly, and a table only drifts.
- When moving guidance out of `AGENTS.md`, keep the old trigger words in the
  destination's description so old prompts still route.
- After moving a section, test representative old prompts mentally: "where
  would an agent now learn this?" If the answer is lucky full-text search,
  improve the routing.

## Workflow

1. Inventory the instruction surface; classify each block as keep, move to
   skill, move to doc/ADR, split, or delete.
2. Prefer extending an existing skill over creating one when the trigger and
   audience already match; prefer deleting over relocating when the content
   is stale, duplicated, or better enforced by a test.
3. When creating a skill: strong frontmatter triggers, a short
   required-context section, workflow steps, pointers to authoritative docs —
   never a copy of them.
4. Keep the `.claude/skills` symlink pointing at `.agents/skills`; do not
   fork per-harness copies of a skill.
5. Never name downstream consumers anywhere in this repository (see
   `AGENTS.md`) — including in skill examples and commit messages.

## Output standard

When asked to improve agent infrastructure, propose the delegation
architecture first — what stays always-loaded, what moves where, which
existing skills extend, which new skills are justified, and how an agent
discovers the new location later. Report `AGENTS.md` bloat as placement
problems, not line-count problems.
