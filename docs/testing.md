# Testing harness integrations without model spend

The default test suite proves adapter semantics from captured native fixtures.
The `harness-playback` CI job adds two integration layers using the real,
installed harness binaries and no model credentials.

## Confidence layers

1. **Generated-artifact fixture replay** feeds every captured native input for
   a harness through the exact bundled artifact that a consumer installs. This
   covers every event the adapter advertises, including lifecycle events that
   are difficult or expensive to induce in a short headless session.
2. **Real-harness playback** installs the harness version named by the
   adapter's `harness.referenceVersion` (or `HOOKNOSTIC_PLAYBACK_VERSION` — see
   below), points its model transport at a loopback-only scripted server, loads
   the generated artifact through the harness's real discovery mechanism, and
   drives a per-scenario script of tool calls and completions. The suite proves
   rewrite and block effects through marker-file outcomes, asserts the naturally
   induced session, prompt, tool, and turn lifecycle events, proves hook
   context injections reach the model side (recorded in the scripted server's
   requests), forces a second model turn through a once-only stop prevention,
   drives Claude's `tool.error` path with a nonzero shell exit, and covers
   Claude's interactive permission prompt in a real pseudo-terminal (see the
   pty lane below). `session.end` is asserted for the command-hook harnesses;
   OpenCode's approximate session end maps to session deletion, which
   `opencode run` does not perform. Playback hooks carry the product's own
   budgets, so each command-hook harness's deadline is its handlers plus
   `runtime.processAllowanceMs` (ADR-0039) — except `session.end`, which
   declares 2s so Codex's 3s cap still fits. A run therefore exercises the
   timeouts a consumer's artifact carries rather than a lane-only value. On
   Codex each generated hook process also loads a test-only Node preload that
   records its exit code, wall time, stdout and stderr without altering any of
   them, and a failed drive prints those records beside the events Codex said
   failed (`.capture/codex-hook-failure`).
3. **Opt-in live smoke tests** remain available through
   `HOOKNOSTIC_SMOKE=<harness> pnpm test`. They use a real model and are for
   deliberate recapture or behavioral validation only, never normal CI.

The first layer is exhaustive over recorded hook payloads. The second proves
that the pinned harness still discovers the generated artifact, honors rewrite
and block results end to end, and delivers the common lifecycle around those
calls. Neither layer upgrades constructed or doc-derived
fixture provenance: a new claim about a harness still starts with the capture
procedure in `.agents/skills/harness-capture/SKILL.md`.

## Scenario coverage (ADR-0010)

The capability profiles and automated verification are tied together by the
scenario registry in `packages/testkit/src/scenarios.ts`: every cell an adapter
resolves — including explicit `unsupported` entries — must map to at least one
scenario, enforced by `describeScenarioCoverage` in the adapter contract suite.
Scenarios declare the driver that produces the harness session (loopback,
pty-approval, mcp-stdio, compaction, subagent, opencode-serve); adding a
capability cell without a scenario fails CI.

Some capability families cannot be decided by the scheduled free lanes today,
and their tests record exactly why:

