# OpenCode v2 remote MCP

Windows, `@opencode/cli` 2.0.17, 2026-09-26. Local HTTP/SSE fixtures and a
loopback model, with isolated OpenCode state. No OAuth, publication or paid
model. After bundling, run the driver from the repository root:

```
node --experimental-strip-types .capture/opencode-v2/drive.mjs remote
node --experimental-strip-types .capture/opencode-v2/drive.mjs remote-legacy
node --experimental-strip-types .capture/opencode-v2/drive.mjs project-remote
node --experimental-strip-types .capture/opencode-v2/drive.mjs package-remote
```

Streamable HTTP initializes, lists tools and receives `tools/call`; its
sentinel reaches the model through Code Mode. Generated project delivery
expands a URL-path fallback and header environment reference. A missing
required header variable disables only that server, which receives no
requests. Generated package delivery is packed with pnpm, installed locally
and relocated. Its declared placeholder-like header stays literal, as the
portable package contract requires. Requests capture the actual headers.

Legacy SSE remains unsupported. The native probe registers a real SSE
endpoint that rejects POST and would supply an event stream on GET. With
both default protocol selection and explicit `legacy`, OpenCode sends POST,
receives 405 and reports the server failed; it never attempts GET. An initial
fixture compared the full URL without stripping OpenCode's `codemode=false`
query and accidentally accepted POST on the SSE path. That result was
discarded. The final fixture compares the pathname and regression tests
assert the failed connection and absence of fallback.

`fixtures/opencode/2.0/remote/observations.json` contains captured requests
and native MCP status snapshots, labelled by constructed scenario names.
OAuth and authenticated external services remain unverified. A dummy header
is evidence of forwarding only, not of an authentication exchange.

Regression mutants remove the generated project configuration, drop package
headers, and restore the erroneous full-URL SSE comparison. Each focused
playback test fails against its defect; original source bytes are restored.
Both delivery routes and both SSE controls pass in the 19-scenario Windows
v2 lane. See the session capture record for repository gate results.
