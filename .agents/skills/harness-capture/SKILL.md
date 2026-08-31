---
name: harness-capture
description: Capture real harness behavior before implementing against it. Use when adding or changing any claim about Claude Code, Codex, or OpenCode — hook payload fields, tool argument shapes (ShellShapes, toolmap), whether a wire channel (updatedInput, systemMessage) is honoured — or when adding fixtures under fixtures/<harness>/, editing a provenance README, working in .capture/, or verifying an adapter claim live.
---

# Harness capture

The repository's core discipline: **capture first, then implement.** Every
adapter claim points at evidence, and the evidence class is recorded. The
pilot port found four doc-drift defects in one pass that only capture
revealed; the one guess that slipped through (a tool argument key) produced a
guard that compiled clean and silently allowed a whole harness's shell calls.

## Provenance classes (record one per fixture, in that directory's README)

| Class | Meaning | Trust |
|---|---|---|
| **captured** | Verbatim payload from a live harness session, with version and date | Full |
| schema-derived | Built from wire schemas extracted from the harness binary | Shape only, not behavior |
| doc-derived | From vendor docs | Weakest — docs drift; three adapters found doc drift only capture revealed |
| constructed | Assembled (e.g. log-derived args in a schema-derived envelope) | Say exactly what was observed and what was not |

Upgrading a claim's provenance (doc-derived → captured) is always worth a
commit. Downgrading one honestly (a "capture" that turns out constructed) is
worth more.

## Per-harness recipes

Each `.capture/<harness>/README.md` is authoritative; the short version:

- **Claude Code** — `.capture/claude` is a teeing project (every hook appends
  stdin to `captured/<Event>.jsonl`). Drive it headless:
  `claude -p "<prompt>" --model sonnet --dangerously-skip-permissions` from
  that directory. Hook payloads carry the tool input **verbatim**, so a tool
  capture is just a PreToolUse capture.
- **Codex** — `.capture/codex` is the teeing project. Gotchas that have each
  cost a session: repo-level `.codex/hooks.json` loads only in **trusted**
  projects (untrusted → hooks silently don't fire, no error); trust is
  per-entry (hash in `~/.codex/config.toml`), and an edited entry needs
  `--dangerously-bypass-hook-trust`; on Windows,
  `[windows] sandbox = "unelevated"` must be set or every spawn is policy-
  rejected — and the harness may still *report success*; `codex exec` reads
  its prompt but hangs without stdin EOF (`< /dev/null`). Tool arguments are
  also visible one level below hooks via
  `RUST_LOG=codex_core=debug codex exec …` — the router logs `ToolCall:` and
  the exact spawned command line *before* sandbox rejection, which makes both
  tool-args capture and write-path verification possible in a restricted
  environment (`.capture/codex-tools/README.md`).
- **OpenCode** — in-process: a capture plugin receives live objects
  (`.capture/opencode*`). Behavioral facts (in-place args mutation, event
  timing) must be observed on live objects, not inferred from types.

## The router/hook-boundary distinction (Codex)

The shape a harness uses internally is **not** necessarily the shape hooks
receive: Codex 0.151 routes `exec_command {cmd, workdir}` but presents the
hook a translated `Bash {command}` payload with `workdir` dropped. So: a
router-log capture is evidence about the router, a hook capture is evidence
about the hook boundary, and only the latter is what adapters decode. File
them as different provenance.

## Verify effects by effect, never by harness output

Codex prints `hook: <Event> Completed` for hooks it skipped. To prove a write
channel is honoured, make the effect observable: rewrite a command to one that
writes a marker file, or read the spawned command line from the debug log.
"The harness didn't complain" is not evidence.

## Where results land

1. `fixtures/<harness>/<version>/<case>.{input,canonical}.json` + a provenance
   row in that directory's README. Canonical = decode result minus `raw`.
   **Redact the capturing account name to `user` before committing** — this is
   a public repository and every payload carries a home directory. Redact only
   that segment: the drive letter, backslash escaping, and any derived form
   (Claude's mangled `C--Users-user-…` project directory) stay intact and
   mutually consistent, because path *shape* is evidence. Input and canonical
   must move together. The README's redaction note already covers it; say so
   again only if you redact something new.
2. Wire the case into the adapter's `decode.test.ts` list; the testkit
   contract suite picks up shell-bearing fixtures automatically (codec
   round-trip obligation).
3. Shape claims go in the adapter's `toolmap.ts` `ShellShapes` table with a
   comment naming the fixture. **A tool whose shape you have no evidence for
   stays absent from the table** — absence is the documented fall-back
   signal. One carved exception: router-log provenance (a shape observed one
   level below the hook boundary, never in a hook payload) is admissible as
   *defensive* coverage — reading the wrong-but-real keys is harmless, and
   dropping a security-relevant entry on the strength of not having seen it
   is the wrong direction — but the entry's comment and its fixture's
   provenance row must both say so (see Codex `exec_command`, ADR-0007).
4. A novel *procedure* (not just a payload) gets its own `.capture/<name>/`
   directory with a README recording question, method, observation, and
   consequences.
5. **Append a `ValidationRecord`** to the relevant profile's
   `source.validatedOn` (`packages/adapter-*/src/profile.ts`): version, date,
   method (the classes above map one-to-one), evidence path, and one line of
   what the session established. The contract suite requires the record's
   version to fall inside a profile range, and `doctor`/`inspect`/the
   generated `docs/harness-support.md` all read it -- a capture session that
   skips this step is invisible to every consumer surface. Then rerun
   `node scripts/generate-harness-support.mjs`.
6. Never name downstream consumers in capture records (see `AGENTS.md`).
