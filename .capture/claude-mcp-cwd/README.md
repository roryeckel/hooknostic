# Claude plugin MCP working directory probe

Evidence class: **live-probe**. Tested Claude Code **2.1.260** on
**2026-09-07**, on Linux under WSL. The observation is subprocess output,
not a verbatim hook payload.

## Method

Run Claude headlessly from `/tmp/hooknostic-cwd-probe/project`, loading
`/tmp/hooknostic-cwd-probe/plugin` with `--plugin-dir`. The plugin declares
a stdio MCP server running Node that writes `process.cwd()` and its expanded
`CLAUDE_PLUGIN_ROOT` environment value before completing MCP initialization.
Both project and plugin contain an `mcp-working-dir` directory. Run once
with native `cwd: "./mcp-working-dir"`, then with
`cwd: "${CLAUDE_PLUGIN_ROOT}/mcp-working-dir"`. Model traffic goes only to a
loopback scripted server with a dummy credential; no paid model is used.

## Observation

Both Claude sessions exited 0. In both cases the MCP subprocess recorded:

```json
{
  "cwd": "/tmp/hooknostic-cwd-probe/project",
  "pluginRoot": "/tmp/hooknostic-cwd-probe/plugin"
}
```

The root variable expands, but neither native cwd spelling changes the
subprocess working directory on this tested version. Merely translating
portable relative cwd to the native plugin-root variable cannot establish
package-relative execution. The native-field probe alone does not establish
portable cwd support;
the launcher verification below does.

## Launcher verification

On the same version/date, repeated the cross-directory session with the
projector's generated Node launcher, passing the expanded plugin working
directory, server command, and arguments as separate argv entries. The launcher
spawns the server with `cwd` and inherited stdio. Claude exited 0, MCP initialized,
and the server recorded:

```json
{
  "cwd": "/tmp/hooknostic-cwd-probe/plugin/mcp-working-dir",
  "pluginRoot": "/tmp/hooknostic-cwd-probe/plugin"
}
```

The launcher is required to implement portable cwd on this version. It also
establishes the default plugin-root cwd when cwd is omitted. It requires Node,
as do Hooknostic's generated Claude command hooks.

## Production projection playback

`HOOKNOSTIC_PLAYBACK=claude HOOKNOSTIC_PLAYBACK_VERSION=2.1.260 pnpm exec vitest run packages/cli/test/harness-playback.test.ts`
also passed on the date above: 24 passed, 4 skipped. The projection scenario
loaded the actual projected package from a separate project directory and
asserted that the MCP subprocess cwd was `<plugin>/mcp-working-dir`, alongside
skill discovery, root/data expansion, HTTP/SSE initialization, and combined
hook execution. The skipped cases include unavailable PTY drivers; this run
makes no new interactive-permission claim.
