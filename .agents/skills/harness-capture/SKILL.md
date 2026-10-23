---
name: harness-capture
description: Capture real harness behavior before implementing against it. Use when adding or changing any claim about Claude Code, Codex, or OpenCode — hook payload fields, tool argument shapes (ShellShapes, FileShapes, toolmap, tool.shell, tool.file), which tools a harness advertises, whether a wire channel (updatedInput, systemMessage) is honoured, which interpreter or shell dialect a shell tool runs (.capture/shell-dialects), whether a harness loads another harness's files (`.claude/settings.json`, `.claude/skills`, `.mcp.json`) — or when adding fixtures under fixtures/<harness>/, editing a provenance README, working in .capture/ (including .capture/file-tools), or verifying an adapter claim live.
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
  timing) must be observed on live objects, not inferred from types. The
  advertised tool set depends on the model id (a GPT-like id swaps
  `edit`/`write` for a patch tool), so discover under more than one id.

**Tool-argument captures need no model spend.** `.capture/file-tools/drive.mjs`
runs the real binary against the loopback playback model, discovers the
advertised tools and their live argument keys, and scripts one call per case
(`TurnAction.arguments`, or `freeformInput` for a grammar tool like Codex's
`apply_patch`). The hook payload is **captured**; say in the provenance row
that the argument *values* were scripted. Its README is the worked example.

**A payload cannot show which interpreter ran.** A shell tool's grammar is
established by the process that executed the command, observed under each host
configuration that could change it, and compared with whatever the harness
states about its shell. `.capture/shell-dialects` is the procedure: process
ancestry on three platforms, a host-configuration comparison, a per-build mode,
and fixture promotion. Its Linux half ran in a container as an unprivileged
account. Give any scratch `npm install` an explicit `--prefix`: without one
npm installs into the nearest ancestor that has a `package.json`.

**Probe foreign reads in both directions.** A harness may load another
harness's project files as a compatibility feature, and then run that target's
output in a form it only approximates (ADR-0033). For each foreign location,
put a marker entry in a scratch project and observe whether it runs. Then try
an opt-out key on the reader, and capture the owning harness with the same key.
Both halves are required, and each is observed by effect: the reader skips it,
and the owner still runs it with the rest of the file applied. Startup events
such as `SessionStart` fire before any model request, so these probes need no
credential. The worked pair is `.capture/copilot/claude-settings-probe.sh`
(reader) and `claude-tolerance-probe.mjs` (owner).

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
   contract suite picks up shell- and file-bearing fixtures automatically
   (codec obligations, and every table entry needs such a fixture).
3. Shape claims go in the adapter's `toolmap.ts` `ShellShapes` or
   `FileShapes` table (ADR-0007, ADR-0026) with a comment naming the fixture. **A tool whose shape you have no evidence for
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
   `node scripts/generate-harness-support.mjs`. **One exception to
   append-only**: the marker-delimited scheduled-playback region in each
   profile holds a single rolling record that
   `scripts/record-playback-validation.mjs` rewrites in place — never edit it
   by hand; the policy is ADR-0009.
6. Never name downstream consumers in capture records (see `AGENTS.md`).
