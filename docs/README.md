# Hooknostic documentation

Welcome! This is the documentation hub for Hooknostic — portable hooks, skills, and MCP servers, compiled into native packages or project integrations for Claude Code, OpenAI
Codex CLI, and OpenCode.

Pick your path:

## Choose a workflow

- [Distribute a standards-based package](tutorials/04-packaging-with-agent-plugins.md): Agent Plugins 1.0 → native Claude/Codex marketplace plugins or OpenCode packages.
- [Maintain a repository](project-integration.md): direct hooks, skills, MCP, and agents with init, sync, and verify.
- [Configuration and commands](configuration.md): source forms, delivery, policies, and build reports.

## 🚀 Start here

| Page | What you'll get |
| --- | --- |
| [Core concepts](concepts.md) | The five ideas everything else builds on — harnesses, events, effects, capabilities, and the build pipeline — in plain language, ~10 minutes |
| [Getting started](getting-started.md) | A hands-on walkthrough: empty folder → working hook → built output installed in a real agent |
| [Writing hooks safely](writing-hooks-safely.md) | The rules a bundled hook must follow — stdout, side effects, `process.execPath`, stop loops — and `HOOKNOSTIC_DEBUG` for when a hook does nothing |

## 📚 Tutorials

Step-by-step walkthroughs, each built on a runnable project in [`examples/`](../examples/):

| Tutorial | Teaches | Example |
| --- | --- | --- |
| [1. Your first hook](tutorials/01-your-first-hook.md) | Blocking a dangerous command; observing events; `check` vs `build` | [`examples/basic`](../examples/basic/) |
| [2. Rewriting tool input](tutorials/02-rewriting-tool-input.md) | Required vs optional capabilities; feature detection; graceful degradation | [`examples/rewrite-shell`](../examples/rewrite-shell/) |
| [3. Injecting context](tutorials/03-injecting-context.md) | Adding model-visible context; when a target can't do what you want; per-target policies | [`examples/context-injection`](../examples/context-injection/) |
| [4. Packaging with Agent Plugins](tutorials/04-packaging-with-agent-plugins.md) | Combined hooks, skills, bundled MCP, and Claude/Codex marketplace installation | [`examples/agent-plugin`](../examples/agent-plugin/) |
| [5. One agent, every harness](tutorials/05-portable-agents.md) | A portable agent definition; what each harness honors; `native` fields; package routes | [`examples/local-project`](../examples/local-project/) |

## 🛠 Guides

| Guide | When to read it |
| --- | --- |
| [Installing built output](installing-artifacts.md) | You ran `hooknostic build` and want each agent to actually load the result — including the common case of a repo consuming its own hooks |
| [Testing your hooks](testing-your-hooks.md) | You want tests that assert what your hooks decide on each target, with `hooknostic dispatch`, without writing any harness's wire format |
| [Contributing](../CONTRIBUTING.md) | What is in scope, what evidence a change needs, how to run the gates — read before opening an issue or a pull request |
| [Adding a harness adapter](adding-an-adapter.md) | You want Hooknostic to support another coding agent |
| [Publishing & packaging](publishing.md) | Maintainers: what ships, and testing the npm story without publishing |
| [Releases](releases.md) | Maintainers: the three-stage release pipeline, gates, and recovery paths |
| [Harness support](harness-support.md) | Generated: validated harness versions and evidence |
| [Testing without model spend](testing.md) | Maintainers: real-harness CI with recorded payloads and loopback model playback |

## 📖 Appendix — reference material

| Reference | What it is |
| --- | --- |
| [Glossary](glossary.md) | Every term of art in these docs, defined in a sentence or two |
| [Design document](design.md) | The complete technical design: contracts, diagnostics, adapter interfaces, test strategy, milestones. The deep end — read the concepts page first |
| [Native surface baseline](baseline-2026-08-20.md) | The verified snapshot of each harness's real hook behavior (captured 2026-08-20) that the adapters are built against — including where vendor docs turned out to be wrong |
| [Design decisions](decisions/) | The foundational choices, each recorded with its context and consequences |

## How the pieces fit

```text
hooks + Agent Plugins package ── check / build ── native distributable packages
hooks + direct skills / MCP ──── sync ─────────── native project integration
                                verify ───────── drift detection
```

Source packages stay portable. Adapters own target formats and report support differences.
`build` writes artifacts; `sync` maintains project discovery and ownership records.
Harness trust and approvals remain explicit user steps.
