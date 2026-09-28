# File-tool hook payloads

**Question.** What argument key does each harness use for the file a file tool
targets, as a hook receives it? The adapters classified file tools by name
(`kind: "file.read"` and so on), but no fixture outside Claude's `Read` and
OpenCode v2's `read`/`write`/`edit` showed the arguments. A portable guard that
reads one harness's key (`file_path`) therefore compiled everywhere and matched
nothing on the others: the combined example's `.env` guard failed open on
OpenCode v2 this way.

**Method.** No model spend. `drive.mjs` runs the real harness binary against
the loopback playback model (`packages/cli/test/harness-playback.ts`), with the
committed tee templates attached (`.capture/claude`, `.capture/codex-capture`,
`.capture/opencode-capture`), reusing `scripts/drive-capture-session.mjs`'s
per-harness drives in fresh scratch directories.

1. A discovery turn records which tools the harness advertises and the argument
   keys of each tool's live schema (`captured/<harness>/discovery.json`).
2. Each case is one session in which the scripted model makes one call, or a
   `Read` first where Claude refuses an edit to an unread file. Its arguments
   are built from the discovered keys, never from remembered ones.
3. Codex's `apply_patch` is a freeform (lark-grammar) tool. The playback model
   emits it as a Responses `custom_tool_call` whose `input` is the raw patch.
4. OpenCode's tool set depends on the model id, so v1 is also discovered under a
   GPT-like id (`gpt-5-playback`). For v2, `.capture/opencode-v2/drive.mjs
   tools-patch` with `HKN_MODEL_ID=gpt-5-playback` does the same.
5. `promote.mjs` writes the reviewed payloads to `fixtures/` with the account
   name redacted, together with today's decoder output.

```text
node --experimental-strip-types .capture/file-tools/drive.mjs claude
node --experimental-strip-types .capture/file-tools/drive.mjs codex
# OpenCode v1 is not the globally installed opencode; put a 1.18 build first on PATH:
npm install --prefix <scratch>/opencode-v1 opencode-ai@1.18.31
PATH=<scratch>/opencode-v1/node_modules/.bin:$PATH HOOKNOSTIC_PLAYBACK_VERSION=1.18.31 \
  node --experimental-strip-types .capture/file-tools/drive.mjs opencode-v1
HKN_CAPTURE_ROOT=<dir> HKN_MODEL_ID=gpt-5-playback \
  node --experimental-strip-types .capture/opencode-v2/drive.mjs tools-patch
node --experimental-strip-types .capture/file-tools/promote.mjs <dir>
```

**Provenance.** The hook payloads are captured: the harness produced them at its
own hook boundary. The model side is constructed, so the argument *values*
(paths, patch text) are ours. The capture says which keys the harness accepted
and exactly what reached the hook. It says nothing about which optional keys a
real model tends to send.

## Observations (2026-09-27, Windows)

| Harness | Tool | Path at the hook boundary |
| --- | --- | --- |
| Claude Code 2.1.283 | `Read`, `Write`, `Edit` | `tool_input.file_path` (the harness adds `replace_all: false` to Edit) |
| Claude Code 2.1.283 | `NotebookEdit` | `tool_input.notebook_path` |
| Codex 0.156.1 | `apply_patch` | none. `tool_input.command` holds the whole patch; its `*** Add/Update/Delete File:` and `*** Move to:` lines name the paths |
| Codex 0.156.1 | `view_image` | `tool_input.path` |
| OpenCode 1.18.31 | `read`, `write`, `edit` | `filePath` |
| OpenCode 1.18.31 | `apply_patch` (GPT-like ids only) | none. `patchText` holds a patch in the same grammar |
| OpenCode 2.0.17 | `read`, `write`, `edit` | `path` (already captured) |
| OpenCode 2.0.17 | `patch` (GPT-like ids only) | none. `patchText` holds a patch in the same grammar |

Also observed:

- **Claude.** 2.1.283 no longer advertises `MultiEdit`.
- **Codex.** 0.156.1 has no dedicated read or write tool, so reads go through the
  shell. For every patch operation, including add, update with move, delete, and
  a patch touching several files, the hook payload is the same
  `{ command: <patch> }`.
- **OpenCode naming.** Both OpenCode families swap `edit`/`write` for a patch
  tool when the model id looks like a GPT model, and they name it differently:
  v1 calls it `apply_patch`, v2 calls it `patch`.

## Consequences

- `tool.file` is a normalized, read-only view (ADR-0026). It holds a list of
  paths, because a single patch can target several files. Its entries come from
  each adapter's captured shape table: a path-argument key, or a patch-text key
  parsed with the strict Codex grammar.
- OpenCode v1 split `apply_patch` as an MCP tool (server `apply`, tool `patch`)
  and v2 left `patch` as `other`. Under GPT-like models, a `match: { kind:
  "file.edit" }` hook therefore never saw an edit on either family. Both names
  are now `file.edit`.
- Codex's `Write`/`Edit`/`Agent` entries in `CODEX_TOOL_KINDS` are matcher
  aliases, never payload names. They stay as defensive entries, and the comment
  now says so.
