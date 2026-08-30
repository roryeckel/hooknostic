# 0007 — Portable shell write-back

**Status:** accepted (2026-08-30)

## Context

B5 of the pilot-blocker pass normalized the *read* side of shell invocations:
`event.tool.shell.command` works on every captured shape, because the harnesses
disagree about the key (`command` for Claude's `Bash`, `cmd` for Codex's
`exec_command`). Writing back stayed native-only: `replaceInput` takes the whole
native input object, so tutorial 02 taught
`replaceInput({ ...input, ["cmd" in input ? "cmd" : "command"]: next })` — adapter
knowledge restated in user space, unversioned and untested.

Two designs were weighed: a full portable patch effect
(`updateShell({ command?, cwd? })` with a `shell.writable` field and a new
partial-application diagnostic), and a data-only minimum (expose the native key
as `shell.commandKey` and keep `replaceInput` the sole write path). The decision
is between them: a **command-only** effect plus the keys as escape-hatch data.

Evidence gathered before deciding (`.capture/codex-tools/README.md`):

- Codex **honours `updatedInput`** from a PreToolUse hook — verified live on
  0.151.0 by observing the rewritten command reach the process spawn.
- Codex's hook boundary **translates**: an `exec_command` router call reaches
  the hook as `tool_name: "Bash"`, `tool_input: { command }`, with `workdir`
  dropped entirely.

## Decision

1. **One shape table per adapter drives both directions.** `ShellShapes`
   (`{ commandKey, cwdKey? }` per native tool name) feeds `shellCodec()`, whose
   `classify` builds `event.tool.shell` and whose `encode` lowers the portable
   write. Reverting a table key fails the decode fixtures and the rewrite
   roundtrips together — the two directions cannot skew. A name absent from the
   table declines both ways: uncaptured shapes are never guessed.
2. **`updateShell({ command })` is command-only.** `cwd` is unrepresentable on
   two of three targets, unobservable at Codex's hook boundary, and has no
   consumer. Cutting it removes the `writable` field, the partial-application
   diagnostic, and the empty-patch rule in one stroke. The patch-object
   signature leaves room to add it without a break.
3. **Lowering happens in dispatch,** which alone holds the live `tool.input`, the
   declaration order, and the HN401 validation ladder. The portable effect and
   its synthesized `replaceInput` (marked `loweredFrom`) land as adjacent
   entries in `result.effects`, so every `apply()` keeps resolving the last
   `replaceInput` with no knowledge of the new kind, mixed
   `updateShell`/`replaceInput` orderings compose in one ordered list, and all
   existing output fixtures are byte-identical.
4. **No new capability id.** `updateShell` rides `tool.before.input.replace`: it
   is the same wire channel, and the extra requirement — is *this invocation's*
   tool shape captured? — is per-invocation data no build-time matrix can hold.
   A dedicated id would rate `"exact"` on all three profiles and convey nothing.
   The runtime contract is instead: legal iff
   `ctx.capabilities.has("tool.before.input.replace")` **and**
   `event.tool.shell !== undefined`; violations are HN401.
5. **`encode` declines exactly when `classify` does** (shape known, input a
   plain object, command key currently a string), so `event.tool.shell` being
   defined stays the one feature-detect signal for reading and writing alike.
6. **Every input rewrite re-derives the shell view.** `replaceInput` previously
   left `tool.shell` describing the pre-rewrite command for later hooks in the
   same dispatch — a rewrite could smuggle a command past a later guard. Now
   `setToolInput` re-classifies through the codec; when the replacement no
   longer classifies (or no codec exists), the view is deleted, never stale.
7. **The raw escape hatches survive, upgraded.** `replaceInput` stays verbatim
   for uncaptured shapes and out-of-view keys, and `shell.commandKey`/`cwdKey`
   expose the adapter's key knowledge as data so a hand-built input need not
   restate it.

## What stays non-portable

- Tools whose argument shape is uncaptured (Codex's and OpenCode's tools named
  `shell`): `updateShell` is HN401 there until someone captures the shape.
- Non-shell tools, key deletion or renaming, and native keys outside the
  normalized view — spread the input and use `replaceInput` with `commandKey`.
- The working directory. Do **not** emulate it by rewriting the command to
  `cd <dir> && <cmd>`: that changes shell semantics, quoting, and exit-code
  propagation — exactly the guess the additive-normalization invariant forbids.
- `replaceOutput` has no portable counterpart, deliberately: Claude has no
  replacement channel, Codex replaces MCP outputs only, OpenCode
  string-coerces. There is no captured cross-harness output shape to table.

## Enforcement

`describeAdapterContract` asserts, for every canonical fixture carrying a
`tool.shell` view, that the adapter's `shellCodec` re-classifies the fixture's
own input to that view and round-trips an encoded command patch. Two-way
consistency is an adapter obligation, not a first-party habit.
