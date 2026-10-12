# 0030 — A skill declares whether it permits implicit invocation

Status: accepted. Date: 2026-10-11.

## Context

[Issue #28](https://github.com/roryeckel/hooknostic/issues/28) asks for portable
skills that require explicit user invocation. Native frontmatter alone fails
Agent Skills validation in packaged sources, and the harnesses consume different
settings. Project sources may already occupy a native discovery directory, and
Codex and OpenCode share `.agents/skills`. A missing gate must not silently turn
an explicit-only skill into an automatically selected one.

Scope follows [CONTRIBUTING](../../CONTRIBUTING.md). Captures and their limits
live in [.capture/skill-invocation](../../.capture/skill-invocation/README.md).

## Decision

A skill may declare string-valued metadata:

```yaml
metadata:
  hooknostic/allow-implicit-invocation: "false"
```

Only the strings `"true"` and `"false"` are valid. The loader exports an optional
`SkillPolicy.allowImplicitInvocation` boolean on packaged and direct skill
records. Packaged frontmatter remains strict. An invalid portable policy is an
error even under `components.onInvalid: "warn"`. Absence preserves authored
native behavior.

`false` withholds automatic model selection while retaining native explicit user
invocation. It is a discovery policy, not access control: some harnesses still
permit a forced tool call or direct file read. The separate component capability
`agent-plugin.skills.invocation-policy` describes the gate, independently of
whether the skill itself can be delivered. Uncaptured older versions are rated
unsupported; version facts and provenance remain in adapter validation records.

Claude projects `disable-model-invocation`, Codex merges
`policy.allow_implicit_invocation` into `agents/openai.yaml`, and OpenCode v2
uses `metadata["opencode/autoinvoke"]` for discovered skills and `autoinvoke`
for registered package skills. The captured v1 route supplies a named
`permission.skill` deny/allow rule from the generated config callback; deny
withholds model loading but retains explicit slash-command invocation. This
translation is rated emulated.

Canonical portable policy wins after native overlays. Projection preserves
unrelated YAML values, comments, file modes, and SKILL.md body bytes. Removing
the declaration regenerates from authored input, restoring authored native
settings. Authors use neutral sources such as `skills/`; generated native copies
are owned and checked for drift.

Core composes file edits for every configured reader of a shared destination
before emission. An unaccepted omission removes the shared copy for all readers
and is reported for each affected target. An existing unowned native copy cannot
be overwritten or called omitted. A source already inside a native discovery
directory is left untouched, with an error directing the author to move it.
This includes captured alternate paths, nested collections and conservative
ancestor-path ownership checks; a copy cannot establish ownership of its source.

Configured project readers participate even when `components.targets` excludes
them: that setting cannot stop a harness discovering the shared directory.
Only declared shared skills and their policy are integrated for such readers;
their MCP, runtime packages, and client extensions retain the configured scope.

An unavailable gate fails by default. `components.onUnsupported: "warn"` omits
the whole affected skill. Ungated emission requires named acceptance:

```ts
components: {
  skills: ["./skills"],
  accept: ["example:skill-implicit-invocation-unenforced"],
}
```

`<adapter>:skill-implicit-invocation-unenforced` accepts an unavailable native
gate. `<adapter>:skill-policy-in-place` accepts leaving an in-place source
unchanged. They apply to affected skills on that adapter, bypass only that
policy shortfall and its compatibility rejection, retain the actual support
rating, and report an accepted HN101 degradation. Reports count a delivered
skill separately from a skipped policy. Neither generic warnings nor one
acceptance authorize another shortfall, invalid input, or ownership conflicts.

## Consequences

One declaration travels with the skill across both delivery routes. Existing
skills without it keep their native behavior. Builds selecting broad ranges may
need narrower evidence-backed ranges to enforce a gate; `inspect` explains the
resolved capability and shortfall IDs.

Command-menu visibility remains deferred until captures show a useful equivalent
on at least two harnesses. Presentation, tool grants, and execution settings are
outside this decision.
