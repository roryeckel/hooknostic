# Decision 0019 — Harness deviations from Agent Plugins are declared, reported, and optionally fatal

**Status:** Accepted — 2026-09-21 · Referenced from code and docs as **ADR-0019** · Refines the fifteenth amendment of [ADR-0011](0011-agent-plugin-native-projection.md)

**In short:** When a harness treats some emitted component differently from what
Agent Plugins 1.0 says, and Hooknostic does not correct it, that is a
**deviation**. Each one is declared on the adapter's profile, with the capture
that established it. A projection reports every instance as `HN106`.
`components.onDeviation` decides whether that warns (the default) or fails the
build (strict mode). Nothing is omitted either way.

## Context

Hooknostic already had three ways to say a package will not get exactly what
the specification says:

| Class | Meaning | Policy |
| --- | --- | --- |
| invalid | the package breaks the specification | `onInvalid`, HN503 |
| unsupported | a valid component cannot be emitted, so it is omitted | `onUnsupported`, HN205 |
| below minimum | the whole component is delivered at a lower fidelity level | `compatibility.minimum`, HN206 |

Claude's native `.mcp.json` fits none of them
(`.capture/agent-plugin-mcp-placeholders`,
`.capture/claude-project-mcp-environment`). Claude substitutes any set
environment variable into MCP configuration text: the stdio command, args, env
values and cwd, and remote urls and header values. It applies the
`${NAME:-default}` form as well. The specification expands only
`${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, and only in args, env values and cwd.

That behavior does not fit the existing classes:

- **It is not a level.** A package with no such text gets exactly what the
  specification says. Downgrading the component would misreport every other
  package.
- **It is not unsupported.** ADR-0011's fifteenth amendment decided to emit these
  servers, because hiding the text from Claude cost every package its native
  declaration.
- **It is not invalid.** The package is conformant; the harness is not.

Before this record, the Claude projector reported it as an `HN205` warning it
raised itself. Project delivery instead omitted a package remote server
containing a reference. The same harness fact produced two different outcomes
depending on the route, and neither could be made fatal on its own.

## Decision

- **A deviation is a profile fact.** `AgentPluginComponentSupport.deviations` lists
  `{ id, summary, evidence }` beside the level.
  - The id is stable, kebab-case, and unique within the adapter. It is
    qualified as `<adapter>:<id>` wherever users see it.
  - The evidence must be one of that profile's `validatedOn` artifacts, and the
    testkit contract enforces this.
  - Because the declaration sits on a versioned profile, a harness range that
    fixes the behavior stops declaring it, and the reports stop too.
- **Resolution combines deviations across profiles.** The level is still the least
  capable one in the range. The deviations are every intersected profile's,
  once each: a build ships into every version its range admits.
- **Projectors report instances; core applies policy.**
  - A projector puts `{ id, component, name, path, reason }` records in
    `summary.deviations`, and a project integrator puts them in
    `ProjectIntegration.deviations`. Neither raises an issue or picks a severity.
  - A projector reports only a deviation that `context.support` (or
    `ProjectComponentOptions.support`) declares for that component.
  - Core maps each record to `HN106`, with the declaration's summary and
    evidence as the rationale and `deviation` set to the qualified id.
  - A reported id the resolved cell does not declare is a projector defect.
    Core fails the target with `HN301` rather than showing users an unexplained
    warning.
- **`components.onDeviation: "warn" | "error"`, default `"warn"`.** `"error"` is
  strict mode: `check` and `build` fail rather than ship a package that behaves
  outside the specification on some target. There is no omit option, because
  silently changing what ships is the outcome ADR-0011 rejected.
- **The build report records instances.** `projection.deviations` and
  `project.deviations` sit beside `omissions`, with qualified ids, so CI can read
  them without parsing diagnostics. `inspect` and the generated
  `docs/harness-support.md` list the declarations.
- **The first declaration is `claude:mcp-environment-expansion`.** It is declared
  on package projection for all three MCP components, and on project delivery
  for the two remote ones. Project stdio servers launch from an opaque document
  that Claude never expands, so they need no declaration (see "Delivery routes"
  below).
  - Only a package's text is governed: a direct source's `${NAME}` is a request
    that Claude is meant to resolve.
  - Header names are not covered. Claude keeps them literal and refuses the
    brace as an invalid name, which is conformant.

Two changes follow from treating the specification as the reference rather
than the loader's former caution:

- **A package's stdio `command` may contain `${...}`.** The schema admits any
  non-empty command, and the specification never expands one, so the loader
  now carries it as literal text. Codex and OpenCode launch it literally
  (captured). Claude expands it, which is the deviation above. A direct source
  still refuses one, because its other fields do expand and a literal command
  would surprise its author.
- **Claude's projector no longer translates `${PLUGIN_ROOT}` inside a bare
  command.** A command is literal under the specification, so the translation
  was performing an expansion the standard forbids.

## Delivery routes

Claude's two delivery routes treat a package's stdio text differently. This
record keeps it that way.

- **Package delivery** declares each server natively, and translates
  `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` to Claude's own variables. Claude then
  expands the rest of the text as well. That is the deviation.
- **Project delivery** has no such variable. A project `.mcp.json` names neither
  the project nor a package root.
  - Claude does not expand `${CLAUDE_PROJECT_DIR}` there, although it sets that
    variable for the child (`.capture/claude-project-mcp-environment`).
  - So the generated launcher resolves the package's paths from its own
    location and reads the server from its document.
  - Claude never sees the package's text, which reaches the server literally.
    That conforms.

Remote declarations are native on both routes, so both routes report the
deviation for them.

Making the routes agree would take one of two changes, and both are worse than
the difference:

- **The project launcher could expand `${NAME}` itself.** Hooknostic would then
  reproduce the harness's deviation in its own code, on a route that currently
  meets the specification.
- **The project declaration could be shown to Claude.** That needs a spelling
  of the package root that Claude leaves alone, and there is none. Claude
  expands any `${...}` placeholder whose variable is set in its environment, so
  every server that uses `${PLUGIN_ROOT}` would be exposed to an ambient value.

A publisher who wants the specification's behavior on both routes sets
`components.onDeviation: "error"`. The package route then fails for exactly the
servers whose text would differ.

## Rejected alternatives

- **A per-target `onDeviation`, or acknowledging individual deviations**
  (`allow: ["claude:mcp-environment-expansion"]`). Both are plausible, but no
  one has needed either yet. The stable qualified ids exist so that either can
  be added without renaming anything.
- **Folding strict mode into `compatibility.minimum: "exact"`.** `emulated`
  still conforms, because Hooknostic implements the specification's behavior on
  the harness's behalf. A deviation does not conform. A package author can
  reasonably accept one and refuse the other.
- **Keeping HN205.** It means "component unsupported" and marks a component as
  skipped. Reusing it for an emitted component made the report contradict
  itself, and it could not carry its own policy.

## Consequences

- Strict mode fails the Claude build for any package whose MCP text contains a
  `${NAME}` other than the two plugin placeholders on stdio fields. That is the
  intended use: a publisher who wants the specification's behavior everywhere
  finds out before release.
- A new deviation is a capture, a profile declaration, and a detector. It is
  never a new policy or diagnostic code. `docs/adding-an-adapter.md` states the
  rule for telling a deviation from a level.
- Project delivery no longer omits Claude package remote servers that contain
  references. Under the default policy they are now emitted with a warning,
  which matches package delivery.
