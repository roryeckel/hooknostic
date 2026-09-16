# A non-Node MCP server, with dependencies, on every target

Evidence class: **live-probe**. Tested `uv` **0.10.3** and Python **3.13.14** on
**2026-09-16**, on native Windows, against Hooknostic's own build and generated
launcher. This probe does **not** install into a harness — see _Not measured_.

## Question

Hooknostic accepts an MCP server in any language: the `mcp.json` command grammar
has no whitelist, and the generated launcher is `cross-spawn` with
`stdio: "inherit"`. But a server with dependencies had only
`components.runtimePackage`, which is npm and Claude alone, so both other
adapters' capability rationales told the author to bundle instead — and the
bundler is esbuild.

Can a Python server with a third-party dependency be built, projected to all
three harnesses, and actually launched? And is a build-time `--target` install
safe to commit, given that artifacts are built once and installed anywhere
(ADR-0006)?

## Method

`probe/` is the package: `command: "python3"`, entry
`${PLUGIN_ROOT}/server.py`, `PYTHONPATH: ${PLUGIN_ROOT}/runtime/pypi`, and one
`components.runtime` entry declaring `pypi` with `build-materialized` delivery
against a hash-pinned `requirements.txt` from `uv pip compile
--generate-hashes`. The server imports `idna` and prints, which fails loudly if
the runtime did not resolve.

Built with `hooknostic build`, then the projected Codex server was spawned
directly through its own generated launcher:
`node runtime/mcp-launcher.mjs 0`.

Two separate `uv pip install --target` runs, of `idna` and of `pydantic-core`,
were read back file by file to test the portability verifier against real
installer output rather than synthesized bytes.

## Observations

**A Python server with a dependency builds, projects and runs.** All three
targets built with no omissions. The materialized tree landed at
`dist/claude/runtime/pypi`, `dist/codex/runtime/pypi` and — note the nesting —
`dist/opencode/package/runtime/pypi`, because OpenCode's `${PLUGIN_ROOT}` is the
nested package directory and a root-level tree there is unreachable from the
`mcp.json` naming it.

Spawned through the generated Node launcher, the server printed
`b'example.com'`: `python3` was resolved, `${PLUGIN_ROOT}` expanded in both the
argument and the `PYTHONPATH` env value, and `idna` imported from the tree
Hooknostic installed.

`hooknostic check` reported `memory: needs python3 on the consumer's PATH`.

**A `--target` install is not portable even when every wheel in it is.**
`idna` is `py3-none-any` throughout and contains no compiled code, and the
install still wrote `bin/idna.exe` — a console-script launcher the *installer*
generates, native to the machine that ran it. Twenty files installed, and the
one that would have made the tree unshippable was not from the package at all.
This is why the pypi provider drops the console-script directories: a
materialized runtime is imported through `PYTHONPATH`, and the server's own
command is declared separately in `mcp.json`, so nothing there is ever invoked.

**The verifier refuses a real compiled extension.** The `pydantic-core` install
produced `pydantic_core/_pydantic_core.cp313-win_amd64.pyd`, refused by name
with `.pyd is built for one platform`. Twenty-one files installed, one refused,
and the build fails rather than committing an artifact that is wrong for every
consumer on another platform.

**No target shipped an `.exe`.** `find dist -name "*.exe"` returned nothing
across all three outputs.

## Not measured

- **No harness installed this package.** The server was launched through the
  generated launcher directly, which exercises command resolution, placeholder
  expansion and stdio, but not a harness's own spawn. What `PATH` each harness
  hands an MCP child is still unmeasured, and a runner command such as `uvx`
  depends on it.
- **Windows shim resolution through a harness.** `mcp-launcher.test.ts` covers a
  `.cmd` at the launcher level, and `uv` is a real `.exe` here, so the case that
  matters most for runner commands — `npx` and `bun`, which exist on Windows
  only as `.cmd`/`.ps1` shims — was not exercised end to end.
- **POSIX.** Windows only. The executable-bit half of a `./`-contained command
  has no meaning here and was not observed on a platform where it does.
