# Hooknostic documentation

Welcome! This is the documentation hub for Hooknostic — write lifecycle hooks for
coding agents once, and compile them into native integrations for Claude Code, OpenAI
Codex CLI, and OpenCode.

Pick your path:

## 🚀 Start here

| Page | What you'll get |
| --- | --- |
| [Core concepts](concepts.md) | The five ideas everything else builds on — harnesses, events, effects, capabilities, and the build pipeline — in plain language, ~10 minutes |
| [Getting started](getting-started.md) | A hands-on walkthrough: empty folder → working hook → built output installed in a real agent |

## 📚 Tutorials

Step-by-step walkthroughs, each built on a runnable project in [`examples/`](../examples/):

| Tutorial | Teaches | Example |
| --- | --- | --- |
| [1. Your first hook](tutorials/01-your-first-hook.md) | Blocking a dangerous command; observing events; `check` vs `build` | [`examples/basic`](../examples/basic/) |
| [2. Rewriting tool input](tutorials/02-rewriting-tool-input.md) | Required vs optional capabilities; feature detection; graceful degradation | [`examples/rewrite-shell`](../examples/rewrite-shell/) |
| [3. Injecting context](tutorials/03-injecting-context.md) | Adding model-visible context; when a target can't do what you want; per-target policies | [`examples/context-injection`](../examples/context-injection/) |
| [4. Packaging with Agent Plugins](tutorials/04-packaging-with-agent-plugins.md) | Combining hooks with a portable Agent Plugins package (skills + manifest) | [`examples/agent-plugin`](../examples/agent-plugin/) |

## 🛠 Guides

| Guide | When to read it |
| --- | --- |
| [Installing built output](installing-artifacts.md) | You ran `hooknostic build` and want each agent to actually load the result — including the common case of a repo consuming its own hooks |
| [Adding a harness adapter](adding-an-adapter.md) | You want Hooknostic to support another coding agent |
| [Publishing & release process](publishing.md) | Maintainers: testing the npm story without publishing, and the eventual release flow |

## 📖 Appendix — reference material

| Reference | What it is |
| --- | --- |
| [Glossary](glossary.md) | Every term of art in these docs, defined in a sentence or two |
| [Design document](design.md) | The complete technical design: contracts, diagnostics, adapter interfaces, test strategy, milestones. The deep end — read the concepts page first |
| [Native surface baseline](baseline-2026-08-20.md) | The verified snapshot of each harness's real hook behavior (captured 2026-08-20) that the adapters are built against — including where vendor docs turned out to be wrong |
| [Design decisions](decisions/) | The foundational choices, each recorded with its context and consequences |

## How the pieces fit

```
your TypeScript hooks  ──▶  hooknostic check   "will this work on every target?"
        │                          │
        │                          ▼
        └──────────────▶  hooknostic build ──▶  dist/claude/    a Claude Code plugin
                                                dist/codex/     a repo-level .codex/ tree
                                                dist/opencode/  an .opencode/ plugin module
```

Each output directory is self-contained and independently distributable. Installing
them into a harness is a deliberate manual step ([why?](installing-artifacts.md)) —
Hooknostic never touches an agent's trust or configuration state.
