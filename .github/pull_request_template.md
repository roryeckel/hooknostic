<!--
Thanks for contributing. Most of this template is proof rather than paperwork:
the checkboxes below are the things that have actually gone wrong in this
repository before. If your change is docs-only, skip straight to the last two
sections — the rest does not apply and nobody expects it.
-->

## What this changes

<!-- One or two sentences. What was wrong or missing, and what is different now. -->

## Scope

- [ ] Docs / typo / clarification
- [ ] Bug fix with a reproduction
- [ ] A claim about a harness (capability level, shape table, honoured channel)
- [ ] The portable vocabulary (effect, capability id, HNxxx diagnostic, event, tool kind)
- [ ] A new harness adapter

Issue: <!-- required for the bottom three: link the issue or discussion that agreed this change -->

## Proof of resolution

<!--
Only for behavioural changes. A test that has never failed has not been shown to
test anything -- this repository's history contains five tests that passed
against the exact bugs they were written for, which is why this is asked of
everyone including the maintainer.
-->

- [ ] I added or changed a test, then **watched it fail** against the defect —
      by reverting the fix or applying a small mutant — and restored afterwards.

<details><summary>Failing output before the fix</summary>

```
paste it here
```

</details>

## Proof of no regression

Run each and report its own exit code — never a piped or chained one.

- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `HOOKNOSTIC_PLAYBACK=<harness> pnpm exec vitest run packages/cli/test/harness-playback.test.ts`
      — required if this touches an adapter. It uses the real harness binary
      with a loopback model server: no API key, no spend, and identical to CI.
      See `docs/testing.md`.

## Evidence

<!-- Only for changes that make a claim about a harness. -->

- [ ] Fixture added under `fixtures/<harness>/<version>/`, with a provenance row
      in that directory's README.
- [ ] A `validatedOn` record appended to the profile's `source`, naming the
      exact version, the date, the method, and what the session established.
- [ ] The provenance I recorded matches what I actually did — in particular, a
      router-level observation is filed as `router-log`, not as `captured`.

## Generated output

- [ ] Committed example artifacts rebuilt **from the repository root**
      (`examples/rewrite-shell/dist`, `examples/agent-plugin/dist`), or not affected.
- [ ] `docs/harness-support.md` regenerated with
      `node scripts/generate-harness-support.mjs` rather than edited, or not affected.
- [ ] I did not hand-edit anything a build produces.

## Anything else

<!--
Judgement calls you made, alternatives you rejected, things you are unsure about.
Flagging uncertainty here is genuinely helpful and will not count against the PR.
-->
