# Contributing to Hooknostic

Thanks for being here. This page is the project's scope statement as much as its
how-to: reading the first two sections should tell you whether an idea will be
accepted *before* you write any code.

Hooknostic is maintained by one person. The boundaries below are not gatekeeping
for its own sake — they are what keeps the project's central promise affordable.

## What Hooknostic is

A compiler with optional project reconciliation. Portable hooks, direct skills/MCP, or an Agent Plugins package go in;
native per-harness artifacts come out. Projection is a packaging transform, not an
dependency installer, marketplace, or runtime service. Explicit `sync` reconciles project files; it never changes harness trust or installs dependencies. See [repository-local integration](docs/project-integration.md) and [ADR-0015](docs/decisions/0015-project-integration.md).

Its actual product is **honest capability information**. Coding agents differ in
what a hook is allowed to *do* — block a call, rewrite tool input, add
model-visible context, prevent a stop — and Hooknostic's job is to state those
differences rather than hide them. Every capability on every target resolves to
`exact`, `emulated`, `approximate`, or `unsupported`, with a rationale you can
print (see [inspect](#showing-your-work), below). Agent Plugin components use the
same support levels through their adapter-owned projector profiles.

A change is in scope if it makes that information more accurate, more complete,
or easier to act on.

## What Hooknostic is not

- **Not a sandbox or a security boundary.** Generated integrations preserve each
  harness's own trust and review mechanisms, and Hooknostic never modifies trust
  state on your behalf. See the trust note at the end of the [README](README.md).
- **Not a compatibility layer that makes every harness look the same.** If a
  harness cannot do something, the answer is `unsupported` with a reason — not an
  emulation that quietly behaves differently. An emulation is welcome *when it is
  honest*: it must be declared at the support level it actually achieves, with a
  rationale saying how it differs.
- **Not a place to special-case a harness in `core` or `runtime`.** Harness
  knowledge belongs in an adapter. A conditional on a harness id in shared code is
  a design smell here, not a shortcut.
- **Not a host for out-of-tree adapters — yet.** See
  [Adapters](#adapters-are-a-standing-commitment).
- **Not an Agent Plugins or Agent Skills authoring framework.** The
  `@hooknostic/agent-plugin` package validates and projects the standard; it does not
  redefine it.

## The rule that decides most contributions

> **Never guess a harness shape.**

Every claim about a harness — a payload field, a tool argument key, whether a
write channel is honoured, what a capability really supports — needs captured
evidence, or explicitly recorded weaker provenance. A confident, plausible,
well-written change with no evidence behind it is not mergeable. This is not
scepticism about you; the project has been wrong about its own harnesses more
than once, in exactly the places where something seemed obvious.

Evidence has a ladder, and it is a type in the codebase (`ValidationMethod` in
`packages/core/src/adapter.ts`), not a vibe:

| Provenance | What it means |
| --- | --- |
| `captured` | A real payload observed at the hook boundary and saved as a fixture |
| `live-probe` | A behaviour observed end to end in a real session by its effect |
| `router-log` | A shape observed one level *below* the hook boundary |
| `schema-derived` | Read from the harness's own published schema |
| `type-derived` | Read from the harness's shipped type definitions |
| `doc-derived` | Read from vendor documentation |

Weaker provenance is allowed — it just has to *say* it is weaker, in the fixture's
provenance row and in the profile's `validatedOn` record. What is not allowed is
an unlabelled claim that looks captured.

One distinction is worth stating on its own, because it has already caught this
project out: **a router log is evidence about the router, and a hook capture is
evidence about the hook boundary.** They are not interchangeable. Codex routes a
call with one tool name and argument shape, then hands the hook a translated
payload with a different name, a different key, and one field dropped entirely.
File them as different provenance.

The procedure for producing evidence is in
[`.agents/skills/harness-capture/SKILL.md`](.agents/skills/harness-capture/SKILL.md).
It is written for coding agents, but it is a perfectly good human checklist.

## Before you open a pull request

| Change | What to do |
| --- | --- |
| Typos, docs, clarifications | Open a PR directly |
| A bug with a reproduction | Open a PR directly, or file an issue if you would rather not write the fix |
| Any claim about a harness — capability level, shape table, honoured channel | **File an issue first**, with your evidence |
| The portable vocabulary — an effect, capability id, diagnostic code, event, tool kind | **File an issue first** |
| An Agent Plugin component id or projector support claim | **File an issue first**, with harness evidence |
| A new harness adapter | **Start a [Discussion](https://github.com/roryeckel/hooknostic/discussions)** |

The issue-first rule is not bureaucracy: for anything in the bottom three rows,
the discussion is about *evidence and scope*, and it is much cheaper to have
before the code exists than after. A PR that arrives without one may be asked to
go back to an issue even if the code is good.

Questions, "how do I…", and "will you support X" all belong in
[Discussions](https://github.com/roryeckel/hooknostic/discussions) rather than the
issue tracker, which is kept to actionable, evidenced work.

## Running the gates

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm build
pnpm test
```

Check each exit code on its own — never trust a piped or chained one.

For version ownership, dependency updates, and committed example regeneration,
see the [dependency inventory](docs/dependencies.md). Dependency upgrades use
reviewed Renovate PRs; Node support-floor changes remain manual decisions.

If your change touches an adapter, also run the **playback lane**. It drives the
real harness binary against a loopback scripted model server: no API key, no
model spend, and it is exactly what CI runs, so there is no gap between what you
can verify and what the pull request will be judged by.

```bash
pnpm run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, or `opencode`. You need that harness installed at the
exact version the adapter names as its reference build; the test fails loudly if
the installed version differs. Full details in
[`docs/testing.md`](docs/testing.md).

There is a third tier, `HOOKNOSTIC_SMOKE=<harness> pnpm test`, which uses a real
model and spends real credits. It is for deliberate recapture and behavioural
validation. **It is not expected of contributors** and never runs in normal CI.

### A new test must be shown to fail

If you are fixing a defect, prove the test you added actually pins it: revert
your fix (or apply a small mutant), watch the test fail, then restore. Paste that
failing output into the pull request.

This is asked of everyone, including the maintainer, for a concrete reason —
this repository's history contains five tests that passed against the exact bugs
they were written for. A test that has never failed has not been shown to test
anything.

### Generated output is generated

- Committed example artifacts (`examples/rewrite-shell/dist`,
  `examples/agent-plugin/dist`) must be rebuilt **from the repository root** in
  the same change as any source affecting them. CI byte-compares them.
- `docs/harness-support.md` is generated from adapter metadata by
  `node scripts/generate-harness-support.mjs`. Never edit it by hand; change the
  metadata and regenerate.

Never hand-edit anything a build produces.

## Showing your work

When a capability is not what you expected, start from what the adapter already
says about it:

```bash
hooknostic inspect codex --capability turn.stop.notify
```

That prints the adapter's own rationale, version-scoped. Quote it in your issue.
Often it turns out the limitation is the harness's, not Hooknostic's — in which
case that output is the thing to take to the harness's own issue tracker, and
we will happily help you word it.

## Adapters are a standing commitment

New harness adapters are genuinely welcome, and the path is documented in
[`docs/adding-an-adapter.md`](docs/adding-an-adapter.md). Please start a
Discussion before building one, because an adapter is not a one-time
contribution. It carries:

- captured fixtures for every event it advertises, each with a provenance row;
- a capability profile whose every entry has a `validatedOn` record, at least one
  of them `captured`;
- harness metadata (recommended range, reference build, fixture directory);
- all ten obligations in the testkit's adapter contract suite;
- registration in the CLI registry and in the shim bundler;
- a playback lane pinned to the adapter's reference version;
- and **ongoing re-capture** as that harness ships new versions — the part that
  does not end.

That last item is the real cost, and it lands on the maintainer after your pull
request is merged. Being upfront about it is not discouragement; it is so we can
decide together whether the adapter has someone behind it for the long run.

**Out-of-tree adapters are not supported today.** The CLI can technically be
driven with a custom registry, but the `HarnessAdapter` contract lives in
`@hooknostic/core` and the conformance suite in `@hooknostic/testkit`, and
neither package is published — so there is no typed contract and no way to prove
an external adapter correct. Making them first-class is a real possibility after
1.0; say so in a Discussion if you want it.

## Conventions

- Match the surrounding code: its naming, its comment density, its idiom.
- Formatting is mechanical and enforced: run `pnpm format` (Prettier,
  `printWidth: 120`), and let ESLint's `simple-import-sort/imports` rule order
  imports — `node:` builtins, external packages, `@hooknostic/*`, then
  relative. Markdown and YAML are deliberately outside Prettier's scope; do
  not add them back without revisiting that decision (see `.prettierignore`).
- Leave a short comment where you made a judgement call — an ambiguous fix, a
  non-obvious guard, a choice between two plausible approaches. Skip it where the
  code speaks for itself.
- Prefer the smallest correct change. Refactors bundled into a behavioural fix
  make both harder to review.
- **Do not name downstream consumers of Hooknostic** — not in code, docs, commit
  messages, or capture records; write "a consumer". Adapters are justified by
  captured harness evidence, never by one user's needs, and keeping consumers
  anonymous keeps that honest.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the [Apache License 2.0](LICENSE), the same
licence the project ships under.

## Repository-local contributor workflow

1. Install the repository's locked dependencies with `pnpm install --frozen-lockfile`.
2. Edit portable hooks, skills, or MCP declarations.
3. Run `pnpm exec hooknostic sync --config hooknostic.config.ts`.
4. Review the generated files and `.hooknostic/integration.json` together.
5. Run `pnpm exec hooknostic verify --config hooknostic.config.ts` before committing.

Commit generated integration artifacts and ownership state. Dependency installation,
server approvals, project trust, and harness restarts remain explicit human steps.
The synthetic [local project example](examples/local-project/README.md) demonstrates
this workflow without downstream policies or a package manifest.
