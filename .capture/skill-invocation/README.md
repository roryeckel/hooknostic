# Native skill invocation gates

Question: which native project-skill declarations affect model visibility, and
what happens when a gated skill is explicitly requested or its tool is forced?
This is evidence for [issue #28](https://github.com/roryeckel/hooknostic/issues/28),
within [CONTRIBUTING](../../CONTRIBUTING.md). It introduces no portable declaration,
capability, or projection policy.

## Method

Evidence class: **live-probe**, native Windows, 2026-10-04. The real harnesses
ran against the repository's loopback playback server. Replies and forced tool
calls were scripted, with no model credentials or model spend. The observations
are the actual request bodies sent by the harness, including its tool listing
and the subsequent tool result; they are not model-generated descriptions.

Each session creates a fresh temporary git project and redirects HOME,
USERPROFILE, CODEX_HOME, CLAUDE_CONFIG_DIR and XDG state/config/cache directories.
Only synthetic skills are added. Four controls have distinct description and
body markers; baseline sessions advertise all four. Gated sessions change:

- `gate-claude`: `disable-model-invocation: true` in SKILL.md frontmatter.
- `gate-codex`: `policy.allow_implicit_invocation: false` in the adjacent
  `agents/openai.yaml`.
- `gate-opencode`: `permission.skill.gate-opencode: deny` in opencode.json,
  for the two OpenCode lanes only.
- `gate-control`: unchanged.

Claude skills are in `.claude/skills`; the other lanes use `.agents/skills`.
The ordinary prompt is `Reply with done.` and names no skill. Explicit native
probes use `/gate-claude` and `$gate-codex` respectively. OpenCode load probes
use the live-advertised skill tool's argument (`name` on v1, `id` on v2), first
without the rule and then with it. This intentionally scripted tool call can
request a skill omitted from the listing.

A separate v1 pair contributes the deny rule solely through an auto-loaded
plugin's `config` callback, the same callback surface used by the current
projector. A local marker records the rule written by that callback. The
ungated plugin baseline has no callback or rule.

## Results

| Harness | Ordinary gated listing | Explicit request / forced tool call |
| --- | --- | --- |
| Claude Code 2.1.286 | `gate-claude` absent; control and Codex-declared skill still listed | `/gate-claude` injects its body into the model request |
| Codex 0.156.1 | `gate-codex` absent; control and Claude-declared skill still listed | `$gate-codex` injects its complete skill into the model request |
| OpenCode 1.18.34 | `gate-opencode` absent; control, Claude-declared and Codex-declared skills still listed | Ungated `skill {name: "gate-opencode"}` returns the body; the deny rule rejects the same scripted call |
| OpenCode 2.0.20 | `gate-opencode` absent; control, Claude-declared and Codex-declared skills still listed | Ungated `skill {id: "gate-opencode"}` returns the body; the deny rule returns `permission.rejected` and no body |
| OpenCode 1.18.34, plugin config callback | Same omission as the file-declared deny rule | Same rejection; the callback marker records the applied rule |

Every promoted run exited 0 with no playback-server errors. The driver selects
the first tool-bearing request, excluding auxiliary traffic, and requires its
baseline to advertise all four skills.

The per-case evidence files under `evidence/` record exact versions, dates,
inputs, exit status, marker summaries of the complete model requests, verbatim
probe-bearing lines with JSON paths, and the complete skill-tool responses.
They retain hashes of the original request files. Description markers in an
explicit invocation can come from the injected skill body; only the ordinary
baseline/gated cases establish listing visibility. Full protocol traffic is
kept under ignored `captured/`; it includes unrelated built-in tool and skill
text and is not required in the public evidence. The promotion script redacts
only the capturing Windows account-name path segment to `user`.

## Reproduction

Install the desired binary in an isolated tool directory (the v1 lane uses
`opencode-ai`, v2 uses `@opencode/cli`). `HKN_SKILL_HARNESS_BINARY` optionally
selects its full executable path; otherwise the driver uses the harness name
on PATH. It obtains the version from that executable. The v1 lane prepares its
matching plugin dependency in the scratch project/config directory.

From the repository root, after a frozen install:

```sh
node --experimental-strip-types .capture/skill-invocation/drive.mjs claude
node --experimental-strip-types .capture/skill-invocation/drive.mjs codex
node --experimental-strip-types .capture/skill-invocation/drive.mjs opencode-v1
node --experimental-strip-types .capture/skill-invocation/drive.mjs opencode-v1 --plugin-only
node --experimental-strip-types .capture/skill-invocation/drive.mjs opencode-v2
```

Set the binary selector separately for each OpenCode lane. Each run prints a
unique raw-output directory. To produce evidence, pass those directory names
(relative to `captured/`) to `promote.mjs`; pass both successful v1 directories
in the same command to combine its cases. Review the output before committing.
Do not overwrite historical evidence with a capture of a different version.

## Limits and consequences

- Claude and Codex's tested declarations hide implicit discovery while
  retaining explicit user invocation. The tested OpenCode deny rule both hides
  discovery and rejects a forced model tool call. These are different observed
  behaviors; the deny rule alone is not evidence of equivalent user-invoked-only
  semantics.
- OpenCode user-interface slash-command behavior, installed package skills,
  other platforms, and a v2 plugin-supplied permission rule were not tested.
- These captures establish only the named inputs and versions. They do not
  establish that a harness never reads another vendor's policy anywhere.
- Issue #28 still needs a portable declaration and an explicit decision about
  these semantic differences. No support rating or public API changes here.
