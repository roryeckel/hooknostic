## OpenCode v2 support

The public adapter remains `opencode`. Your configured version range selects
v1 or v2; the installed CLI does not override that choice. New configurations
recommend v2, while explicit v1 targets retain their own implementation and
validation. To build both, use two named targets with separate output directories.
A range spanning both families is rejected with HN203.

V2 supports portable hooks, skills, and stdio/Streamable HTTP MCP through
project and package delivery. Coverage includes model context on ordinary,
title, generation, and compaction requests over the captured HTTP provider
paths, plus default MCP OAuth against a local test issuer.

Support has explicit limits:

- Session-start observation, typed tool-error observation, permission handling,
  model context, and output conversion have approximate coverage. Plain custom
  tool exceptions can bypass observation; permissions cover pending ask decisions.
- Generated portable notifications, stop prevention, and legacy MCP SSE remain
  unsupported. A successful native TUI notification probe does not enable
  generated notification delivery.
- MCP calls remain `kind: "other"`; `kind: "mcp"` guards do not cover them.
  A captured native name can be guarded explicitly.
- WebSocket and other provider paths, provider/custom OAuth, executed websearch,
  and background or deeply nested subagents remain unverified. macOS has unit
  and fixture coverage, but no real-harness playback evidence.

See [OpenCode families](opencode-families.md) for migration instructions,
evidence, and the supported alternatives. The support table below records each
family's reference build separately; v1 evidence does not establish v2 support.
