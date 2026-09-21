# ADR-0013: Explicit executable files and portable permission digests

Status: accepted; amended 2026-09-21 to cover direct skill sources

## Context

Agent Plugin inventory formerly copied host permission bits into files and
source/projection digests. A Windows-mounted checkout can report every file as
0777 while a Linux checkout of identical Git contents reports 0644. This broke
committed example reproducibility and made release identity depend on the host.

## Decision

`LoadAgentPluginOptions.executableFiles` and the SDK's
`agentPlugin.executableFiles` declare exact, case-sensitive POSIX paths relative
to the package root. An entry must name an included regular file, including a
safe dereferenced file link. Absolute paths, backslashes, control characters,
colon/drive paths, empty segments, `.`/`..` segments, missing paths, directories,
excluded paths, and case mismatches fail loading. Entries are literal names,
not globs. Duplicate declarations are harmless.

Direct skill sources (`components.skills`) accept the same declaration under the
same validation, spelled `<skill>/<path>`: the path the file is projected to,
which is also the path it was read from, because a skill's `name` must equal its
own directory. Entries are resolved once every configured skill collection has
loaded, so one declaration reaches all of them. A direct MCP source alone is
rejected — it is a single document, with no tree an entry could name.

The declaration cannot reach a skill a target discovers already in its own
destination, and Hooknostic must not make it. This rule is a pair — 0755 on
declared files *and* 0644 on every other file, ignoring host permissions — and a
tree Hooknostic does not own holds files whose executable bit the author set and
Git records. Applying the rule there would strip those bits; applying half of it
would make one declaration mean two things. So the mode is left as checked in
and the build warns (**HN104**), naming the target: the same declaration is
usually live on the targets that do copy the skill. Claude discovers
`.claude/skills` in place, Codex and OpenCode `.agents/skills`, so at most two of
the three are ever affected by one source directory.

Inventory assigns 0755 to declared files and 0644 to every other file, ignoring
host permissions. Source and projection digests retain modes as inputs, now
using these canonical modes. Projector-generated executables continue to use
explicit artifact modes. No Git checkout or host-specific executable inference
is required, and copied file bytes and raw plugin data remain unchanged.

## Migration and consequences

Authors who previously relied on `chmod +x` must list those files explicitly.
Omitting the option makes all inventoried files non-executable. Sources and
build reports must be regenerated; old digests are not expected to match.
Windows, Linux, and macOS produce the same reports and artifact bytes from the
same sources and configuration. Actual enforcement of POSIX bits still depends
on the destination filesystem.
