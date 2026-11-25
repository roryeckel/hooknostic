# Harness evidence refreshed for current builds

0.14.2 is a maintenance release. Decoding, effects, capabilities and
generated-artifact shapes are unchanged, and a project synced with 0.14.1 keeps
working as it did. The release refreshes the recorded evidence for the newest
harness builds, makes OpenCode v2 playback follow two 2.4.x harness changes, and
brings the toolchain and release checks up to date.

## What is included

- **OpenCode v2 playback follows 2.4.x.** On 2.4.0, a background child's result
  reaches the parent as a user-role `<background-result kind="subagent" ...>`
  message instead of `<subagent ...>`, and each remote MCP server receives a
  `server/discover` POST before `initialize`. The playback lane now derives the
  expected wrapper from the build's validation record, asserts the discovery
  POST, and still requires exactly one failed `initialize` on the legacy SSE
  endpoint with no fallback GET. New records and fixtures cover 2.4.0 and 2.4.1
  ([capture record](../.capture/opencode-v2/README.md)). No decoder, shim or
  capability cell changed.
- **Validation records refreshed.** Scheduled model-free playback recorded
  Claude Code 2.1.330, Codex 0.171.0, GitHub Copilot CLI 1.0.114, OpenCode
  1.19.6 and Pi 1.6.0. The drift lane's new OpenCode payload variants — the
  shell `execute.before` and `execute.after` shapes and the context callback's
  messages and tools — are now committed fixtures ([harness support](harness-support.md));
  which build changed each field is not established. The variants are preserved
  raw, and no normalized view reads them. Recommended ranges, reference builds
  and support levels are unchanged.
- **Toolchain updates.** pnpm 12.23.0, Vitest 5.1.1 and typescript-eslint
  8.73.0. The three minimatch catalog overrides were removed because every
  lint-tooling consumer now declares a patched 11.x line itself, and the catalog
  stays at `^11.0.9`, so GHSA-g3hv-75wg-m249 remains covered
  ([dependency notes](dependencies.md)).
- **Release checks.** The CI sidecar probe now records every request that
  reaches its stub and fails with exit 3 unless each case arrives as a single
  chat-completions request with exactly one leading system message and no
  `reasoning_effort`. It also pins the thinking request shape that Claude Code
  2.1.330 uses, so a proxy or model-shim regression surfaces in the required
  Ubuntu lane instead of a paid drift run
  ([harness-watch](harness-watch.md)).
- **Repository housekeeping.** A new `dependency-upgrades` skill documents the
  Renovate and harness-watch workflow, and the Windows PowerShell streaming test
  now writes until it reaches 20,000 lines rather than stopping at a 10-second
  cap, so a slow runner cannot fail it on line count.

## Upgrading from 0.14.1

- **Upgrade the SDK and the CLI together.** Keep `@hooknostic/sdk`,
  `@hooknostic/agent-plugin` and the `hooknostic` CLI on the same release; the
  CLI warns HN110 when it and the project's SDK differ. To upgrade:

  ```sh
  npm install --save-dev @hooknostic/sdk@0.14.2 hooknostic@0.14.2
  ```

  With pnpm, run `pnpm add -D @hooknostic/sdk@0.14.2 hooknostic@0.14.2`,
  adding `--allow-build=esbuild` if the project has not
  [allowed esbuild's install script](getting-started.md#1-install-the-authoring-and-cli-packages)
  yet.

- **Rebuild or re-sync.** Generated artifacts carry the release version, so
  their bytes change with the upgrade even though their shape does not. A
  project already synced with 0.14.1 needs no re-sync; the new version is
  recorded on the next build or sync.

## Limits

- **Validation evidence, not new capability.** The refreshed records are
  model-free playback and loopback captures. They confirm the current builds
  against existing behavior; they do not widen a recommended range, raise a
  support level, or establish a new capability.
- **OpenCode 2.4.x discovery is asserted, not implemented.** Playback answers
  `server/discover` with an empty result, as the captured harness interaction
  did. How a real 2026-07-28 MCP server answers discovery, and what OpenCode
  does with a non-empty answer, was not probed.
- **The new raw shapes stay raw.** The added shell and context fields captured
  from the 2.4.1 watch run are committed as fixtures only; no normalized view
  or effect consumes them. Consumers that read `event.raw` see them unchanged.
- **Thinking routing is recorded, not re-probed on the paid lane.** The sidecar
  probe pins Claude Code 2.1.330's adaptive-thinking request shape. The paid
  drift lane has not been rerun, and a Claude Code release that switched to
  enabled thinking would pass the pre-drive probe before failing on the drive.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
