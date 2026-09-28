# Decision 0026 — A normalized, read-only view of the files a tool targets

**Status:** Accepted — 2026-09-27 · Referenced from code and docs as **ADR-0026**
**Builds on:** ADR-0007 (portable shell write-back): the same shape-table codec,
applied to file tools, read side only.

**In short:** `event.tool.file?.paths` lists the files a file tool is about to touch,
on every harness whose tool shape has been captured. It is a list because one Codex
patch can touch several files. When the view is absent, fall back to `tool.input`,
exactly as with `tool.shell`.

## Context

`kind: "file.read"` was portable but the arguments were not. A file tool names its
target `file_path` on Claude Code, `filePath` on OpenCode 1.x and `path` on OpenCode
2.x. Codex has no path argument at all: its `apply_patch` hook payload is
`{ command: <patch text> }`, and the paths live inside the patch
(`.capture/file-tools/README.md`). A guard that matched `file.read` and read
`input.file_path` compiled, checked and matched everywhere, and it silently allowed
every call on the harnesses that spell the key differently. The repository's own
combined example shipped exactly that guard. It is the bug class ADR-0007 fixed for
shell commands.

## Decision

1. **One shape table per adapter, captured entries only.** `FileShapes` maps a native
   tool name to `{ pathKey }` (an argument that names one file) or `{ patchKey }` (an
   argument holding patch text). `fileCodec()` derives `tool.file` from it. A tool
   whose shape is uncaptured is absent from the table, so its view is absent rather
   than guessed. The contract suite requires every table entry to be backed by a
   fixture carrying the view, and every such fixture to re-classify to it.
2. **Plural.** `paths` is a list in the order the tool names them, de-duplicated. A
   path-argument tool yields one path. A patch yields every `Add`, `Delete`, `Update`
   and `Move to` target. A singular field would have needed a breaking change the
   first time a multi-file tool mattered, and on Codex that is every edit.
3. **Verbatim paths.** Paths are reported as the harness sent them: absolute on
   Claude, relative to the session's working directory in a Codex patch. Resolving
   them would mean assuming each harness's base directory, which no capture
   establishes.
4. **Strict patch parsing.** `parsePatchPaths` accepts the grammar Codex ships
   (`codex-rs/core/assets/tools/apply_patch.lark`), and captures show OpenCode's
   `apply_patch` (1.x) and `patch` (2.x) tools use the same grammar. It follows
   the parser Codex actually runs rather than the lark file: headers are matched on
   the trimmed line, and a patch with no file operation targets nothing (`[]`).
   Anything off-grammar returns `undefined`, and so no view: a missing
   `*** Begin Patch` or `*** End Patch`, an unknown bare `***` line, or a `Move to`
   that does not directly follow an `Update File`. A partial view would be the lie
   this design exists to avoid.
5. **Read side only.** There is no portable file-rewrite effect. Nothing needs one yet,
   and rewriting a patch's paths is a different operation from rewriting a path
   argument. `replaceInput` remains the write path, and `pathKey`/`patchKey` expose
   the native key as data, the way `commandKey` does.
6. **Never stale.** Every input rewrite re-derives `tool.file`, and deletes it when
   the new input no longer classifies (ADR-0007 decision 6).
7. **No capability.** Whether a view exists depends on the individual call, like the
   shell view. A build-time matrix cannot hold that, so hooks feature-detect by
   testing `tool.file !== undefined`.

## What the view does not cover

- **Search tools.** `glob`, `grep` and Claude's `Glob`/`Grep` name a pattern and a
  directory, not a file, and have no view.
- **File access through the shell.** A shell command that reads or writes a file
  (`cat .env`) is a shell call, not a file call. On Codex every read goes through the
  shell. Guarding those is shell parsing, which Hooknostic does not normalize.
- **Uncaptured shapes.** Claude's `MultiEdit` (not advertised on 2.1.283) and Codex's
  alias names (`Write`, `Edit`, `Read`, which are never payload names) have no view.

## Consequences

- A file guard is portable where the shapes are captured, and absence makes the
  remaining gap visible in code rather than silent: the hook chooses to fail open or
  closed when `tool.file` is undefined.
- Capturing the shapes also found two misclassifications. OpenCode 1.x's
  `apply_patch` was split as an MCP tool, and 2.x's `patch` was `other`. Under
  GPT-like models, where these tools replace `edit`/`write`, a `file.edit` matcher
  never fired. Both are now `file.edit`.
