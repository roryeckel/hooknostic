# Decision 0017 — MCP server runtime dependencies are language-neutral

**Status:** Accepted — 2026-09-16 · Referenced from code and docs as **ADR-0017** · Generalizes [ADR-0012](0012-claude-plugin-runtime-dependencies.md)

**In short:** What an MCP server needs at run time is declared per ecosystem, and which
deliveries an ecosystem may use is decided by one rule — whether its materialized output
is the same bytes on every machine. Hooknostic will perform a locked, script-free install
at build time for an ecosystem that passes that test, and refuses to for one that does
not, whatever language it is.

## Context

Hooknostic has always **accepted** MCP servers in any language. The `mcp.json` command
grammar has no whitelist and no interpreter sniffing; the generated launcher is
`cross-spawn` with `stdio: "inherit"`, with no module resolution and no `NODE_OPTIONS`;
`uvx` has been a projection fixture since before this decision.

What it did not have was any way to say what such a server *needs*. The single mechanism,
`components.runtimePackage`, is an npm manifest and an npm lockfile — pnpm and Yarn locks
are refused by name — and it is honoured by Claude alone, because Claude is the only
harness that installs anything (ADR-0012). Both other adapters' capability rationales
therefore told the author to "bundle the dependencies instead", and the bundler is
esbuild. A Python, Go, Rust or .NET server was left with no declared answer at all, and
the answer it was given in prose was one only JavaScript can take.

Three further things were measured rather than assumed, and each shaped this decision:

- A virtualenv's `bin/python` is a symlink to the interpreter that built it, so
  `inventory` resolved outside the package root and failed the **whole package**.
  `node_modules` never hit this because it is excluded by name; `.venv` was not.
- `uv pip install --target` of `idna` — `py3-none-any` throughout, with no compiled code
  anywhere in it — still writes `bin/idna.exe`. The *installer* generates platform-native
  console-script launchers, so a `--target` tree is platform-specific even when every
  wheel in it is pure.
- The same command against `pydantic-core` writes
  `_pydantic_core.cp313-win_amd64.pyd`, which is what a committed artifact must never
  carry.

## Decision

`components.runtime` declares runtime dependencies as a list of per-ecosystem entries.
`components.runtimePackage` remains the shorthand for its `npm` + `harness-installed`
case; both spellings converge before any projector sees them, and declaring both at once
is a configuration error rather than a silent preference.

Each ecosystem declares which of three deliveries it can offer:

| Delivery | Who installs | Available to |
| --- | --- | --- |
| `harness-installed` | the harness, in its own cache | npm, on Claude only (ADR-0012) |
| `build-materialized` | Hooknostic, at build time, committed | any ecosystem whose output is portable |
| `author-supplied` | nobody — it is already in the package | every ecosystem |

**The rule that decides which is the portability of the produced bytes, not the identity
of the package manager.** A Hooknostic artifact is built once and committed (ADR-0006),
then installed on whatever machine a consumer has. So a materialized tree is admissible
only when it means the same thing everywhere:

| Ecosystem | Materialized output | Portable |
| --- | --- | --- |
| npm, pure JavaScript | `node_modules` | yes |
| PyPI, `py3-none-any` wheels | a `--target` tree | yes |
| NuGet, framework-dependent | IL assemblies | yes |
| npm with native addons, non-`any` wheels, self-contained .NET | platform binaries | no |
| Cargo, Go | one native binary per target triple | no, by construction |

This is the whole answer to "what about Rust, or Go, or .NET". They are not special cases
and not omissions: they are the same rule applied to different bytes. A native toolchain
gets `author-supplied` — prebuilt binaries the author ships per platform, copied verbatim
— or the server is declared as a runner command such as `docker`. Each is listed in the
provider table with its reason, so an author reaching for one is told the answer instead
of inferring it from an unknown-ecosystem error.

**Portability is checked, not trusted, and checked over the bytes rather than the
ecosystem's promises** — ELF, Mach-O and PE headers, and the extensions that only ever
name a compiled object. Reading the bytes is what makes the rule hold for ecosystems
nobody has written a provider for, and it is also the only thing that would have caught
`bin/idna.exe`, which no statement about wheel tags predicts. A PE requires its signature
at `e_lfanew` rather than a bare `MZ`, because a false reject blocks a build that was
fine; and a JVM class file is told from the universal Mach-O it shares `0xCAFEBABE` with.

A `build-materialized` install is locked, offline and script-free. For PyPI that is
`--require-hashes` and `--only-binary=:all:`, the second being this ecosystem's
`--ignore-scripts`: a source distribution executes its own setup code at install time and
a wheel does not. Validation refuses an unpinned or unhashed requirement, an editable
requirement, and a `--no-binary` directive, before any install is attempted.

### On ADR-0012

ADR-0012 says *"Claude owns the subsequent locked install in its cache; Hooknostic neither
invokes a package manager nor writes `node_modules`."* That sentence is the back half of a
contrast about **who performs the `runtimePackage` install on Claude**; its Context assumes
*"an MCP server implemented with ordinary Node.js imports"*, and the decisions index frames
the record as *"How can projected Claude MCP servers resolve Node dependencies?"*

It was read as a project-wide prohibition, and that reading is what kept every non-npm
ecosystem out. It is not one. Hooknostic still performs no npm install of its own — that
half is unchanged and remains true — but it will invoke an ecosystem's installer for a
`build-materialized` declaration that asked for it, under the constraints above.
ADR-0012's npm contract is otherwise untouched and is now one provider among several.

## Consequences

- A non-Node MCP server has a declared, validated answer for its dependencies, and what
  it needs from the consumer's machine is reported by `check` and probed by `doctor`.
- Hooknostic gains a build-time dependency on an ecosystem's installer, but only for a
  declaration that opted in. A missing tool is a build error naming the tool and the
  `author-supplied` alternative, never a silent skip.
- The portability verifier can be wrong in both directions. It is written to prefer a
  false reject, and both directions are tested.
- A `build-materialized` tree enlarges every target's output, and ADR-0006's drift gate
  makes that visible on the next build, which is the intended way to find out.
- `.venv`, `__pycache__`, `.tox` and friends join the default exclusions. `vendor` and
  `target` deliberately do **not**: Go's `vendor/` is meant to be committed, and a
  prebuilt binary is how a native toolchain supplies its runtime — excluding either would
  break the one delivery those ecosystems have.

## Status of what this does not do

Bundling Node MCP servers, so that an npm runtime stops depending on Claude's install, is
a separate change. Under this decision it is the npm/`build-materialized` cell of the same
table rather than a new concept.
