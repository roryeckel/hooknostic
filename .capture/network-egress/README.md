# Network egress of the offline playback lanes

**Question.** The playback lanes are called offline because their model calls go
to a loopback server. Nothing enforces or records any other traffic. What else
does each harness, and each lane's test setup, contact while the lane runs:
update checks, model catalogs, plugin catalogs, telemetry, package installs?
Which of those does a lane need to pass, and which setting turns each one off?
The answers inform whether CI should block egress for these lanes.

This is a measurement only. No product code, test, or CI change was made.

## Environment

- Date: 2026-11-20, 03:46 to about 05:30 UTC (run times are in each summary's
  `meta`).
- OS: WSL 2, Ubuntu 24.04.4 LTS, kernel `5.15.167.4-microsoft-standard-WSL2`,
  x86_64, ext4 home directory. Network: WSL NAT, with the DNS resolver at
  `10.255.255.254` (WSL DNS tunnelling, bound to `lo` of the root namespace).
- Node 24.22.3 (`.github/node/playback/.node-version`), npm 11.19.1, pnpm 12.21.0,
  strace 6.8, Python 3 for parsing.
- Repository: `capture/network-egress` at `51d4fa22`, cloned to ext4,
  `pnpm install --frozen-lockfile` and `pnpm run bundle` run there.
