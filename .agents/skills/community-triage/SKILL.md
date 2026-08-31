---
name: community-triage
description: Triage community issues, pull requests, discussions, and support threads against project scope and maintainer capacity. Use when reading or replying to a GitHub issue or PR, deciding whether a request is in scope, judging whether a report carries enough evidence, routing a limitation to a harness vendor, or closing a thread.
---

# Community triage

You are triaging for a **single-maintainer** project whose product is honest
capability information, not maximal coverage. Most threads are decided by scope
and evidence rather than by effort, and saying so kindly and early is the
service — a request left open for months is worse for the reporter than a clear
"not this project, and here is why".

## Required context

The canonical scope statement lives in `CONTRIBUTING.md` ("What Hooknostic is" /
"What Hooknostic is not" / "The rule that decides most contributions"). Read it
and **link to it**; do not restate it in your reply, and never let this file
drift into a second copy of it.

For anything touching harness facts, `.agents/skills/harness-capture/SKILL.md`
is the procedure; `AGENTS.md` carries the hard rules.

## Default posture

Assume good faith and real frustration. Reframe a vague report into an
answerable technical question rather than bouncing it. Gather evidence before
concluding — including against your own first instinct, which will usually be
that the reporter is confused. Sometimes they are right and the adapter is
wrong; that is the single most valuable thread type this project gets.

Resist scope expansion by momentum. "It is only a small change" is how a
single-maintainer project acquires a permanent obligation.

## Evidence standard

Use the ladder the codebase already types (`ValidationMethod` in
`packages/core/src/adapter.ts`), strongest first: `captured`, `live-probe`,
`router-log`, `schema-derived`, `type-derived`, `doc-derived`.

- **Strong**: a hook-boundary payload, a fixture, a playback run, an observed
  effect (a marker file written, a spawned command line read from a debug log).
- **Weak**: a changelog, a release note, a vendor blog post, a type definition
  read without running anything, "it works for me", a screenshot of a UI.

Two rules that have each already cost this project a wrong claim:

1. **Router logs are not hook captures.** A harness may route a call under one
   tool name and argument shape, then hand the hook a translated payload with a
   different name, a different key, and fields dropped. Evidence about the
   router is not evidence about the hook boundary. When a reporter conflates
   them, say which one they have — without implying they wasted their time,
   because router evidence is genuinely useful for defensive coverage.
2. **"The harness did not complain" is not evidence.** Verify an effect by its
   effect. Some harnesses print a completion line for hooks they skipped.

## Decision matrix

| Outcome | When |
| --- | --- |
| **Fix** | A defect on a supported surface with a reproduction, or a claim contradicted by evidence at or above the level the claim itself was recorded at. Minimal fix, no scope expansion. |
| **Ask** | Exactly one missing fact would decide ownership. Ask for that one thing, not a form. |
| **Route upstream** | The limitation is the harness's own. This is provable here — see below. |
| **Decline** | Out of scope by `CONTRIBUTING.md`, or in scope but unaffordable. Say which. |

### Route upstream, with proof

This project's strongest move, and it is not an assertion:

```
hooknostic inspect <target> --capability <id>
```

That prints the adapter's own version-scoped rationale. Quote it, and give the
reporter the command so they can re-run it themselves. Then offer to help word
the report for the harness's tracker — the reporter has hit a real wall, and
routing without that offer reads as a brush-off.

### Ask for the smallest thing

Only what changes the ownership decision: `hooknostic doctor` output, the
config, `check`/`build` output with the HNxxx codes intact, or one capture. Do
not front-load a questionnaire onto someone who already filled in a form.

### Decline cleanly

Common declines, each with a reason that is about the project rather than the
person:

- Rating a capability higher than the adapter can deliver, because it "mostly
  works". The rating *is* the product.
- An emulation that hides a real difference. Emulation is welcome when declared
  at the level it actually achieves, with a rationale saying how it differs.
- A harness conditional in `core` or `runtime`. Harness knowledge lives in an
  adapter.
- Widening a `recommendedRange` on the strength of "probably still works".
  Ranges are present-tense claims; extend them with a capture.
- A shape table entry sourced from a changelog rather than an observation.
- A new adapter with nobody behind it for the long run. Point at the
  maintenance contract in `CONTRIBUTING.md` and ask directly.

## Reviewing a pull request

Beyond scope and correctness:

- Was the new test **shown to fail** against the defect? Ask for that output if
  it is missing. It is in the PR template for a reason.
- Was the playback lane run for an adapter change? It costs the contributor
  nothing, so there is no reason to accept its absence.
- Committed example artifacts rebuilt from the repo root; `harness-support.md`
  regenerated rather than edited; nothing generated hand-edited.
- Provenance recorded honestly — a `validatedOn` record whose `method` matches
  what was actually done.
- A behavioural fix bundled with a broad refactor: ask to split, and say the
  fix is welcome on its own.

## Response style

Thankful, direct, factual. Name the boundary, cite the file or the command, give
the re-entry condition. No sarcasm, no blame, no speculative roadmap promises,
and no implication that a question was stupid — the capability model is
genuinely subtle, and confusion about it is usually the docs' fault.

Closing a thread: thank them, say what you checked, say why it is out of scope
or upstream, name the supported surface, and state what would reopen it.

## Re-entry criteria

Reopen when: a reproduction lands on a supported surface; a capture arrives that
settles a previously unevidenced claim; a PR narrows to supported behaviour with
tests; or a new harness release changes the behaviour the decision rested on —
that last one is expected, and a closed thread is not a permanent verdict about
the harness, only about the versions validated at the time.

## Anti-patterns

- Accepting a plausible claim because the reporter sounded confident.
- Letting a low-fidelity thread sit open indefinitely instead of asking once and
  closing kindly.
- Treating a vendor changelog as capture-grade evidence.
- Filing router evidence as a hook capture, or vice versa.
- Agreeing to an adapter without asking who maintains it.
- Fixing a reported symptom in `core` because that is where the change is
  smallest.
- Restating the scope statement in a reply instead of linking it, so that the
  two drift apart.
