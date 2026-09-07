# Claude plugin author metadata validation

## Question and method

Does Claude accept every author object allowed by the portable Agent Plugins
manifest? On Claude Code 2.1.260 (2026-09-07), write a native
`.claude-plugin/plugin.json` with name `author-probe`, version `1.0.0`, and
description `Author validation probe`, varying only `author`. Run
`claude plugin validate <directory>` and record its exit code and diagnostic.
This command performs local validation without model credentials or spend.

Evidence class: **live-probe** of the native validator, not a hook-boundary
payload or proof of installed-plugin execution.

## Observations

| Author value | Exit | Result |
| --- | --- | --- |
| Omitted | 0 | Accepted; optional author-information warning |
| `{}` | 1 | `author.name: Invalid input` |
| `{"email":"maintainer@example.com"}` | 1 | `author.name: Invalid input` |
| `{"url":"https://example.com"}` | 1 | `author.name: Invalid input` |
| `{"name":""}` | 1 | `author.name: Author name cannot be empty` |
| `{"name":"Maintainer","email":"maintainer@example.com"}` | 0 | Accepted |
| `{"name":" "}` | 0 | Accepted; whitespace is not trimmed |

The original compiler accepted the email-only portable author with no
diagnostics in both `check` and `build`, then emitted a native manifest that
failed the same validation command.

## Consequences

The Claude projector requires a non-empty author name when emitting author
metadata. A portable author without one cannot be represented verbatim:
projection fails under the default policy, or omits the whole author object
with an explicit `agent-plugin.manifest` omission under `onUnsupported: "warn"`.
The portable source remains unchanged. No missing name is inferred from an
email address or supplied by a lower-precedence native overlay.

After the fix, the rebuilt CLI returned exit 1 with HN205 for the email-only
author in both `check` and `build` under the default policy. With the warning
policy, both returned exit 0 with HN205 warnings, and the emitted manifest
omitted `author`. Validating that emitted package with the same native command
returned exit 0 (optional metadata warnings only).