- **Codex subagent lifecycle** — `SubagentStart`/`SubagentStop` fire in the
  spawned *child* session, which does not inherit the parent's
  `--dangerously-bypass-hook-trust` (session-scoped override lost in the
  child's config rebuild; observed live on 0.151.0 and matches upstream
  openai/codex#33097). Decisive validation requires a separately prepared
  live session with persisted hook trust.
- **Compaction** — the free lane cannot fill the context deterministically
  (shell results are capped ~30k chars, turn count is capped at 6 against a
  200k-token context). Decisive validation requires a separately captured
  live run.
- **Codex interactive permission and approval** — the capability profile has
  captured evidence, but this suite has no captured Codex interactive driver.
  The Claude pty driver is never treated as evidence for Codex; these cells
  remain explicitly inconclusive in scheduled playback until that driver is
  added.

Codex's `tool.after.output.replace` is rated `unsupported` (captured live on
0.151.0: the hook engine strictly rejects `updatedMCPToolOutput` from a
PostToolUse hook — it fails open with "PostToolUse hook returned unsupported
updatedMCPToolOutput"). The mcp-stdio drive therefore runs as an inverted
watch on the scheduled lane: the MCP tool call must dispatch end to end (the
scripted namespace-pair emission resolves the router's exact
`{namespace, name}` lookup), the model must see the fixture's *original*
output, and the replaced marker must surface nowhere. If upstream starts
honouring the field, the watch fails and the rating is revisited.

The Claude, Codex, OpenCode v1, Pi and Copilot playback lanes also configure and
call the in-repository stdio MCP fixture server. The dedicated MCP drive requires
its tool to reach both `tool.before` and `tool.after` as normalized `mcp`
events. Claude loads the fixture through `--mcp-config`, Codex through
`mcp_servers`, OpenCode through its local `mcp` configuration, Pi through
a trusted project `.pi/mcp.json`, reaching it from a codemode script, and Copilot
through `--additional-mcp-config`; the
output-replacement drive remains separate because it is a capability-specific
assertion. On Pi the MCP drive also requires `tool.mcp` on `tool.after` only,
taken from the tool's source, and a Pi-only drive replaces the fixture tool's
output inside a codemode script and requires the replacement, not the
original, in the next model request. Pi's lane also checks project `sync`,
local-path and npm-coordinate package installation, native skill discovery,
hook execution, per-request context as a model-visible user message, and
projected MCP servers. The npm-coordinate test uses `pnpm pack` and a local
read-only registry. Windows playback additionally exercises the installed Pi binary.

Copilot's lane loads the package delivery through `--plugin-dir` and points
`COPILOT_PROVIDER_*` at the loopback chat-completions server, so no GitHub login
or provider key is involved. The runtime tool name pins the dialect: `bash` on
Linux and `powershell` on Windows. `permissionRequest` fires in `-p` sessions, so
its observe/deny path is driven without a pty. The interactive
`permissionDecision: "ask"` prompt and both user choices are captured by
`.capture/copilot/interactive-approval-probe.mjs`; the scheduled suite still has
no Copilot pty-approval driver, so that scenario remains inconclusive on the
automated lane. Copilot's MCP fixture call is classified as `mcp` from the
server-tool separator, while `tool.mcp` stays absent because the payload never
states the split.

The loopback suite never switches to a paid model. Every declared driver
limitation is written to the harness-watch workflow summary as an
**inconclusive** outcome, including the affected capability cells. A decisive
check requires the relevant captured live procedure; an environment flag must
not turn a constructed loopback session into a claimed real-model validation.

## Verifying a newer harness build

harness-watch installs a build newer than `referenceVersion` and names it in
`HOOKNOSTIC_PLAYBACK_VERSION`; the version-pin test then accepts that build.
Unset, the assertion stays CI's exact reference pin. The playback artifact keeps
baking `referenceVersion` into its capability resolution deliberately — the
load-bearing question is whether the artifact consumers already have keeps
working on the new binary:

```bash
HOOKNOSTIC_PLAYBACK=claude HOOKNOSTIC_PLAYBACK_VERSION=2.1.250 \
  pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

### The pty lane

Claude's `permission.request.*` cells are interactive-only: headless `-p`
sessions decide without prompting (that limit is why the PermissionRequest
fixture carries doc-derived provenance). The pty-approval scenario starts the
interactive TUI under `node-pty`, walks the first-run dialogs by polling for
their screen markers, sends a prompt whose scripted tool call trips the native
approval prompt, and lets the generated hook deny it — asserted from the hook
trace (the request fired) and the filesystem (denied command never executed).
The drive forces the prompting permission mode: newer builds start interactive
sessions in auto mode, where no prompt fires. It also drops the `CLAUDECODE`
and `CLAUDE_*` variables it would inherit (all but `CLAUDE_CODE_GIT_BASH_PATH`),
so a run from inside a Claude session starts a fresh top-level session as CI
does (`.capture/claude-permission-mode`).
Scenario-to-lane mapping lives in the registry's `driverByHarness` overrides,
and `docs/harness-watch.md` documents which lane runs on which schedule.

## Version pinning

CI does not copy harness patch versions into workflow YAML.
`scripts/harness-playback-version.mjs` reads each adapter's
`harness.referenceVersion`, and the matrix installs that exact npm package
version:

| Harness | npm package |
| --- | --- |
| Claude Code | `@anthropic-ai/claude-code` |
| Codex CLI | `@openai/codex` |
| GitHub Copilot CLI (`copilot`) | `@github/copilot` |
| OpenCode v1 (`opencode-v1`) | `opencode-ai` |
| OpenCode v2 (`opencode-v2`) | `@opencode/cli` |
| Pi (`pi`) | `@earendil-works/pi-coding-agent` |

The playback test also calls the adapter's normal detector and fails unless the
installed binary reports the expected version — `referenceVersion`, or the build
named in `HOOKNOSTIC_PLAYBACK_VERSION` when harness-watch verifies a newer one.

The model-side request inspection and scripted response envelopes are test
infrastructure, not harness fixtures. Their constructed provenance, the exact
claims a passing run establishes, and the procedure for promoting a successful
run to validation evidence are recorded in
`.capture/harness-playback/README.md`.

## Local execution

Install the exact reference build of one harness, bundle the compiler and its dependencies, and
run:

```bash
pnpm run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, `copilot`, `opencode-v1`, `opencode-v2`, or `pi`. The historical
`opencode` lane selector remains a v1 alias. V2 uses
`packages/cli/test/opencode-v2-playback.test.ts`; see
[OpenCode families](opencode-families.md) for its independently verified
capabilities and limits. The test removes common model credential
variables from the spawned process and supplies only a dummy credential where
the harness requires a non-empty value. Model requests are served on
`127.0.0.1` and never forwarded.

OpenCode v2's `glob` and `grep` run ripgrep, which the harness would otherwise
download from GitHub into each run's fresh cache. The `tools` drive instead
places a pinned ripgrep, checked against its SHA-256, in the harness's cache,
where it looks after `PATH` and before downloading. It fails the run if the
harness log shows a download (#264). That copy
is itself fetched from GitHub once per machine into a per-user cache, and CI
caches it. In CI the fetch happens in the prepare step, before the lane loses
its network (see below), and the test's own `ensureRipgrep()` then finds the
verified copy. A cached copy is used only if it matches the pinned executable's
SHA-256. Set `HKN_RIPGREP_DIR` to a directory that holds, or should receive,
that build. See `.capture/opencode-v2/README.md`, "ripgrep pre-seed".

## Network isolation on Linux

The six Linux playback lanes run in CI with no IP network but loopback.

What this establishes:
- A lane that **needs** the IP network fails.
- Nothing a lane runs can reach an IP network directly. A daemon on the host
  that a unix socket still reaches could reach it on the lane's behalf (see
  "IP only").

It does not detect new egress. A call that a lane does not depend on fails
silently and the lane still passes. Codex's plugin sync is an example: it
only adds about a minute of resolver retries. New egress is found by a traced
inventory (`.capture/network-egress`, the procedure and the record this rests
on), not by CI.

- **The namespace.** `scripts/without-network.sh <command>` does the
  following:
  - re-runs itself as root through `sudo -n /bin/bash`;
  - enters a new network namespace with `unshare --net`. This is root, so no
    unprivileged user namespace and no AppArmor userns restriction is
    involved;
  - brings `lo` up;
  - drops back to the calling user with no supplementary groups, no
    capabilities and `no_new_privs`;
  - sets `HOOKNOSTIC_PLAYBACK_NETWORK=none` inside.
- **IP only.** A network namespace does not cut unix sockets, which are
  reached through the filesystem. That is why the user keeps no supplementary
  groups: on GitHub's images `runner` is in `docker`, whose socket would let
  a process ask dockerd, in the host namespace, to reach the network. A
  daemon reachable without a group (D-Bus, for one) is still reachable. No
  harness was seen to do this.
- **The root hops trust nothing from the caller.**
  - The sudo entry runs `/bin/bash` under sudo's `env_reset`. With the default
    policy (no `PATH`, `BASH_ENV` or `LD_*` in `env_keep`), that leaves no
    caller `PATH`, `BASH_ENV` or `LD_*`. It runs no external command before
    pinning `PATH` to the system directories.
  - Every later hop starts from `env -i PATH=<system>`, and `ip`, `setpriv`
    and `unshare` are found only there.
  - `--as` must name the user that invoked sudo (`SUDO_UID`/`SUDO_GID`).
  - These refusals, and the ones on the env file below, run before the root
    check. That way `scripts/without-network.test.mjs` exercises them as a
    normal user in the Ubuntu test job.
  - The caller's environment crosses sudo in a file, because the hosted
    runners' sudo ignores `--preserve-env` ("preserving the entire
    environment is not supported"). On the first CI run that ignored option
    silently emptied the environment: every playback test skipped and the
    step passed. The file is created 0600 by `mktemp`. Root only checks that
    it is a regular file of the caller's with that mode, and never reads or
    removes it. It is loaded and removed after the drop, as the user. The
    script's own variables are named `_hkn_*` and readonly, and the file's
    `_hkn_*` names are skipped, so no caller variable can replace the
    required list or the isolation check.
  - On this path no environment value reaches argv or output.
- **Trust boundary.** The wrapper is a test harness, not a privilege boundary.
  - It needs **unrestricted** passwordless sudo, as `runner` has on
    GitHub-hosted runners, or `sudo -v` beforehand.
  - It runs a file from your checkout as root, so use it only on a runner or
    a single-user machine.
  - Never give it a sudoers rule of its own. A rule can name it
    (`NOPASSWD: /bin/bash /path/to/scripts/without-network.sh *` matches the
    wrapper's own call), but the script is a file in your checkout that you
    can edit. Such a rule is therefore a root shell for anything running as
    you.
- **The proof.** Before the command, `scripts/assert-no-network.mjs --offline`
  fails the step unless:
  - only `lo` exists;
  - each public IPv4 probe (1.1.1.1, 8.8.8.8, 9.9.9.9) and the IPv6 probe
    fails with `ENETUNREACH`;
  - DNS fails;
  - the user is the expected one, with no supplementary groups, no
    capabilities and `no_new_privs`;
  - every name in `HKN_NO_NETWORK_REQUIRE_ENV` is present and non-empty.

  The wrapper reads that list before the sudo hop and passes it on as an
  argument, so a lost environment cannot also lose the list. The check prints
  one line per item and never prints values. Its positive control,
  `--online`, runs in the prepare step outside the namespace: one IPv4 probe
  and the lookup must succeed there, so one filtered address does not fail a
  lane. IPv6 is reported, not required; hosted runners have none.
- **No lane, no pass.** Under `HOOKNOSTIC_PLAYBACK_NETWORK=none`,
  `harness-playback.test.ts` requires `HOOKNOSTIC_PLAYBACK` to name a known
  lane, so a namespaced run that selects nothing fails instead of skipping
  every test. `prepare-offline-playback.mjs` likewise rejects an unknown
  lane. Both use `isKnownLane` (`scripts/harness-lanes.mjs`).
  `scripts/harness-lanes.test.mjs` unit-tests it, and also runs that one guard
  the way a namespaced lane would, with no lane, so the ordinary test job
  fails if the guard is removed.
- **What the lanes fetch beforehand.**
  `node --experimental-strip-types scripts/prepare-offline-playback.mjs <lane>`
  does it, with network:
  - ripgrep for `opencode-v2`;
  - for `opencode-v1`, the npm cache for `@opencode-ai/plugin@<version>`,
    proven by a second, `--offline` install through the test's own helper.
    Inside the namespace that helper installs with `--offline`, so a gap fails
    at once with `ENOTCACHED`. Outside it, it resolves online as before.
- **What the harnesses no longer try.** The `playbackQuiet` settings in
  `packages/cli/test/harness-playback.ts`:
  - Codex `analytics.enabled=false`;
  - OpenCode's model-catalog fetch and v2's update check;
  - Claude's `plugin validate` gets the drives' environment.

  Nothing asserts on these; inside the namespace the calls would fail
  harmlessly anyway. The traced inventory is what shows each one works.

  Two calls remain and fail harmlessly: Codex's curated plugin sync
  (github.com, chatgpt.com, api.github.com) and Claude's official marketplace
  fetch (downloads.claude.ai).
- **Not isolated.** The Windows lanes, the Code Mode and marketplace jobs, and
  harness-watch's scheduled verification of newer builds still run with
  network.
- **Rollback.** Revert the `ci:` commit that wraps the lanes. Also revert the
  hunks that describe enforcement as current: this section, the "on Linux CI
  no network" clause in AGENTS.md, and the matching bullet in the
  harness-integration skill. The switches, the npm `--offline` mode and the
  scripts stay harmless with network.

To reproduce a lane on Linux, install its harness and bundle as above. Then
run CI's two commands. On a Linux CI runner the prepare step adds
`--check-online`:

```bash
node --experimental-strip-types scripts/prepare-offline-playback.mjs codex --check-online
HOOKNOSTIC_PLAYBACK=codex HKN_NO_NETWORK_REQUIRE_ENV=HOOKNOSTIC_PLAYBACK scripts/without-network.sh \
  pnpm exec vitest run packages/cli/test/harness-playback.test.ts packages/cli/test/opencode-v2-playback.test.ts scripts/pi-drift-driver.test.mjs
```

That needs unrestricted passwordless sudo (see the trust boundary above).
Where sudo prompts (WSL's default user), run the wrapper from a root shell and
name the user. That root shell's environment, with the playback variables,
becomes the user's, and `PATH` and `HOME` come from the arguments:

```bash
scripts/without-network.sh --as "$(id -u user):$(id -g user)" --path "$PATH" --home /home/user -- <command>
```

## Marketplace release gates

After `pnpm run bundle`, print the package baseline from existing capture metadata:

```sh
node scripts/verify-marketplaces.mjs codex --print-version
node scripts/verify-marketplaces.mjs claude --print-version
```

Install those exact harness versions, then run `node scripts/verify-marketplaces.mjs codex`
and the corresponding `claude` command. For a deliberate check against another installed
version, set `HOOKNOSTIC_PLAYBACK_VERSION` to that exact version; record it with the result.
The gate fails when the binary is missing, the version differs, or the package route is
unsupported. It must actually install the documented example into an isolated marketplace,
find the skill, receive an MCP greeting, and observe the hook denial from an unrelated
project directory. Codex also checks the existing installed-plugin block/rewrite scenarios.
The older project playback baseline stays unchanged.

These gates use loopback model playback and isolated configuration. They are local commands;
no Actions workflow or paid smoke session is launched. Normal `pnpm test` also relocates
all example outputs and calls the bundled MCP server without source dependencies.

## Codex Code Mode gate

Current Codex models run shell commands through Code Mode, where one `exec` tool
calls `tools.exec_command` from JavaScript. That dispatch is captured on a build
newer than `referenceVersion`, so the ordinary Codex playback lane skips its two
Code Mode drives. After `pnpm run bundle`, print the captured build from the
profile:

```sh
node scripts/verify-code-mode.mjs --print-version
```

Install that exact Codex version, then run `node scripts/verify-code-mode.mjs`.
It checks the installed version and drives a shell guard's deny and rewrite
through a nested `exec_command`. Below the baseline the drives fail instead of
skipping. The gate also fails unless the version check and both drives ran and
passed, by exact title, so a renamed drive cannot shrink it to nothing. CI runs
the same gate as its `code-mode` job on Windows, the platform the capture
covers, with the pinned playback Node version
([evidence](../.capture/codex-code-mode/README.md)).

## Actual npm package installation

After `pnpm run bundle`, set `HOOKNOSTIC_PACK=1` and run
`pnpm exec vitest run packages/cli/test/packed-consumer.test.ts`.
This packs all three packages with `pnpm pack`, installs those exact tarballs with npm
in a temporary consumer, checks shipped documentation and rewritten dependencies,
and exercises init/check/sync/verify plus a hookless package build. It may download
registry dependencies; it never publishes. The normal suite retains its offline
simulated-install coverage.

## Yarn Plug'n'Play consumers

After `pnpm run bundle`, set `HOOKNOSTIC_YARN_PNP=1` and run the suite. In a
POSIX shell:

```sh
HOOKNOSTIC_YARN_PNP=1 pnpm exec vitest run packages/cli/test/yarn-pnp-consumer.test.ts
```

In PowerShell:

```powershell
$env:HOOKNOSTIC_YARN_PNP='1'; pnpm exec vitest run packages/cli/test/yarn-pnp-consumer.test.ts; Remove-Item Env:HOOKNOSTIC_YARN_PNP
```

The PowerShell variable would otherwise stay set for the session, and a later
`pnpm test` there would run this suite too.

It needs corepack and network access, and Yarn is not in CI, so run it
locally for any change to how builds resolve or read packages, or to how
`sync` writes project files; release preparation runs it under the same
condition ([releases](releases.md#prepare-one-release-pr)). It packs the
SDK and CLI, installs six Yarn 4.18.1 `nodeLinker: pnp` consumers (no Zod,
Zod 3.24.4, 3.25.76 and 4.6.7, Zod 4.6.7 with the SDK repacked as 0.11.9,
and Zod 4.6.7 with an MCP component), and builds each through `yarn hooknostic`,
`node -r ./.pnp.cjs` from the project directory and plain `node`, both against
a CLI installed outside the project, and `yarn dlx`. The first five build
`examples/basic`. It compares the whole table of outcomes, counting HN504 and
HN301 and recording each HN109's and HN110's wording (Yarn's install or a
path) in each:
through Yarn's runtime the build uses the project's in-range Zod or the CLI's
own (with HN109 when the project's is out of range, which names the project's
Zod by Yarn's install, and the CLI's own too under `yarn hooknostic`, #256),
and the repacked SDK warns one HN110, which names Yarn's Plug'n'Play install rather than a path
(#225); plain `node` fails with one HN504
(#183), with no HN110; `yarn dlx` fails with HN504 unless the project's Zod is
in range, and never warns HN110. The `yarn dlx` row also guards #216, where
HN110's lookup of the project's SDK loaded the project's runtime beside dlx's
and failed every `yarn dlx` build. That row passes on Windows (Node 22 and 24)
and on Linux with Node 24; on Linux with Node 22 it is known to fail, every
cell with HN501 "controlled by multiple pnpapi instances".

The rows record the supported surface under Plug'n'Play
([ADR-0041](decisions/0041-yarn-pnp-runtime.md)): `yarn hooknostic` and
`node -r` are supported. The plain `node` row stands for `npx`, a globally
installed `hooknostic` run directly and `pnpm dlx`, which the suite does not
run. The `yarn dlx` row records best-effort behaviour, not a supported mode.

The MCP consumer builds `examples/local-project`'s stdio server for one Claude
project target, so its build bundles the MCP launcher, whose `cross-spawn` and
each of its dependencies sit in archives of their own in Yarn's global cache.
After each build the test starts the launcher, with the project as its working
directory, and records whether it answers an MCP `initialize` through the
server. Its cells match the Zod 4.6.7 consumer's, with no HN301, and the
launcher answers wherever the build succeeds; under plain `node` there is no
launcher, and since every cell starts from an empty `dist/`, none can answer
with a previous mode's. Before #224 its `yarn hooknostic` and `yarn dlx` cells
failed with one HN301 each: esbuild could not resolve `which`, `path-key` and
`shebang-command` from `cross-spawn`'s archive.
The Zod 4.6.7 consumer also synchronizes a repository-local integration: in a
`sync/` subdirectory, through `yarn hooknostic`, it runs `init --local`, which
writes a config and hooks of its own there (the build cells keep building
`examples/basic`'s), then `sync` twice and `verify`. Every step must exit 0,
the integration's state must be under `sync/.hooknostic/`, and no `sync.lock`
may remain there: Yarn's patched `FileHandle` has a `sync()` that throws
"Method not implemented.", which once failed every `sync` and left its lock
behind (#229).
Yarn, corepack and npm keep their state in the test's temporary directory,
where every install and `yarn dlx` run shares one Yarn global cache, and each
consumer gets an empty `yarn.lock` so Yarn never adopts an ancestor project.
Each cell records the real exit code (Hooknostic exits 2 for a failed build).
A Yarn, corepack or npm step that exits otherwise with a network error in its
output (`ECONNRESET`, `ETIMEDOUT`, a closed socket, an SSL or certificate
error and the like; not Yarn's own codes, since `YN0013` is the fetch step of
every install and `YN0001` any exception) stops the test at once with an
`ENVIRONMENT/NETWORK FAILURE` error and that step's output: rerun it, it is
not a missing HN504. Set `HOOKNOSTIC_YARN_PNP_VERBOSE=1` to print every
build's output and the Zod it bundled, each `sync` step's output, and each MCP
launcher's output; a launcher that does not answer, or a `sync` step that
fails, prints its output regardless. This output and the table of observed
outcomes go straight to stderr (#263): they show on a passing run, `--silent`
does not hide them, a `junit` report does not record them, and capturing them
in a file needs `2>&1`.

The normal suite covers HN504 without Yarn, through a synthetic layout: a
hand-written `.pnp.data.json` and stored zip archives that esbuild resolves
and reads as it does Yarn's (`writeSyntheticPnpProject` in
`@hooknostic/testkit`).
