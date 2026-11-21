# Versions at a glance, and a lock that clears itself

0.14.0 is about knowing which releases are running and trusting what a sync
left behind. `hooknostic --version` prints the CLI's release, and `doctor`
opens with the CLI, the project's `@hooknostic/sdk` and Node.js. The HN110 and
HN109 warnings now name paths without a machine's directories, `doctor`
reports HN110 for every configuration, and HN110's advice spells out the
install command to run: npm's, pnpm's with esbuild's install script allowed
where pnpm needs that, or Yarn's. pnpm's own Plug'n'Play mode is no longer
mistaken for Yarn's. `recover` clears a lock a dead process left, project
writes are flushed before they are reported written, and a WSL mount that
keeps no file modes no longer makes `verify` treat every generated file as
modified. Under Yarn Plug'n'Play, `sync` and MCP components now work.

Several command-line behaviours change, and the upgrade steps below cover them.

## Upgrading from 0.13.x

- **Upgrade the SDK and the CLI together.** Keep `@hooknostic/sdk`,
  `@hooknostic/agent-plugin` and the `hooknostic` CLI on the same release; the
  CLI warns HN110 when it and the project's SDK differ. To upgrade:

  ```sh
  npm install --save-dev @hooknostic/sdk@0.14.0 hooknostic@0.14.0
  ```

  With pnpm, run `pnpm add -D @hooknostic/sdk@0.14.0 hooknostic@0.14.0`,
  adding `--allow-build=esbuild` if the project has not
  [allowed esbuild's install script](getting-started.md#1-install-the-authoring-and-cli-packages)
  yet.

- **Commands refuse options and words they do not accept.** Each command now
  takes only what its usage line shows, plus `-h`/`--help`; `inspect` alone
  takes a word, its target. Input a command used to ignore is a usage error:
  exit 2, reported before it reads a config or writes a file. That covers
  `check --dry-run`, `dispatch --local`, an `--events` file given to `init`
  or `sync`, and a second word to `inspect`. `sync`, `verify` and `recover`
  now reject `--target` as a usage error rather than a partial-selection
  error; both exit 2, but under `--json` the usage line replaces the full
  project result. A usage error keeps its single JSON line under `--json`.
- **`dispatch --json` is a usage error.** `dispatch` always writes JSON Lines,
  so `--json` is reported as text on stderr, with the usage, and exits 2. It
  is checked before anything else, including an unreadable `--events` file.
- **`-v` means `--version`.** In the command position,
  `hooknostic --version` and `hooknostic -v` print the CLI's release and exit
  0. After `inspect`, `--version <range>` remains the harness version range.
- **`doctor --json` gains two fields.** `runtime.hooknostic` and
  `runtime.sdk` join `runtime.node`; `runtime.sdk` appears only when there is
  a config. The addition is additive, so `schemaVersion` stays 2.
- **Expect new output lines.** `sync`, `verify`, `recover` and `doctor` now
  print each diagnostic's `Remediation:` line, as `check` and `build` do.
  `doctor` also starts its text output with a version line, and may now print
  HN110 where it previously said nothing.
- **Rebuild packages and re-sync projects.** Generated artifacts carry the
  release version, so their bytes change with the upgrade. A project whose
  configuration `entry` sits in a package with its own `@hooknostic/sdk` also
  gets a different bundle: the entry now uses that SDK and the runtime uses
  the CLI's, as an npm-run build already did.

## What is new

- **`hooknostic --version`, and versions in `doctor`.** `doctor`'s text
  output starts with one line, such as
  `hooknostic 0.14.0, project @hooknostic/sdk 0.14.0 (Node.js v24.20.0)`.
  It is printed before the config loads, so a bug report has it even when the
  load hangs or fails. `doctor --json` carries the same facts under
  `runtime`.
- **HN110 tells you what to install.** Its advice now names a command with the
  SDK's version, without build metadata:
  `npm install --save-dev --save-exact hooknostic@<version>`,
  `pnpm add -D hooknostic@<version>`, or `yarn add -D hooknostic@<version>`
  under Yarn Plug'n'Play. npm gets `--save-exact` because it would otherwise
  save a `^` range and let the CLI move away from the SDK again. pnpm's
  command carries `--allow-build=esbuild` when the project's install record
  names pnpm 10.4.0 or later, which accepts the option; earlier pnpm refuses
  it, so the command leaves it out.
- **pnpm's Plug'n'Play mode is told apart from Yarn's.** A Plug'n'Play
  manifest is pnpm's when pnpm's install record says `nodeLinker: pnp`, or
  when `pnpm-lock.yaml` sits beside it and `yarn.lock` does not. Such a
  project is now advised to run `pnpm exec hooknostic` rather than
  `yarn hooknostic`.
- **`doctor` reports HN110 for every configuration.** A package-only or
  hooks-only configuration, a config that fails to load, and targets with no
  registered adapter all report the skew that a build would hit. HN110 stays a
  warning and never changes the exit code.
- **The moved-schema hint reaches every command.** A config or hook source
  that imports a schema from `@hooknostic/sdk` that lives at
  `@hooknostic/sdk/schemas` gets an HN501 remediation naming the subpath, the
  import to write, and the upgrade guide. `sync`, `verify`, `recover` and
  `doctor` now print it too, and doctor's top-level `diagnostics` carries
  them as well.

## What is fixed

### Releases and paths

- **HN110 compares the SDK the build sees.** It resolves the project's
  `@hooknostic/sdk` by walking `node_modules` from the configuration's
  directory and its ancestors, as `doctor` already did, rather than through
  Node's resolver. An SDK that only `NODE_PATH` (which pnpm's bin shims set)
  or a global folder reaches no longer triggers HN110, and no longer stands in
  for the project's SDK in the bundle, where a foreign or incomplete copy used
  to fail the build with HN301.
