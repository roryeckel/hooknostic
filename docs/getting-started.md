# Getting started

This walkthrough takes you from an empty folder to portable hooks running in a real
coding agent. It's the long-form version of what the [tutorials](tutorials/) then build
on. Time: about 15 minutes.

**Prerequisites:** Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, and at least one supported agent installed
(Claude Code, OpenAI Codex CLI, OpenCode, or Pi). The sample config below uses
the first three; [Pi installation](installing-artifacts.md#pi) covers its project
and package routes.

For a combined standards-based package, start with [packaging and marketplaces](tutorials/04-packaging-with-agent-plugins.md). For repository integration, use [init, sync, and verify](project-integration.md). This walkthrough retains the hooks-only authoring path.

## 1. Install the authoring and CLI packages

Hook authors use `@hooknostic/sdk` (the authoring API) and `hooknostic` (the CLI).
`@hooknostic/agent-plugin` is the public loader/projection-contract package for tool
authors; the CLI already contains what it needs to project Agent Plugins.

Give the empty folder its own `package.json` before you install: without one,
npm installs into the nearest parent folder that has one. Hooknostic is ESM, so
set `"type": "module"` too:

```bash
npm init -y
npm pkg set type=module
npm install --save-dev @hooknostic/sdk hooknostic
```

With pnpm 12, `pnpm init` already sets `"type": "module"`. Allow esbuild's
install script when you add the packages, or pnpm exits 1 with
`ERR_PNPM_IGNORED_BUILDS` on this and every later install:

```bash
pnpm init
pnpm add -D --allow-build=esbuild @hooknostic/sdk hooknostic
```

Then run each `npx hooknostic` command below as `pnpm exec hooknostic`: `pnpm init`
names pnpm in the `devEngines` field, so npm's `npx` refuses to run in the project.

Hooks and configuration never import Zod, and the generated runtimes carry their
own copy. Only code that imports the SDK's runtime schemas from
`@hooknostic/sdk/schemas` uses it. If yours does, list `zod@^4.6.7` in your own
dependencies, because your code imports it. Under Yarn Plug'n'Play that import
fails until you do.

Under Yarn Plug'n'Play, run each `npx hooknostic` command below as
`yarn hooknostic`: outside Yarn's runtime the build fails with HN504. Either
form runs the project's own CLI. A global or `yarn dlx` `hooknostic` on
another release than the project's `@hooknostic/sdk` does not warn HN110
there: a global run outside Yarn's runtime cannot resolve the project's SDK,
and under `yarn dlx` looking it up would break the build (#216).

> **Trying unreleased changes?** The commands above install the latest release
> from npm. To try a checkout of this repo instead, pack the SDK and CLI from it
> as tarballs and install both of those, so they stay on one release; the
> [publishing guide](publishing.md#testing-without-publishing-the-everyday-flow)
> shows the packing commands. Everything below is identical from that point on.

Add TypeScript if you want type checking while authoring. It's optional: the CLI
bundles your source itself, so a separate compile step isn't required.

## 2. Write your first hook

Create `src/hooks.ts`:

```ts
import { definePlugin, hook, block } from "@hooknostic/sdk";

export default definePlugin({
  name: "my-first-hooks",
  version: "0.1.0",
  hooks: [
    hook("tool.before", {
      id: "no-force-push",
      match: { kind: "shell" },                       // any shell tool, on any harness
      capabilities: { block: "required" },            // we rely on being able to block
      run({ tool }) {
        const command = tool.shell?.command;          // normalized: Bash, PowerShell, bash, shell, powershell, …
        if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
        if (/git\s+push\s+.*--force(?!-with-lease)/.test(command)) {
          return block("Use --force-with-lease instead of --force.");
        }
        // returning nothing = let the command through
      },
    }),
  ],
});
```

Three things to notice:

- `match: { kind: "shell" }` uses the portable tool classification — you don't need to
  know that Claude names its shell tool `Bash`. `tool.shell.command` is the command
  normalized the same way; it is undefined only for a shell tool whose argument shape
  has not been captured, and this guard refuses what it cannot read.
- The `capabilities` block declares what the hook *relies on*. This is what lets
  Hooknostic verify, per target, that the hook will actually work — before anything is
  generated. Keys are relative to the hook's event: `block` here means
  `tool.before.block`, the full id diagnostics and reports print.
- The hook returns an *effect* (`block(...)`), a list of effects, or nothing. It never
  talks to a harness directly.

## 3. Configure your targets

Create `hooknostic.config.ts`:

```ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    claude:   { version: ">=2.1 <3",   delivery: "package", output: "./dist/claude" },
    codex:    { version: ">=0.148 <1", delivery: "project",  output: "./dist/codex" },
    opencode: { version: ">=1.18 <2",  delivery: "project",  output: "./dist/opencode" },
  },
});
```

Delete any target you don't use. The `version` ranges pin which harness versions the
build is validated against — builds compile against these ranges, never against
whatever happens to be installed, so they're reproducible on any machine.

## 4. Check before you build

```bash
npx hooknostic check
```

`check` answers one question — *can this source deliver its declared behavior on every
configured target?* — and writes no files. If a target can't support something a hook
marked `required`, you get a compiler-style diagnostic naming the hook, the capability,
the target, and your options:

```
HN201 capability unsupported

  src/hooks.ts:18
  hook "approve-database"

  requires: tool.before.requestApproval
  target:   codex
  support:  unsupported

  Remediation: make the capability optional, add a target-specific
  fallback, exclude codex from this hook, or narrow the build target.
```

Our force-push guard only needs `tool.before.block`, which all three configured harnesses support
exactly, so `check` passes clean. Put this command in CI.

## 5. Build

```bash
npx hooknostic build
```

This runs the same analysis, then bundles your hook code, emits one self-contained
directory per target, and writes the build report beside the config:

```
hooknostic.config.ts
hooknostic-build.json    ← the build report
dist/
├── claude/     a complete Claude Code plugin (manifest + hooks.json + bundled runtime)
├── codex/      a .codex/ tree to copy into a repo root
└── opencode/   an OpenCode project plugin tree (.opencode/plugins/hooknostic.js)
```

The build is atomic — if any selected target fails, nothing is written. Open
`hooknostic-build.json` to see exactly how every capability resolved on every target;
it's the first place to look whenever behavior differs across harnesses.

Want fewer targets for a quick iteration? `npx hooknostic build --target claude`
narrows the set (it can only narrow — the config defines what's allowed).

## 6. Install the output into a harness

`hooknostic build` stops at its configured output; `hooknostic sync` additionally maintains project wiring ([guide](project-integration.md)) — every harness gates hook loading behind its
own trust and review mechanism, and Hooknostic never touches that state. The fastest
path per harness:

- **Claude Code** — try it for one session, no install:

  ```bash
  claude --plugin-dir ./dist/claude
  ```

- **Codex CLI** — copy the tree to your repo root, then let Codex's own trust prompts
  run:

  ```bash
  cp -r dist/codex/.codex .
  ```

  In a linked git worktree, copy it to the root checkout instead. Codex never
  loads a worktree's own `.codex/hooks.json`
  ([details](installing-artifacts.md#codex-cli)).

- **OpenCode** — copy the tree to your repo root:

  ```bash
  cp -r dist/opencode/.opencode .
  ```

Test the decision first with [portable-event dispatch](testing-your-hooks.md). For a harmless live activation check, use the marker command in the [combined example](../examples/agent-plugin/README.md); do not use a real force push as an installation test.

The full installation story — installing the Claude output as a proper plugin, version
bumping, Codex trust configuration, committing `dist/` vs building on demand — is in
[Installing built output](installing-artifacts.md).

## 7. Two more commands worth knowing

```bash
npx hooknostic doctor            # are my *installed* harness versions inside the validated ranges?
npx hooknostic inspect claude    # show the capability table: what can this target do, and why?
```

`doctor` inspects installed versions, runtime availability, and project wiring; it warns when an installed
harness is newer than what the adapter has been validated against. It exits 2 when
a configured harness isn't installed (`MISS`) or is outside its supported range
(`WARN`), so with this config it exits 2 on a machine that lacks any of the three
or has one outside its supported range, such as OpenCode 2.x against `>=1.18 <2`.
`inspect` renders the adapter's capability table — support level and rationale per
capability — which is how you answer "would `requestApproval` work on OpenCode?"
without trial and error.

## Where next

- [Writing hooks safely](writing-hooks-safely.md): read before you ship — what a bundled
  hook must not do, and `HOOKNOSTIC_DEBUG` for when one does nothing.
- [Tutorial 2 — Rewriting tool input](tutorials/02-rewriting-tool-input.md): optional
  capabilities and graceful degradation, the feature that makes portability practical.
- [Tutorial 3 — Injecting context](tutorials/03-injecting-context.md): what happens
  when a target genuinely can't do what you asked, and how policies let you decide.
- [Core concepts](concepts.md) if you skipped it — ten minutes that make everything
  else make sense.
