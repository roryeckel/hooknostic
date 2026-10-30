# Claude skill-listing budget

Question: why do Claude Code 2.1.311 and later list a `.claude/skills` project
skill without its description, when 2.1.310 shows it? The Claude playback case
"runs repository-local integration without installing a plugin" asserts that
the description reaches the model, and it started failing on 2.1.311.

## Method

Evidence class: **live-probe**, native Windows, 2026-10-29, Node 24.20.0.
`drive.mjs` runs the real binary against the repository's loopback playback
model with a scripted text reply. It needs no credentials and spends nothing.
Each session gets a fresh git project with one synthetic project skill,
`budget-probe`, and isolated HOME, USERPROFILE and CLAUDE_CONFIG_DIR. The
driver removes inherited `CLAUDE*` and `AI_AGENT` variables, which leak into
the harness when a capture is started from a Claude session. Each build runs
three sessions:

- `default`: no override.
- `raised`: `SLASH_COMMAND_TOOL_CHAR_BUDGET=100000`.
- `tight`: `SLASH_COMMAND_TOOL_CHAR_BUDGET=2000`, below Claude's own entries.

The listing comes from each session's first tool-bearing model request, and
Claude's over-budget warning comes from its `--debug-file` log.
`evidence/<version>-win32.json` records, per session, the name, form (`full`
or `name-only`) and length of each listing entry, the probe's entry verbatim,
the warning line, and a hash of the raw requests. It records no bundled skill
text. Raw requests stay in the ignored `captured/` directory.

## Results

| Build | Default listing | Probe: default | raised | tight | Default-session warning |
| --- | --- | --- | --- | --- | --- |
| 2.1.238 | 4477 chars | full | full | name-only | none |
| 2.1.310 | 5971 chars | full | full | name-only | none |
| 2.1.311 | 5983 chars | name-only | full | name-only | `14 skills, 6167 chars > 6000 budget` |
| 2.1.312 | 5983 chars | name-only | full | name-only | `14 skills, 6167 chars > 6000 budget` |

In every over-budget session, Claude kept its bundled skills' entries whole and
listed the probe, `init` and `security-review` by name alone. The raised budget
restored every description. Between 2.1.310 and 2.1.311 the only entry that
changed length is the bundled `code-review`, from 642 to 840 characters. Claude's
own entries then total 6102 characters, more than the 6000-character default
budget for this model id, before any project skill is added. On 2.1.310 the
listing, probe included, fitted with 29 characters to spare.

## Mechanism

This section has weaker provenance. It was read from the JavaScript embedded in
the 2.1.310 and 2.1.311 Windows binaries, not observed separately. Unless
`SLASH_COMMAND_TOOL_CHAR_BUDGET` is set, the budget is the model's context
window, times a per-model characters-per-token factor, times the
`skillListingBudgetFraction` setting (default 0.01). Over budget, bundled prompt
skills keep their full entries and every other skill starts name-only. The
remaining budget then goes back to the others in Claude's priority order. The
function is the same in both builds. 2.1.311 also adds an optional floor from
remote configuration, behind a condition this reading did not resolve. The
loopback sessions, which disable nonessential traffic, logged 6000 regardless.
The live results match this reading. The factors behind 6000 for the playback model id were not
observed separately.

## Consequences

- No hooknostic delivery defect and no change to a capability claim. On every
  probed build the project skill is discovered, listed by name and loadable
  through the Skill tool. The budget policy predates the reference build
  2.1.238. What changed is that Claude's own entries now exceed the budget this
  model id gets.
- Whether a non-bundled skill's description reaches the model depends on
  everything else installed and on the model's context window. hooknostic
  cannot guarantee it and writes no budget setting. Users can raise
  `skillListingBudgetFraction` in settings, as Claude's warning suggests, or set
  `SLASH_COMMAND_TOOL_CHAR_BUDGET`.
- The Claude playback lane sets `SLASH_COMMAND_TOOL_CHAR_BUDGET=100000`, so
  growth in Claude's bundled skills cannot collapse a fixture skill, and the
  repository-local case still asserts the description. With that line removed,
  the case fails on 2.1.311 and 2.1.312. With it, the case passes on 2.1.238,
  2.1.311 and 2.1.312.
- This explains the `.capture/skill-invocation` note that Claude's listing
  sometimes keeps a skill's name without its description.

## Reproduction

From the repository root, after a frozen install:

```sh
HKN_CLAUDE_BINARY=<claude executable> node --experimental-strip-types .capture/claude-skill-listing-budget/drive.mjs
```

`HKN_CLAUDE_BINARY` defaults to `claude` on PATH. On Windows these captures
named the platform package's `claude.exe` directly. Each run writes
`evidence/<version>-<platform>.json` and prints its raw-output directory.

## Limits

- Windows only. Plugin and user skills were not probed, although the binary
  reading treats every non-bundled source alike.
- Only the playback model id was probed. Real model ids get budgets from their
  own context windows, so a user's threshold differs.
- With one probe skill, Claude's priority order among non-bundled skills was
  not exercised.
