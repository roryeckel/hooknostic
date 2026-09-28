# Codex hooks in linked git worktrees

Evidence class: **live-probe** (which hooks file dispatched). Codex CLI
**0.156.1** on Windows, 2026-09-27. No model credits: the model is the loopback
playback server. Secondary evidence, labelled **source-derived**: codex-rs from
`rust-v0.140.0` through `rust-v0.156.1`.

## Question

When Codex runs in a linked worktree created by `git worktree add`, which
`.codex/hooks.json` does it load: the worktree's own, or the root checkout's?

## Why this was asked

A live session (Codex 0.156.1, gpt-5.6-luna) ran in a linked worktree of a
consumer repository. The worktree held a generated `.codex/hooks.json` with a
PreToolUse shell guard. The session ran a command the guard denies, while
`codex exec` printed UserPromptSubmit and Stop hook lines but no PreToolUse.
It first looked like a Code Mode gap. `.capture/codex-code-mode` rules that out.

A read-only `hooks/list` request over `codex app-server`, for that session's
working directory, listed two hooks. Both came from the **root checkout's**
`.codex/hooks.json`: the consumer's own UserPromptSubmit and Stop hooks, both
trusted. Nothing from the worktree's generated file was listed. The printed hook
lines belonged to those other hooks.

## Method

```sh
pnpm run bundle
pnpm exec vitest run --config .capture/codex-worktree-hooks/vitest.config.ts
```

`probe.test.ts` builds a scratch repository `main` with one commit. `.codex/` and
`.claude/` are ignored so that each checkout's hooks file is its own. It then adds
a detached linked worktree, either as a sibling (`linked/`) or nested inside the
root checkout (`main/.claude/worktrees/linked`, the live layout). Each hooks file
registers a recorder for SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, and Stop, labelled by which checkout's file it is in.

Each drive runs one scripted shell call through the loopback model, with an
isolated `CODEX_HOME`, credential variables removed, and
`--dangerously-bypass-hook-trust`, so per-hook trust is not a variable. The root
checkout is trusted in every drive, as it was live. `worktreeTrusted` also trusts
the worktree explicitly. `observations.json` is the record. It carries no paths.

## Observations

| Drive | Layout | `hooks.json` in | Codex cwd | Trusted | Root checkout's hooks ran | Worktree's hooks ran |
| --- | --- | --- | --- | --- | --- | --- |
| `worktreeOnly` | sibling | worktree | worktree | root | none there | **none** |
| `both` | sibling | root, worktree | worktree | root | all five events | none |
| `worktreeTrusted` | sibling | root, worktree | worktree | root, worktree | all five events | none |
| `nested` | nested | root, worktree | worktree | root | all five events | none |
| `rootCheckout` (control) | sibling | root, worktree | root | root | all five events | none |

The shell call ran in every drive, so a missing dispatch means missing hooks, not
a missing tool call.

- **Codex never loads a linked worktree's own `.codex/hooks.json`.** This holds
  when the worktree is explicitly trusted, and when it is nested inside the root
  checkout.
- **A session in the worktree runs the root checkout's hooks instead.** If the
  root checkout has none, the session runs none, with no warning.

## Source-derived (codex-rs `config/src/loader/mod.rs`)

- `ProjectTrustContext::root_checkout_hooks_folder_for_dir`, commented "Regular
  checkouts resolve both paths to the same root; linked worktrees do not", maps
  each project directory under a linked worktree to the same relative directory
  under the root checkout (`repo_root.join(relative).join(".codex")`).
- `merge_root_checkout_project_hooks` replaces that layer's `hooks` table with the
  root checkout's.
- Hooks discovery reads `hooks.json` from the layer's `hooks_config_folder()`,
  which returns the override.
- The layer's other `config.toml` keys, such as MCP servers, still come from the
  worktree. That is source-derived only, not exercised here.
- Trust for a worktree also resolves through the root repository
  (`resolve_root_git_project_for_trust`).
- The same two functions are present at `rust-v0.140.0`, `0.144.0`, `0.148.0`,
  `0.151.0`, `0.153.2`, `0.154.0`, `0.155.0`, `0.156.0`, and `0.156.1`, which spans
  the adapter's whole profile range. That is source only. The behaviour is
  captured on 0.156.1.

## Consequences

- A Codex artifact generated **into a linked worktree** is inert for sessions in
  that worktree, whether it was copied in or written by project integration. The
  hooks that run are whatever the root checkout's `.codex/hooks.json` holds: an
  older generation, another tool's hooks, or nothing.
- To take effect in a worktree, a guard change has to be present, and trusted,
  in the root checkout's `.codex/hooks.json`. A branch cannot exercise its own
  changes from its worktree.
- Codex prints `hook: <Event>` lines for the root checkout's hooks, so a worktree
  session looks hooked. Verify by effect, as `docs/installing-artifacts.md`
  already says for skipped hooks.
- Recorded in the Codex profile and in `docs/installing-artifacts.md`. Hooknostic
  itself does not yet detect the situation.

## Limits

- Windows only. The loader is platform-independent code, but POSIX was not run.
- Only project `.codex/hooks.json` was exercised. Inline `[hooks]` in a project
  `config.toml` goes through the same merge (source). Hooks from an installed
  plugin or from the user's Codex home are not project layers and were not driven.
- Per-hook trust was bypassed. Live, the trust keys for a worktree session are the
  root checkout's `hooks.json` path (`<root>\.codex\hooks.json:<event>:0:0` in the
  `hooks/list` above), so trust is granted, and goes stale, there too.
