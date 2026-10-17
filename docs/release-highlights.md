# Pi joins the supported harnesses

0.7.0 adds Pi as a bundled Hooknostic target for project and package delivery.
One portable source can now emit native Pi hooks and skills alongside Claude
Code, Codex CLI, and OpenCode. See the [installation guide](installing-artifacts.md#pi)
and the versioned [harness support table](harness-support.md) for supported
operations and their evidence.

## What is included

- Native Pi extensions support tool blocking and input rewriting, prompt and
  model-request context injection, and the documented lifecycle operations.
  Target-specific effect validation runs before effects change portable state;
  invalid Pi input replacements follow the configured hook-error policy.
- Captured `read`, `write`, and `edit` calls expose additive file views. The
  dedicated PowerShell tool identifies its shell family. Pi's `bash` tool leaves
  the dialect absent because its configured interpreter can vary.
- Hooks declaring final-response fields receive successful assistant text and
  its native session-entry ID. Error, cancellation, retry, and resumed-session
  probes verify that an earlier response is not exposed as the current result.
- Project and packaged skills support relative skill-directory references and
  the portable implicit-invocation policy. Native explicit invocation remains
  available when ordinary model discovery is disabled.
- Pi participates in the shared adapter contracts, Windows/Linux loopback
  playback, and weekly harness-version monitoring. Capture and drift drivers
  isolate user settings and ambient skills and support the Node 22 floor.

## Adopting Pi

Existing target configurations remain valid. Add a `pi` target to enable Pi
output; the CLI includes the adapter and runtime shim. Follow the
[project integration guide](project-integration.md) for project reconciliation
or the [package installation guide](installing-artifacts.md#pi) for Pi packages.

The basic and shell-rewrite projects in [examples](../examples/README.md) include
Pi project targets. The [combined package](../examples/agent-plugin/README.md)
and [local project](../examples/local-project/README.md) include Pi in their default
configurations, accepting only its named stdio MCP omission.

`components.accept` can now name `pi:mcp-stdio-omitted`,
`pi:mcp-streamable-http-omitted`, and `pi:mcp-sse-omitted` individually. An
accepted omission reports HN205 as information and keeps the component rated
unsupported, with the servers counted as skipped. Other unsupported components
and invalid inputs remain errors. See [component policies](configuration.md#compatibility-and-component-policies).

- Inspect support for the selected target version and delivery before building.
  Skill invocation-policy support is version-scoped; a broad range can include
  builds without a captured gate.
- Keep portable skill sources in a neutral directory so Hooknostic can own the
  generated native copies. Authored skills discovered in place remain untouched.
- Feature-detect `tool.shell.dialect` before choosing shell-specific syntax.
  Raw tool input remains available when a normalized view or dialect is absent.

## Limits

Pi's native MCP, permission, and subagent lifecycle channels remain unsupported.
Turn-stop and session-end mappings are rated emulated, and output replacement is
approximate. These distinctions remain visible in capability analysis and reports.

Harness evidence was established on Windows and Linux, centered on the captured
reference build. Pi has no macOS harness captures. Loopback playback exercises
real harness behavior using scripted model responses and spends no model credits.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