- Each lane's harness was installed into its own npm prefix with
  `npm install --global <pkg>@<version>` (CI's command), followed by the
  package's known bootstrap script as harness-watch runs it (`install-lane.sh`).
  npm 11 reported that it skipped install scripts; every binary then reported
  the expected version. Installation was not measured.

| Lane | Package | CI reference version | Latest (dist-tags.latest, 2026-11-20) |
| --- | --- | --- | --- |
| claude | `@anthropic-ai/claude-code` | 2.1.238 | 2.1.329 |
| codex | `@openai/codex` | 0.148.0 | 0.171.0 |
| copilot | `@github/copilot` | 1.0.101 | 1.0.114 |
| opencode-v1 | `opencode-ai` | 1.18.18 | 1.19.6 |
| opencode-v2 | `@opencode/cli` | 2.0.17 | 2.3.2 |
| pi | `@earendil-works/pi-coding-agent` | 1.3.0 | 1.5.2 |

## Method

Each lane ran CI's exact playback command,

```
pnpm exec vitest run packages/cli/test/harness-playback.test.ts \
  packages/cli/test/opencode-v2-playback.test.ts scripts/pi-drift-driver.test.mjs
```

with CI's step environment: `HOOKNOSTIC_PLAYBACK=<lane>`,
`HKN_PLAYBACK_ARTIFACT_DIR`, `HKN_RIPGREP_DIR`, the four credential variables
set to empty, plus `CI=true` and `GITHUB_ACTIONS=true` as on a hosted runner.
Every run started with a fresh, empty `HOME` and `TMPDIR`, as on a fresh
runner, and a `PATH` without Windows entries. `HKN_RIPGREP_DIR` was filled
beforehand with the pinned ripgrep, so every run saw CI's cache-hit case for
the OpenCode v2 `tools` drive (#264). The latest-version runs also set
`HOOKNOSTIC_PLAYBACK_VERSION`, as harness-watch does. The scripts are in this
directory: `lane-inner.sh` runs a lane, `run-lane.sh` selects the mode.

Each lane ran in two modes:

1. **traced**, with the network available. The whole process tree, from pnpm
   down, ran under

   ```
   strace -f --seccomp-bpf -qq -ttt -s 512 -e signal=none \
     -e trace=connect,sendto,sendmsg,sendmmsg,recvfrom,recvmsg,execve,clone,clone3,fork,vfork
   ```

   `parse_strace.py` reduces the trace to:
   - every `connect` to a non-loopback IPv4 or IPv6 address;
   - every DNS query and answer, decoded from the UDP payloads on sockets
     connected or sending to port 53;
   - the TLS SNI from each ClientHello on those sockets, when the harness sent
     it with `sendto`;
   - attribution of each item to a process: threads map to their thread
     group, and each process maps to its last `execve` image and argv.

   Hostnames are what the process itself resolved (DNS answers) or named (SNI),
   not reverse lookups. A UDP `connect` to port 0 (glibc) or 65535 (musl) that
   returns at once is `getaddrinfo` choosing a source address. It sends nothing
   and is excluded from the tables.
2. **nonet**, with no network. As root,
   `unshare --net -- sh -c 'ip link set lo up; exec setpriv --reuid=<user> …'`
   ran the same lane as the same unprivileged user, in a namespace that has only
   loopback. The resolver address is then unreachable. Test results are compared
   with the traced run test by test (`compare.sh` in scratch; the counts are in
   each summary).

Two further kinds of run probe the knobs:

- **Variant lane runs**, which add environment variables from a file
  (`lane-inner.sh`'s sixth argument):
  - `opencode-v1` nonet, with the npm cache from its traced run copied into
    `HOME` and `npm_config_offline=true`, plain and traced;
  - `codex` nonet under strace, to see what it tries;
  - `opencode-v1` and `opencode-v2` traced, with the OpenCode knobs below.
- **Standalone probes**, for knobs a lane's drive cannot pass through. They run
  one harness command per variant under the same strace, in a fresh `HOME`:
  - `probe-claude-codex.sh`: `claude plugin validate`, and `codex exec`
    against `probe-server.py`, a loopback server that completes one turn;
  - `probe-opencode.sh`: `opencode run` against the same server;
  - `probe-opencode-tui.sh`: the v2 TUI under `script(1)`, stopped after 12 s.

Raw traces, vitest JSON and harness logs stay in the capturing machine's
scratch directory. They are 1 to 40 MB per run.

### Files

| File | What it is |
| --- | --- |
| `env.sh`, `install-lane.sh` | Isolated toolchain and the per-lane harness install |
| `run-lane.sh`, `lane-inner.sh` | Run a lane traced or in a network namespace (modes `traced`, `nonet`, `nonet-traced`) |
| `parse_strace.py` | Reduce a trace to destinations and DNS queries |
| `export.py` | Write `summaries/<lane>-<version>-<mode>[-variant].json` and `summaries/probes.json` |
| `probe-claude-codex.sh`, `probe-opencode.sh`, `probe-opencode-tui.sh`, `probe-server.py` | The standalone knob probes |
| `summaries/` | One JSON per run: test counts, failures, destinations with process, argv and timing, and DNS queries with answers |

The committed scripts are the ones that ran, with this machine's paths made
into parameters (`HNE`, `NODE_BIN`, `HN_UID`, `HN_GID`, `HN_USER`, `HN_HOME`).
In the summaries, the capturing account's home is redacted to `/home/user`.
Non-loopback interfaces keep only their name and state.

Provenance labels used below:

- **captured**: observed in these traces or probes.
- **inference**: the purpose, read from the harness binary's own URL strings or
  from timing. It is a reading, not an observation of the request path, because
  TLS hides the path.
- **doc-derived**: from the vendor's documentation, cited.

## Results at the CI reference versions

| Lane | traced | nonet | Non-loopback destinations (traced) |
| --- | --- | --- | --- |
| claude 2.1.238 | 68 passed, 74 skipped | same | api.anthropic.com, downloads.claude.ai |
| codex 0.148.0 | 67 passed, 75 skipped | same; each codex drive about 3.5 s slower | chatgpt.com, ab.chatgpt.com, github.com (git) |
| copilot 1.0.101 | 66 passed, 76 skipped | same | **none** |
| pi 1.3.0 | 70 passed, 72 skipped | same | **none** |
| opencode-v1 1.18.18 | 61 passed, 81 skipped | **13 failed**, 47 passed, 82 skipped | registry.npmjs.org (test setup), models.opencode.ai |
| opencode-v2 2.0.17 | 91 passed, 51 skipped | same | models.opencode.ai, opencode.ai |

No process outside the harnesses and the npm commands named below reached the
network: not pnpm, vitest, node, or the hook processes. GitHub (ripgrep) does
not appear because the seed was warm (see "Not measured").

### Per-destination inventory

"Needed" comes from the nonet run. "Knob" is what removed the destination in a
probe. Addresses are as resolved on this network; Cloudflare and Google front
ends rotate.

#### claude 2.1.238

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| api.anthropic.com:443 (160.79.104.10; IPv6 2607:6bc0::10 was attempted and unreachable) | `claude plugin validate --strict <dir>`, 1 of 82 harness processes. Test: "discovers a projected skill, starts all MCP transports with native variables, and runs combined hooks" (`harness-playback.test.ts:2383`), which runs it with `env: process.env`: no `ANTHROPIC_BASE_URL` and none of the drive's `DISABLE_*` variables. | A request built on the API base URL (**captured**: it disappears with `ANTHROPIC_BASE_URL` on loopback). Which endpoint is not known. The binary names `/api/claude_code/settings`, `/api/claude_code/policy_limits` and `/api/eval/` among others (**inference**). `claude --version` makes no request. | **No** | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (**captured**, standalone probe). Not removed by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER` or `DISABLE_INSTALLATION_CHECKS`, alone or together (**captured**). |
| downloads.claude.ai:443 (35.190.46.17, SNI downloads.claude.ai) | The interactive TUI in both pty drives (`--permission-mode manual`), 2 processes. These drives already set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` and `DISABLE_TELEMETRY=1`. | The official plugin marketplace: the binary's only URLs on this host are `…/claude-code-releases/plugins/claude-plugins-official` and the release bucket (**inference**). | **No** | None found. The drives' existing knobs do not stop it (**captured**). |

A third connection, to `172.17.0.1:33349`, came from the same pty TUI. That
address is the WSL host, and on it VS Code (`Code.exe`) was listening on
127.0.0.1:33349. This is Claude Code's IDE auto-connect reaching across from WSL
to the Windows host (**inference**). It is an artifact of measuring on WSL and
cannot happen on a CI runner, so it is excluded.

#### codex 0.148.0

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| github.com:443 (140.82.112.4, 140.82.114.4) | `git-remote-https https://github.com/openai/plugins.git`, started by each `codex exec` (32 git transports from 16 of 22 codex processes, in every drive) | Curated plugin catalog sync by `git ls-remote` and fetch. The URL is in the argv (**captured**). | **No** | `-c features.plugins=false` (**captured**, standalone). This key is not in the current Codex config reference. |
| chatgpt.com:443 (104.18.32.47, 172.64.155.209) | `codex exec`, 16 of 22 processes, 0.26 to 0.7 s after start | The curated plugin export, `https://chatgpt.com/backend-api/plugins/export/curated` (**inference** from strings, and **captured** that only the plugins knob removes it) | **No** | `-c features.plugins=false` (**captured**) |
| ab.chatgpt.com:443 (same addresses, SNI ab.chatgpt.com) | `codex exec`, 16 processes, 1 to 3.4 s after start (end of turn) | Built-in metrics. The binary's URL is `https://ab.chatgpt.com/otlp/v1/metrics` (**inference**). The docs say `analytics.enabled = false` "disables the built-in Statsig metrics exporter" (**doc-derived**, [config reference](https://developers.openai.com/codex/config-reference)). | **No** | `-c analytics.enabled=false` (**captured**, standalone, and **doc-derived**) |
| api.github.com (DNS only) | `codex exec`, nonet only | A fallback in the curated sync when git fails: the strings `https://api.github.com` and `application/vnd.github+json` sit beside the plugin-sync strings (**inference**). Not queried when the network was up. | **No** | `-c features.plugins=false` (**inference**) |

With both `-c` settings, a `codex exec` turn made no non-loopback connection
and sent no DNS query (**captured**). Without network, the lane passes. Each
codex drive took about 3.5 s longer (5.4 to 6.1 s against 1.5 to 2.9 s traced).
The nonet trace shows Codex's musl resolver resending each query after its
retry interval, because sending to the unreachable resolver fails at once. The
delay depends on how the resolver fails, so a runner may differ (**inference**).
Whether `features.plugins=false` affects the lane's own plugin and marketplace
drives was not tested, because that would change test behaviour.

#### copilot 1.0.101

None. Twenty harness processes made no non-loopback connection and sent no DNS
query (**captured**). The drive already passes `--disable-client-telemetry` and
`--no-auto-update`, and points `COPILOT_PROVIDER_*` at loopback.

#### pi 1.3.0

None. No process in the run made a non-loopback connection or sent a DNS query
(**captured**). The npm-coordinate test installs from the lane's local loopback
registry, as designed. The summaries report `harness_processes: 0` for Pi,
because that counter matches the executable path and Pi runs as
`node <prefix>/bin/pi`. The trace has 160 such starts in each Pi run.

#### opencode-v1 1.18.18

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| registry.npmjs.org:443 (104.16.0.34 and others) | **Test setup, not the harness**: `npm install --prefix <project>/.opencode --ignore-scripts --no-fund --no-audit --save-exact @opencode-ai/plugin@1.18.18`, from `prepareOpenCodePluginDependency` (`packages/cli/test/harness-playback.ts:719`). Only 2 of the npm processes connected; the rest were served from npm's cache in the run's `HOME` (**inference** from the cache contents). | Fetch the plugin package and its dependencies (**captured**) | **Yes**, see below | `npm_config_offline=true` with a warmed npm cache (**captured**: the lane then passes fully offline) |
| models.opencode.ai:443 (104.18.10.66, 104.18.11.66; IPv6 attempted) | `opencode run …`, 3 of 14 harness processes. The v1 drives share `$HOME/.cache/opencode/models.json` (6.8 MB, found after the run), so later processes reuse the cached catalog. | Model catalog (**inference**). The v2 binary names `https://models.opencode.ai/api.json`. | **No** | `OPENCODE_DISABLE_MODELS_FETCH=1` (**captured**, standalone probe on v1 and v2). The v1 drives pass `OPENCODE_*` variables through. A lane run with it and `OPENCODE_DISABLE_AUTOUPDATE=1` in the outer environment passed (61 passed, 81 skipped), and no harness process reached the network (**captured**). |

Run standalone, without the test's pre-install, `opencode run` itself also
contacts registry.npmjs.org (**captured**, probe). The pre-install exists to
stand in for that internal installer, which its comment says can hang in a
fresh container.

**Failures without network.** Thirteen tests failed. Twelve of them fail with
`Error: npm timed out` after the 60 s `runProcess` timeout in
`prepareOpenCodePluginDependency`, while npm retries the unreachable registry.
The thirteenth, "drives the fixture MCP tool through the generated production
artifact", hit vitest's 30 s timeout during the same install. One further test
was skipped. With the npm cache from the traced run copied into `HOME` and
`npm_config_offline=true`, the lane passed fully offline, both plain and
traced (61 passed, 81 skipped). In the traced offline run, `opencode` still
tried to reach the resolver 116 times, and each attempt failed with
`ENETUNREACH`. No query left the process, so the names are not visible. So the
harness needs none of its destinations; only the test setup needs the registry.

#### opencode-v2 2.0.17

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| models.opencode.ai:443 (104.18.10.66, 104.18.11.66; IPv6 attempted) | `opencode serve --stdio` (the drive's server), in 46 of 122 harness processes, 0.3 to 1.0 s after start | Model catalog. The binary names `https://models.opencode.ai/api.json` and `OPENCODE_MODELS_URL` (**inference**). | **No** | `OPENCODE_DISABLE_MODELS_FETCH=1` (**captured**, standalone). It cannot be set from outside the lane: `.capture/opencode-v2/drive.mjs` deletes every environment variable whose name contains `OPENCODE` before it starts the harness. Lane runs with the knob, alone or with `OPENCODE_DISABLE_AUTOUPDATE=1`, in the outer environment still showed all 46 processes fetching (**captured**). |
| opencode.ai:443 (same addresses, SNI opencode.ai) | `opencode --standalone --auto`, the interactive TUI of the notification drive, 1 process, 0.8 s after start | Update check (**captured**). In the standalone TUI probe, the screen showed `/update to install v2.3.2` in exactly the runs that made this request, and in neither run with the update knob. The endpoint is not known. | **No** | `OPENCODE_DISABLE_AUTOUPDATE=1` (**captured**, standalone TUI probe; `summaries/probes.json`). Same stripping caveat. The docs give the `update` key (`"disable"`) in the *global* config as v2's update policy (**doc-derived**, [config](https://opencode.ai/docs/config/)); not probed. |

With both knobs, the v2 TUI and `opencode run` made no non-loopback connection
(**captured**).

## Results at the latest versions

These ran once per mode, as harness-watch runs them: the newer build installed,
with `HOOKNOSTIC_PLAYBACK_VERSION` set to it.

| Lane | traced | nonet | Destinations, compared with the reference |
| --- | --- | --- | --- |
| claude 2.1.329 | 68 passed | same | Same two: api.anthropic.com from `claude plugin validate` (1 process), and downloads.claude.ai from both pty TUIs. No IDE connection this time. |
| codex 0.171.0 | 69 passed | same; each codex drive about 3.5 s slower | github.com (`git-remote-https https://github.com/openai/plugins.git`, 42 transports from 21 codex processes) and ab.chatgpt.com (21 processes, 0.7 to 3.4 s after start). **chatgpt.com was not contacted.** |
| copilot 1.0.114 | 66 passed | same | None |
| pi 1.5.2 | 70 passed | same | None |
| opencode-v1 1.19.6 | 61 passed | **13 failed**, the same `npm timed out` set | registry.npmjs.org (test setup, 2 npm processes) and models.opencode.ai (2 of 14 harness processes) |
| opencode-v2 2.3.2 | 1 failed, 90 passed | 91 passed | Same two: models.opencode.ai (46 of 122 processes) and opencode.ai (the TUI, 1 process) |

The opencode-v2 2.3.2 failure has nothing to do with the network. The failing
test is "reports each completion of a followed-up subagent as its own
agent.stop": `expected 1 to be 2` at `opencode-v2-playback.test.ts:689`. With
the whole lane rerun, it failed in one more run with network (no strace) and
passed in a second traced run. Repeated alone, through `HN_TEST_FILTER` in
`lane-inner.sh`, it failed in 1 of 5 runs with network and 2 of 5 without.
Every failure was the same assertion. It is intermittent on 2.3.2 in both
modes and is left for harness-watch.

The standalone knob probes ran only against the reference versions.

## What is avoidable and what is required

Required today, outside the harnesses:

- **opencode-v1 test setup**: registry.npmjs.org, for
  `@opencode-ai/plugin@<version>`. This is the only item that fails a lane
  without network.
- **Before the measured step, by design** (not traced here):
  - `pnpm install`, the harness `npm install --global`, and `actions/cache`;
  - the OpenCode v2 drive's own ripgrep fetch from GitHub on a CI cache miss
    (#264). `ensureRipgrep` runs inside the test step on a cold cache.

Avoidable, harness-side; no lane needs any of them:

| Item | How to avoid it |
| --- | --- |
| Claude `plugin validate` to api.anthropic.com | Give that one invocation the drive's environment, at least `ANTHROPIC_BASE_URL` on loopback |
| Claude TUI to downloads.claude.ai (official marketplace) | No knob found; blocking it is harmless |
| Codex curated plugin sync (github.com, chatgpt.com, api.github.com) | `features.plugins=false`, if the plugin drives still pass with it; otherwise let it fail |
| Codex metrics (ab.chatgpt.com) | `analytics.enabled=false` in the drives' Codex config |
| OpenCode model catalog (models.opencode.ai) | `OPENCODE_DISABLE_MODELS_FETCH=1`. For v2 it must be set after `drive.mjs` strips `OPENCODE*` |
| OpenCode v2 TUI update check (opencode.ai) | `OPENCODE_DISABLE_AUTOUPDATE=1`, with the same caveat |

## Consequences for enforcing no egress in CI

These are not implemented here.

- **Linux lanes, using a network namespace.** The namespace used here needs only
  root, which a GitHub-hosted runner has through passwordless `sudo`. It does
  not need an unprivileged user namespace, so AppArmor's
  `kernel.apparmor_restrict_unprivileged_userns` does not apply. Ubuntu 24.04
  images had that restriction switched off in actions/runner-images#11489.
  A third-party report says `ubuntu-latest` has been moving to 26.04, where a
  bubblewrap profile ships enabled. The namespace path does not use bubblewrap
  (**inference**; not run on a runner). The wrapped step is the playback step only:

  ```
  sudo unshare --net -- sh -c 'ip link set lo up; exec setpriv --reuid=… --regid=… --init-groups env … pnpm exec vitest run …'
  ```

  Everything that needs the network must run before it:
  - `pnpm install`, the harness install and `actions/cache`;
  - the ripgrep seed fetch on a cache miss;
  - for opencode-v1, warming the npm cache for `@opencode-ai/plugin` (or
    serving it from a loopback registry as the Pi lane does), with
    `npm_config_offline=true` inside.

  `sudo` resets the environment, so the step must pass `PATH`, the toolcache
  Node and the playback variables explicitly.
- **Without that npm change, opencode-v1 fails** (13 tests). The other five
  Linux lanes passed unchanged in the namespace.
- **Windows lanes** (copilot, pi, opencode-v2, Code Mode) cannot use a network
  namespace and were not measured.

## Not measured

- **Windows and macOS.** The Windows playback lanes (copilot, pi, opencode-v2)
  and the Windows Code Mode lane were not traced; the Linux results say nothing
  about them.
- **A GitHub-hosted runner.** WSL's NAT network and resolver differ from a
  runner's: the runner uses the systemd-resolved stub at 127.0.0.53, which
  inside a new network namespace is a loopback port with nothing listening.
  Nothing here was run on a runner.
- **Request paths and bodies.** Purposes come from the binaries' strings and
  from which knob removes a destination. TLS hides the path, and no MITM proxy
  was used.
- **The ripgrep cold-cache path** (#264). It is test infrastructure, already
  documented in `.capture/opencode-v2/README.md`.
- **Writes that strace does not show.** Node writes TCP data with `write` and
  `writev`, which were not traced, so SNI is missing for Node clients. Every
  connection is still recorded through its `connect` and DNS query.
- **Marketplace, Code Mode, packed-consumer and Yarn PnP jobs.** These are
  separate CI jobs, not playback lanes.
