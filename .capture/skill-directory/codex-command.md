# Codex command paths after the relative skill-directory rewrite

Source: owner-reported [issue #113](https://github.com/roryeckel/hooknostic/issues/113),
2026-10-19. Class: **live-probe**, observed end to end by command locations and
the script's output; not a hook-boundary capture. These sessions were not
independently rerun for this change. The earlier loopback probe establishes
injected text and instructions, not whether a real model follows them.

## Method

Windows 11, Codex CLI 0.163.0, bundled `gpt-6-luna`, Hooknostic 0.7.0.
A one-skill `skilldir-probe` package was built for Codex package delivery,
installed through a local marketplace into an isolated `CODEX_HOME`, and invoked
from a scratch git project with stdin closed:

```sh
codex exec -c 'windows.sandbox="elevated"' -m gpt-6-luna '$skilldir-probe:where'
```

`skills/where/scripts/where.sh` printed its location and arguments:

```bash
#!/usr/bin/env bash
echo "where.sh ran; working directory: $(pwd); arguments: $*"
```

Every skill variant was built, replacing `${SKILL_DIR}` with `.`. A pass meant
the first command running the script used the skill directory. The failing
body, without the optional frontmatter fields, was:

````markdown
---
name: where
description: Show this probe's status (where its script runs)
---

Print where this skill's script runs.

Raw slash-command arguments:
`$ARGUMENTS`

Replace `<args>` below with the raw arguments above, each one wrapped in single quotes as its own word (for example `'--python' 'C:\Users\me\venv\Scripts\python.exe'`), or with nothing when there are none. Never paste them unquoted: bash strips the backslashes out of an unquoted Windows path, so `C:\Users\me\x.exe` would reach the script as `C:Usersmex.exe`. A value that itself contains a single quote is written `'it'\''s'`.

```bash
bash "${SKILL_DIR}/scripts/where.sh" --project "<absolute path of the user's project>" <args>
```

Return the output verbatim.
````

## Reported observations

| Body variation | First command used the skill directory |
| --- | --- |
| Short instruction to run the script and return its output | 4/4 |
| Same, passing the project as an absolute argument | 3/3 |
| Same, with another `scripts/` folder at the package root | 3/3 |
| Same, plus `$ARGUMENTS` and a short quoting instruction | 3/3 |
| Body above, plus `allowed-tools` and `metadata.argument-hint` | 1/3 |
| Body above without those optional frontmatter fields | 0/3 |

In a failing run Codex printed a PowerShell command executing
`bash "./scripts/where.sh" --project "<scratch-project>"` with the scratch project
as its working directory. Bash returned `./scripts/where.sh: No such file or directory`.
In a passing run it read the installed SKILL.md first, then ran the command with
the installed `skills/where` folder as its working directory; the script printed
that folder and the project argument. The issue includes the command transcripts.

Additional command skills with the longer quoting pattern failed in 7/7 reported
runs: five commands used the session directory and two used the plugin root.
`codex debug models` still included the skill-relative-path instruction.

## Limits and consequence

The sample counts describe these sessions, not a success probability. The
association with reading SKILL.md first, and with paragraph wording, is a
reported pattern, not an established cause. No earlier Codex build was rerun,
no replacement absolute-path placeholder was tested, and project delivery was
not separately probed. No conclusion about OpenCode or Pi follows from this.

The initial response kept the existing relative output and reported
`codex:skill-directory-relative` for each rewritten body. The subsequent adoption
replaces that projection and id as recorded in the comparison below.
The baseline copying support remains exact; the conditional translation depends
on the model. Both delivery profiles declare that dependency. Frontmatter-only
tokens and skills discovered in place keep `skill-reference-unexpanded`, since
no rewrite happens.

The subsequent [controlled comparison](comparison.md) tests the explicit
absolute-path placeholder against body F and a reconstructed E. It records its
own setup, counts, and limits separately from the original owner-reported sessions.
