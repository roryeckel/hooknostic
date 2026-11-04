# A host's disabled MCP server stays disabled on OpenCode

0.10.1 is a fix release. A host that launches OpenCode with its own
configuration layer (`OPENCODE_CONFIG_CONTENT` or a config file) can switch a
project MCP server off with `enabled: false` again. Until now, Hooknostic's
generated OpenCode module wrote its own declaration over that entry, and the
server ran anyway. Claude Code, Codex and GitHub Copilot never lost their switch,
because it acts on the static file Hooknostic writes. On OpenCode, Hooknostic's
runtime registration had removed it. [ADR-0015](decisions/0015-project-integration.md)
records the amended rule. The evidence is in
`.capture/opencode-disabled-mcp`.

## What is included

- **A project or package declaration no longer re-enables a server the host
  disabled.** It still replaces a same-named inherited server the host left
  enabled, and unrelated inherited servers are still left untouched.
  - **OpenCode v2:** the MCP editor reports the host's entry as
    `disabled: true`, for local and remote entries alike. The project components
    module and the package injector then skip that name and register the rest.
  - **OpenCode v1:** the `config` hook receives the host's entry as
    `enabled: false`. The project module and package injector skip it the same
    way. The generated modules stay environment-free.
- **No new vocabulary.** There is no environment variable and no Hooknostic
  diagnostic: OpenCode itself reports the server as disabled. Hooknostic's own
  `enabled: false`, for a remote declaration with an unset `${VAR}`, still
  applies.
- **Playback covers it.** The `opencode-v2` lane starts two projected stdio
  servers. The one the host disabled never starts, while the other, the copied
  skill and the generated hook still work. A same-named entry the host left
  enabled is still replaced. The `opencode-v1` lane covers the host-layer case.
- **Windows playback runs the build `PATH` selects.** The OpenCode v2 capture
  drive used to run the global `opencode.exe` even when a reference build came
  first on `PATH`. It now runs the selected build, fails loudly on a version
  mismatch, and the mutation verifier refuses to count a mutant run on the wrong
  build. A stalled Windows ancestry probe in Pi playback now retries.
- **Support evidence.** Editor-shape and effect records were added for OpenCode
  2.0.17 and 2.2.0, and config-hook records for 1.18.18. The playback lanes'
  scheduled validations recorded Claude 2.1.316, Codex 0.166.0, Copilot 1.0.105,
  OpenCode 1.19.5 and 2.2.5, and pi 1.5.0. Recommended target ranges, reference
  builds and support levels are unchanged.

## Upgrading from 0.10.0

- **Re-sync or rebuild to pick it up.** The fix is in generated output. A
  project-delivered install needs `sync` to rewrite
  `.opencode/plugins/hooknostic-components.js`, and an OpenCode package needs a
  rebuild.
- **A disabled host entry now wins.** If a host or a global OpenCode
  configuration disables a server by name, the project's declaration of that
  server no longer turns it back on. That is the intended change. Remove the
  host entry, or set it to `enabled: true`, to use the project's server.

## Limits

- **Pi is unchanged.** Its registration loses to a host file entry rather than
  overriding one, and no capture covers a disabled collision.
- **Windows-only evidence.** The editor-shape, config-hook and effect captures
  ran on native Windows. CI's playback lanes also run the new cases on Ubuntu.
- **Not captured:** whether another plugin's earlier v1 `config` write is part
  of the document the module reads.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
