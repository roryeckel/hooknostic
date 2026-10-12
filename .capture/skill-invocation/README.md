# Native skill invocation gates

Question: which native project-skill declarations affect model visibility, and
what happens when a gated skill is explicitly requested or its tool is forced?
This is evidence for [issue #28](https://github.com/roryeckel/hooknostic/issues/28),
within [CONTRIBUTING](../../CONTRIBUTING.md). The original native-gate probes are
retained below. The policy follow-ups establish projection evidence for
[ADR-0030](../../docs/decisions/0030-skill-invocation-policy.md).

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

## Limits of the original probes

- Claude and Codex's tested declarations hide implicit discovery while
  retaining explicit user invocation. The tested OpenCode deny rule both hides
  discovery and rejects a forced model tool call. These are different observed
  behaviors; the deny rule alone is not evidence of equivalent user-invoked-only
  semantics.
- OpenCode user-interface slash-command behavior, installed package skills,
  other platforms, and a v2 plugin-supplied permission rule were not tested.
- These captures establish only the named inputs and versions. They do not
  establish that a harness never reads another vendor's policy anywhere.
- These original deny probes alone do not establish the portable policy.

## Policy follow-ups — 2026-10-11

Evidence class: **live-probe**, native Windows, isolated state, loopback model
responses and tool calls. `--policy` runs ordinary discovery without a gate,
discovery with the native gate, discovery with an explicit native allow setting,
explicit user invocation, an ungated forced loading control, and gated forced
loading. Every complete run exits zero with no playback errors. The driver
requires discovery controls and explicit/ungated body markers, and promotion
requires all six cases. Failed or timed-out sessions are not promoted.

Claude's native listing sometimes retains a skill's name without its description.
`visibleSkills` records either an exact Claude list entry or the description
marker; `descriptionMarkersInInitialRequest` remains the narrower marker-only
summary. Explicit request cases are never used to infer ordinary discovery.

`--package` installs Claude and Codex through a fresh local marketplace.
OpenCode packages are installed by offline npm from a local source with
`--install-links --ignore-scripts`, relocated into `node_modules`, and loaded
through the native package declaration. The v1 package's config callback supplies
`skills.paths` and the permission rule. The v2 package registers qualified IDs
through `ctx.skill.transform` and supplies `autoinvoke`. Project v2 discovery
instead reads `metadata["opencode/autoinvoke"]` from SKILL.md.

| Native route | Gate | Explicit user invocation | Forced model loading |
| --- | --- | --- | --- |
| Claude project and installed package | `disable-model-invocation: true` | `/skill` or `/plugin:skill` delivers the body | A scripted native Skill call is rejected; its ungated control loads the body |
| Codex project and installed package | `policy.allow_implicit_invocation: false` in `agents/openai.yaml` | `$skill` or `$plugin:skill` delivers the body | Direct file reading remains available; discovery policy is not filesystem access control |
| OpenCode v1 project and installed package | Named `permission.skill` deny | Native `run --command skill` delivers the body despite deny | The skill tool rejects a scripted load; the ungated control succeeds |
| OpenCode v2 project and installed package | `opencode/autoinvoke: "false"` or registered `autoinvoke: false` | `@skill` / `@plugin/skill` with a scripted skill-tool load delivers the body | A scripted skill-tool load remains available despite the hidden listing |

The explicit allow cases set the inverse native value and restore ordinary
discovery. V1 merges named rules through the callback surface already probed by
the original plugin-only pair. No TUI command-menu visibility or picker behavior
is claimed. V2's explicit case observes a user reference plus tool loading; it
does not establish automatic body injection by a TUI reference picker.

Codex forced file-read controls disable the nested harness sandbox. The ordinary
and explicit invocation probes keep their normal harness settings. This isolates
the discovery declaration from Windows tool-process sandbox startup, which hung
both gated and ungated reads. It establishes file readability with sandbox access
allowed, not a filesystem permission grant or a claim about sandbox enforcement.

The policy evidence filenames include delivery, preserving the original October
4 files. Adapter skill-policy validation records name the supported minimum
builds; the generated [support page](../../docs/harness-support.md) derives ranges
from those records. Older untested ranges remain unsupported.

### Alternate native source ownership

Separate `--discovery-root=<directory>` probes place all four control skills in
one alternate native source and record ordinary model requests. The reference
Codex build discovers `.codex/skills`; both reference OpenCode builds discover
`.claude/skills`, `.opencode/skills` and `.opencode/skill`. Each successful probe
shows all four descriptions with no model tool calls. The reference Claude probe
did not list `.agents/skills`; that observation is specific to the isolated
project and does not establish behavior on other versions. The committed
`*-discovery-*.json` records contain excerpts and raw-request hashes.

Policy planning treats authored native sources as unowned, including alternate
paths, rather than assuming a generated copy controls their discovery. The
ancestor-path ownership check is conservative; OpenCode v1's reference binary
source also scans ancestor `.claude` and `.agents` directories. The alternate
probes establish project-local discovery, not duplicate-name precedence or
command-menu behavior. Seven alternate-path regressions, two nested-collection
regressions, an ancestor-path mutant, and two overlay report-count regressions
failed before their fixes, then passed. The final policy build suite passes all
34 cases. Raw negative reports remain in ignored `captured/review-*.json`.

The reference OpenCode v1 installed-package policy evidence was repeated with
qualified `gate-probe-*` names. All six controls passed, including explicit
`run --command gate-probe-gate-opencode` while its permission rule was `deny`.

```sh
node --experimental-strip-types .capture/skill-invocation/drive.mjs claude --policy
node --experimental-strip-types .capture/skill-invocation/drive.mjs codex --policy --package
node --experimental-strip-types .capture/skill-invocation/drive.mjs opencode-v1 --policy --package
node --experimental-strip-types .capture/skill-invocation/drive.mjs opencode-v2 --policy --package
```

Run both delivery forms for each selected reference/newer binary. A diagnostic
rerun can select `--case=<label>` (it retains the baseline control); promote it
together with the other successful cases from that exact harness and version.
Do not promote partial evidence as a complete policy run. Vendor startup traffic
can cause timeouts despite the local model; successful control cases must be
observed before drawing a behavioral conclusion.

## Implementation verification

The policy regression suite covers strict parsing, native overlays, preserved
fields and body bytes (including UTF-8 BOM input), declaration removal, drift,
shared destinations, unchanged in-place sources, and failure/omission/accepted
emission with diagnostics and report counts. Nine semantic mutants each made the
new regressions fail before restoring the implementation. The BOM body-boundary
regression also failed against the original helper and passed after correction.
Three mixed hook/component regressions failed before including configured shared
readers excluded by `components.targets`; policy-only integration now enforces
their gates or reports shared omissions while leaving their MCP delivery scoped.
Raw mutation logs remain in ignored `captured/`.

Independent review found two additional strict-input cases: a Claude overlay
could restore a rejected canonical skill, and an earlier frontmatter error could
mask a malformed reserved policy. Four build regressions failed before the fixes
and passed after rejecting the overlay and validating the reserved value first.
The negative JSON report remains in ignored `captured/review-negative.json`.

The full standard suite passed all 1,820 tests with two workers (83 skipped)
after an obsolete, manifestless dependency stub was preserved outside `packages/`.
Root lint, format checking,
build, and example regeneration passed. Native policy controls above passed
independently of the initial broader playback failures. Codex reference playback
passed. A follow-up investigation compared an independently installed and bundled
archive of pre-change commit 831a2e3 with the policy implementation. All eleven
previously failing tests passed on both copies with matched reference binaries:
one child-stdin cleanup test, three OpenCode v1 scenarios and seven OpenCode v2
scenarios. The native hook artifacts match after normalizing generated source
paths and comments. Raw reports and comparison hashes remain in ignored
`captured/playback-investigation/`.

The child-stdin fixture and process helper are unchanged. The earlier OpenCode
v1 failures occurred during npm dependency installation, before the native
harness was launched; their exact timeout cause was not reproduced. The earlier
v2 run mixed a reference binary on PATH with the globally installed binary used
by Windows capture drivers: retained OAuth logs identify 2.0.20 while the lane
selected 2.0.17. Explicit `HKN_OPENCODE_BINARY` selection keeps those paths on
the same build. An isolated copy of 2.0.20 also passed all seven formerly failing v2 scenarios
on both the baseline and policy implementation. These failures do not establish
an invocation-policy regression.

Claude's follow-up exposed a separate folder-trust parsing defect reproduced on
the pre-change baseline. Its original ANSI stripper retained a private CSI
sequence, whose `>` was mistaken for the option cursor. The captured-frame
regression failed with that stripper and passed after sharing Node's VT control
stripping across both PTY drives. See the [playback capture record](../harness-playback/README.md#windows-private-csi-folder-trust-correction-2026-10-11).

Complete reference playback now passes with one worker and explicit native
binary selection: Claude has 42 passing tests and nine skips, Codex has 41 passing
tests and ten skips, OpenCode v1 has 35 passing tests and sixteen skips, and
OpenCode v2 has all 29 tests passing. Each lane exited zero. The Claude and Codex
reference versions are recorded in adapter validation records; the corresponding
native lanes use the reference binaries. Failed and diagnostic runs remain
separate from promoted policy evidence.
