# Comparing Codex skill-directory projections

Question: on the failing command body from issue #113, does an explicit absolute-path
placeholder resolve the launcher more reliably than the current `.` projection?

`compare-codex-paths.mjs` is an opt-in **paid-model** probe on native Windows. It
pins Codex to the version in `codexSkillDirectoryValidation`, uses `gpt-6-luna`,
and invokes `$skilldir-probe:where` from a scratch Git project with stdin closed.
Every session gets a fresh local marketplace install and isolated Codex state.
The existing login is copied into temporary state and never written to the
capture directory. The normal user config, installed skills, and trust entries
are not inherited. No real-model session runs without `--live`.

```sh
node --experimental-strip-types .capture/skill-directory/compare-codex-paths.mjs --live --unsandboxed --runs=5
```

The two targets differ only in the `skillDirectory` value passed to the existing
`projectSkillText` helper:

- Current: `.`
- Candidate: `<absolute path of the directory containing this SKILL.md>`

Body F is copied from the complete source in [the original probe record](codex-command.md).
The literal optional frontmatter fields of body E were unavailable. `E-reconstructed`
therefore adds `allowed-tools: Bash` and `metadata.argument-hint: "[args]"` to F;
it is a declared reconstruction, not an exact reproduction of E. A package-level
`scripts/` folder coexists with the skill's own launcher directory, as in the report.

`--unsandboxed` requires deliberate owner authorization: model-issued commands
run with the account's filesystem and network access. Without that flag the
driver retains Codex's workspace-write sandbox. The owner explicitly authorized
the unsandboxed 20-session comparison in this chat after the setup attempts below.

The comparison interleaves five sessions per body and projection in
alternating order (20 sessions total). The fixture's native package metadata follows the captured local
marketplace layout. The launcher prints the original working-directory/arguments
line and additionally appends a TSV execution marker in the scratch project,
through `HKN_EXECUTION_TRACE`. This keeps marker writes inside the workspace-write
sandbox. Both arms pin Git Bash on PATH; the host's bare system `bash.exe` otherwise
launches WSL, which rejects a Windows `C:/...` launcher path. That preflight mismatch
was found before any model request and is not a projection failure.
A direct absolute-path control verifies that launcher before each model run, then
its marker is removed. Control executions do not count as model successes.

Success means the first launcher attempt executes the intended script. An absolute
launcher may run successfully while keeping the project as its working directory;
requiring the skill directory as cwd would unfairly reject the candidate. Record
eventual execution separately so model retries do not hide a failed first attempt.
Command traces and marker files are the evidence, not the model's final answer.

Raw session JSONL, stderr, projected skills, execution markers and per-run results
land under an ignored `captured-comparison-*` directory. Before promotion, manually
review launcher attempts, redact the account segment to `user`, and distinguish
infrastructure failures from command-resolution failures. Small sample counts do
not establish a general success probability or justify an `exact` rating.

## Setup attempts (2026-10-19)

- A real-model baseline with the original elevated Windows sandbox setting
  selected `bash "./scripts/where.sh"` with the scratch project as `workdir`.
  Its Code Mode `tools.exec_command` never returned before the 180-second timeout.
  It produced no execution marker and is an infrastructure timeout, not a completed
  directory-resolution failure. This attempt used the host's WSL Bash.
- A second baseline pinned Git Bash and explicitly used the workspace-write
  sandbox with `windows.sandbox="unelevated"`. It selected the same project-relative
  launcher and also stalled in the nested shell call until the 180-second timeout.
- `control-codex-execution.mjs` uses a loopback model and a scripted Code Mode
  command to write one marker inside a scratch workspace. With native sandboxing
  still enabled, the nested call remained pending and the marker was absent at
  the 45-second cutoff. This is a no-spend execution control, not model-behaviour
  evidence. Its saved responses include the pending tool result. No caller should
  interpret its scripted final text as success.
- Automatic approval review rejected a proposed sandbox-disabled retry because
  the comparison request had not explicitly authorized giving model-issued
  commands the Windows account's broader filesystem and network access. That
  retry did not execute. Explicit user approval was requested after the safer
  sandboxed attempts stalled.

After the owner approved the broader execution mode, the unsandboxed loopback
control completed with exit 0 and the expected marker. All 20 paid sessions then
completed with exit 0 and no infrastructure timeout. Session exit 0 by itself is
not a script success: several sessions faithfully returned a failed command's output.

## Results (2026-10-19)

Class: **live-probe**. Codex CLI 0.163.0, `gpt-6-luna`, native Windows, Git Bash,
native sandbox disabled with explicit owner authorization. The same environment
and native local-marketplace package layout were used for both projections.

| Body | Projection | First launcher attempt succeeds | Script eventually runs |
| --- | --- | --- | --- |
| F, exact body from the issue | `.` | 1/5 | 1/5 |
| F, exact body from the issue | explicit absolute-path placeholder | 5/5 | 5/5 |
| E, reconstructed frontmatter | `.` | 0/5 | 1/5 |
| E, reconstructed frontmatter | explicit absolute-path placeholder | 5/5 | 5/5 |
| Combined | `.` | 1/10 | 2/10 |
| Combined | explicit absolute-path placeholder | 10/10 | 10/10 |

The candidate text was exactly:

```text
<absolute path of the directory containing this SKILL.md>
```

Every candidate run substituted an absolute path to the installed skill's
`scripts/where.sh`. The script kept the project as its working directory and
received the project argument. The one first-attempt `.` success selected the
installed skill directory as `workdir`. The other nine `.` runs first invoked
`./scripts/where.sh` from the project and received `No such file or directory`.
One reconstructed-E session then read the installed SKILL.md and retried the
relative command with the skill folder as `workdir`, explaining the difference
between first and eventual success.

The redacted [command-and-effect evidence](evidence/codex-absolute-path-comparison.json)
contains every launcher attempt, its workdir, exit code and output, the script's
execution records, and the exact skill text for each cell. Internal model reasoning
and login state are excluded. Only the capturing home/account segment is redacted
to `user`, including Git Bash's alternate spelling of that same home directory.
Raw session records remain ignored locally. Reproduce promotion after manually
reviewing the traces with:

```sh
node .capture/skill-directory/promote-comparison.mjs .capture/skill-directory/captured-comparison-0.163.0
```

This sample supports the explicit placeholder over `.` for these command bodies.
It is still a model-substituted placeholder, and 10 successes do not establish a
general reliability guarantee or an `exact` rating. The original E frontmatter,
sandboxed execution, other models, other harness versions, and project delivery
were not validated by the completed comparison.

## Adoption (2026-10-19)

Codex's package and project projections now write the tested explicit placeholder.
Every rewritten body reports `codex:skill-directory-model-substitution` (HN101, an
error by default), because Codex does not expand it: the model must substitute the
installed directory from the supplied SKILL.md path. The project-delivery policy
conservatively carries this same dependency; the live comparison measured package
delivery only. This adoption does not strengthen the bounded evidence above.
