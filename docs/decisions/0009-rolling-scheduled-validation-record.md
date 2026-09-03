# ADR-0009: One mutable rolling scheduled-playback record per adapter

Date: 2026-09-02
Status: Accepted

## Context

Harness-watch (issue #1) runs scheduled model-free playback against new
harness builds and, on pass, records a `live-probe` validation. The natural
recording style in this repository is append-only: every human validation gets
a new `validatedOn` entry (the harness-capture skill's rule), because each
record claims something distinct about a distinct build.

Weekly scheduled playback breaks that assumption. The runs differ only in the
harness version they exercised — same procedure, same assertions, same
artifact — so appending would add one near-identical row per week, forever:
`validatedOn` bloats, and every consumer surface that renders it
(`docs/harness-support.md`, `inspect --json`, `doctor`) repeats rows whose
only delta is a patch number. The meaningful claim to a *consumer* is "the
newest build that passed scheduled playback", not the sequence of builds that
passed it; the sequence is for maintainers, and git history already keeps it.

## Decision

1. **One rolling record per adapter.** Each profile's `validatedOn` carries a
   marker-delimited region (`scheduled-playback:begin` … `end`) holding at
   most one record, rewritten in place by
   `scripts/record-playback-validation.mjs` — and only by that script. The
   region starts empty: a marker with no record is not a claim.
2. **The record's `what` is the marker key.** Its `what` string
   ("scheduled model-free playback vs a newer build: …") is how
   `scripts/check-harness-releases.mjs` identifies the rolling record when it
   computes the playback baseline. Unrelated narrow records (a router-log, a
   scoped live-probe) deliberately do **not** raise the baseline — one narrow
   probe must never suppress a full scheduled playback run.
3. **All human records stay append-only.** The exception is scoped to exactly
   the marker-region record; nothing else in a profile is ever rewritten by
   automation. The script hard-fails on missing or duplicated markers, and its
   rewrites are byte-identical outside the region.
4. **Baseline math**: the playback baseline is
   `max(harness.referenceVersion, rolling record version)`. `referenceVersion`
   is included so a pinned in-range *older* build (e.g. the reference itself)
   with an empty marker region is a no-op rather than a redundant record;
   non-marker records are excluded for the reason in (2). A version that does
   not strictly advance the baseline exits 4 (already recorded / older); a
   version outside every profile range exits 3 — range extension is a
   human-capture decision, never a scheduled-write one.

## Consequences

- Package consumers lose the intermediate scheduled versions from
  `docs/harness-support.md` — only the newest rolling record per adapter is
  visible there. Git history preserves the full sequence for maintainers;
  `git log -p` on a profile is the audit trail.
- `docs/harness-support.md` stays generated and honest: the generator reads
  the profile, and the rolling record is just another (mutable) row.
- The harness-capture skill's append-only rule now has one documented
  exception, linked here, so the policy is a decision rather than folklore.
- Idempotency is observable: the script exits 0 with a "no-op" line when the
  rolling record already names the requested version, letting the harness-watch
  record job skip cleanly instead of producing an empty commit.