- **HN110 and HN109 name no machine directory.** Under `yarn hooknostic`, the
  SDK and the Zods are named `from Yarn's Plug'n'Play install` rather than by
  their archive path. Inside the configuration's directory, a path is relative
  to it and uses forward slashes.
- **The SDK names `main`.** pnpm 12's Plug'n'Play runtime resolves a package
  by its directory, through `main`, and ignores `exports`; the SDK now names
  both. `exports` still wins wherever it is read. An SDK of 0.13.0 or earlier
  remains `not-found` under `pnpm exec`.

### Project state

- **`recover` clears a dead process's lock.** A hard kill during `sync` or
  `recover` used to leave `sync.lock` or `recovery.lock` behind until it was
  deleted by hand. `recover` now clears either lock when its recorded process
  ID names a process that has exited, and refuses one held by a live process,
  a reused ID, or no valid ID, naming the ID and the lock's path. It claims
  the lock by renaming it into `.hooknostic/staging` and rechecks its identity
  before removing it, so a peer's fresh lock is not taken.
- **A failed write no longer leaves a lock behind.** Locks, staged files and
  the journal are written, flushed with `fs.fsync`, then closed; a failure
  after creating one removes it again. A flush error such as `EIO` still
  aborts the sync.
- **A leftover lock names `recover`.** A sync that finds `sync.lock` reports
  that another sync or recover may be running and names `recover`, to run
  with the same configuration, instead of Node's raw `EEXIST`.
- **File modes are compared only where the filesystem keeps them.** On a WSL
  checkout under `/mnt/c`, with DrvFs mounted without metadata, every file
  read `0777` and `chmod` changed nothing, so `verify` and a second `sync`
  reported every generated file as modified, and `recover` reported a
  conflict. Modes are now unobserved there and content is still compared;
  Windows behaved this way already. A Windows path containing a space in a
  DrvFs mount's `path=` option no longer hides a metadata mount's option.

### Yarn Plug'n'Play

- **`sync` works under Yarn's runtime.** It used to fail with
  `Method not implemented.` from Yarn's patched file handle and leave its lock
  behind, after which every later sync failed with `EEXIST`. The opt-in Yarn
  suite now runs `init --local`, `sync` twice and `verify` under
  `yarn hooknostic`.
- **MCP components build under Yarn Plug'n'Play.** Every MCP component failed
  with HN301 when Yarn used its global cache, because the launcher's
  dependencies could not be resolved from inside Yarn's archives. The
  launcher now resolves its imports through the PnP API that serves the CLI.
  Generated launcher bytes are unchanged.
- **[ADR-0041](decisions/0041-yarn-pnp-runtime.md) records the supported
  surface.** `yarn hooknostic` and, for a CLI installed outside the project,
  `node -r ./.pnp.cjs <cli>/bin/hooknostic.mjs`, run from the project
  directory, are supported. Plain `node`, `npx`, a global install run
  directly and `pnpm dlx` fail with HN504 when a build needs a package from
  Yarn's install. `yarn dlx` stays best effort.

## Limits

- **HN110 is a warning, and compares release numbers, not contents.** It does
  not run for `dispatch`, and it stays silent under `yarn dlx` and pnpm 11's
  PnP runtime, where looking up the project's SDK would break the build.
- **`recover` cannot see another environment's process.** A process in WSL, a
  container or another host that shares the checkout cannot be seen, and its
  lock looks abandoned. Run `sync` and `recover` from one environment at a
  time.
- **An empty lock is not cleared.** A process killed while creating a lock
  leaves an empty one, which a live process paused at that moment also has.
  `recover` refuses it; delete the file only after confirming no `sync` or
  `recover` is running.
- **pnpm's Plug'n'Play mode is best effort.** `pnpm exec hooknostic` built a
  working artifact with pnpm 12.21.0 in one recorded check
  (`.capture/pnpm-pnp`), but no test suite runs it. `symlink: false` builds
  nothing. With an SDK of 0.13.0 or earlier, `pnpm exec` hides HN110 and
  reports the SDK as `not-found`; run `build` and `doctor` with plain `node`.
  Under pnpm 11's PnP runtime, HN110 is silent and `doctor` reports the SDK as
  `not-looked-up`.
- **File-mode detection covers Windows and Linux DrvFs without metadata.**
  Another filesystem that ignores `chmod` is still compared by mode.
- **macOS has no playback lane in CI.** Its evidence is shell interpreter
  captures from GitHub macOS runners and live probes
  (`.capture/shell-dialects`, `.capture/opencode-v2`).
- **`--version` prints this CLI's release.** It does not check the registry
  for a newer one.

Start with the [README](../README.md).
