# ADR-0033: Each harness runs only the output generated for it

## Status

Accepted, 2026-10-21. Complements ADR-0030, which composes edits in a location
several harnesses natively share; this record covers a harness reading another
harness's own configuration.

## Context

Harnesses increasingly read each other's configuration so a repository works
without porting. GitHub Copilot CLI reads Claude Code's `.claude/settings.json`
and `.claude/settings.local.json` hooks, `.claude/skills`, and a root
`.mcp.json` beside its own `.github/` files (`.capture/copilot/README.md`).

That compatibility read is a second, unrequested delivery of another target's
output, in a format the reader only approximates. A consumer smoke test found
the cost. Copilot ran Hooknostic's Claude hook entry, `{command: "node", args:
[dispatcher]}`, as a shell command and ignored `args`. The bare `node` exited 1,
and on `preToolUse` Copilot fails closed, so it denied every shell call in a
project that also had Claude hooks. A teammate using Copilot on a repository
configured only for Claude would have hit the same failure. Even a reader that
honoured the entry would run the Claude dispatcher, decoding a payload shaped
for Copilot and then running a second dispatch beside Copilot's own target.

The reader's approximation is not captured evidence about either target. It
changes between releases, and it bypasses the capability matrix that a build
resolved for each target.

## Decision

1. **A harness runs only the artifacts generated for its own target.**
   Hooknostic never relies on a compatibility read as a delivery channel, and
   never lets one dispatch a second time beside the reader's own target. That
   holds whether or not the reading harness is a configured target.
2. **When a harness reads another target's generated location, opt it out.**
   Prefer a native mechanism that makes the reader skip the content while the
   owning harness is unaffected, and prove it on both harnesses by effect. The
   Claude project entry carries a non-numeric `timeoutSec`: Copilot then drops
   the whole `hooks` field of that file, while Claude 2.1.238 and 2.1.306 ignore
   the key and still run the entry.
3. **Otherwise, avoid the location.** Write the owning target's output where
   the reader does not look, if the owning harness supports such a location.
4. **If neither works, do not ship it silently.** A build whose output a
   configured or common reader would misread reports it, with the evidence, as
   a shortfall under ADR-0022 rather than passing as `exact`.
5. **Every adapter capture inventories foreign reads.** Probe which other
   harnesses' project locations the harness loads, and in what form. A marker
   per location is enough; a model is rarely needed. An opt-out is pinned by a
   cross-adapter test that checks the owning target's generated output against
   the reader's captured rules, with a control showing the reader would
   otherwise consume it.

A location that several harnesses each read as their own native standard is
out of scope. `.agents/skills` for Codex, OpenCode and Copilot is one; ADR-0030
composes their edits. The test is whose format the content is in: a shared
standard has one meaning for every reader, and a foreign file has its owner's.

## Consequences

- Hooknostic's guidance stops assuming that one target's output is invisible to
  another harness; the default is that it may be read and must be fenced.
- An opt-out also hides the user's own content in the same file from the reader.
  Hand-written hooks in `.claude/settings.json` no longer run under Copilot. That
  is documented; it is the cost of not running Claude-format hooks in a harness
  that only approximates them.
- Known instances on Copilot 1.0.101. The `.claude/settings.json` hooks are
  fenced. `.claude/skills` and the root `.mcp.json`, which Claude's project
  target writes, are read by Copilot too, and still need the probe in decision 5.
- Opt-out markers depend on two harnesses' validators. The harness-watch lanes
  replay each adapter, and the cross-adapter test fails if a reader's captured
  rules start accepting the marker.
