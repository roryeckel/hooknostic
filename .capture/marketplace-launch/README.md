# Installed marketplace example verification

Evidence class: **live-probe**. Windows, 2026-09-27. The executable procedure is
`scripts/verify-marketplaces.mjs` and `packages/cli/test/marketplace-example.test.ts`.
No model credentials, paid model requests, registry publication, or hosted jobs.

## Procedure

Build a temporary copy of the documented combined example with the production compiler.
Copy native output and the checked-in marketplace document into a separate temporary
marketplace. Register and install `combined-example@hooknostic-example` in isolated
configuration/cache directories. Start the harness from a third, unrelated Git directory.
The scripted loopback model asks for the harmless shell marker, then the MCP greeting.

Assertions require the skill description in model input, the generated hook's denial
in the next model request, no shell marker file, and `Hello, friend!` returned by MCP.
The isolated consumer has no workspace node_modules. Normal tests additionally relocate
Claude, Codex, OpenCode v1 and v2 outputs and call each bundled MCP server directly.

## Observations

| Harness version | Outcome |
| --- | --- |
| Codex 0.153.2 | Marketplace example passed; installed-plugin denial/input rewrite and projected MCP launcher checks also passed |
| Codex 0.156.1 | The same marketplace gate passed |
| Claude 2.1.260 | Marketplace installation, skill discovery, hook denial, and MCP response passed |
| Claude 2.1.283 | The same marketplace example passed |

The baseline versions come from existing projector validation records. They do not replace
the older hook/project reference versions. Additional installed versions were selected
explicitly with `HOOKNOSTIC_PLAYBACK_VERSION`.

The first Claude attempt exposed duplicate tool-call ids in the loopback server: the
second tool reused the previous denial result and the MCP-response assertion failed.
Giving each scripted Anthropic tool call a distinct id made the same test pass.
The baseline initially needed its native installer (an ignore-scripts install left an
unusable executable). A transient Windows directory lock during cleanup is handled by
bounded retries; the final baseline run completed with exit 0.

## Limits

This establishes local marketplace installation, not publication in a remote marketplace,
listing acceptance, automatic updates, other operating systems, or paid-provider behavior.
OpenCode relocation here proves the bundled MCP process, not new native harness behavior;
the independent family playback suites own that evidence.
