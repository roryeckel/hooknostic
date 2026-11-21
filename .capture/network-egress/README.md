# Network egress of the offline playback lanes

**Question.** The playback lanes are called offline because their model calls go
to a loopback server. Nothing enforces or records any other traffic. What else
does each harness, and each lane's test setup, contact while the lane runs:
update checks, model catalogs, plugin catalogs, telemetry, package installs?
Which of those does a lane need to pass, and which setting turns each one off?
The answers inform whether CI should block egress for these lanes.

The inventory itself was a measurement only. What was then acted on is in
"Acted on", below.

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
| api.anthropic.com:443 (160.79.104.10; IPv6 2607:6bc0::10 was attempted and unreachable) | `claude plugin validate --strict <dir>`, 1 of 82 harness processes. Test: "discovers a projected skill, starts all MCP transports with native variables, and runs combined hooks". At the inventory's base (`51d4fa22`), that test's `plugin validate` call ran with `env: process.env`: no `ANTHROPIC_BASE_URL` and none of the drive's `DISABLE_*` variables. That is the state measured here. This branch changed it; see "Acted on". | A request built on the API base URL (**captured**: it disappears with `ANTHROPIC_BASE_URL` on loopback). Which endpoint is not known. The binary names `/api/claude_code/settings`, `/api/claude_code/policy_limits` and `/api/eval/` among others (**inference**). `claude --version` makes no request. | **No** | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (**captured**, standalone probe). Not removed by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER` or `DISABLE_INSTALLATION_CHECKS`, alone or together (**captured**). |
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
Every failure was the same assertion, intermittent on 2.3.2 in both modes.
Cause, found later: the drive's follow-up raced the background child.
A follow-up that reached the child mid-execution was folded into that
execution, so there was one completion where the test counts two. Fixed by a
constructed ordering (`aebf9de5`; `.capture/opencode-v2/README.md`,
"subagent-followup").

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

## Acted on (2026-11-20)

The owner's decisions, and the branch `ci/offline-playback` (draft PR
roryeckel/hooknostic#288) that carries them, together with this inventory:

| Item | Decision | Where |
|---|---|---|
| opencode-v1 test setup reaching registry.npmjs.org | Warm npm's cache in a prepare step that has network, and prove it with a second `--offline` install through the test's own helper. Inside the namespace the helper installs with `--offline`, so a gap fails at once with `ENOTCACHED`. Outside, npm resolves online as before. A Pi-style loopback registry was rejected: the plugin resolves to 42 packages, including platform-specific optionals and auto-installed peers. | `scripts/prepare-offline-playback.mjs`, `prepareOpenCodePluginDependency` |
| Codex metrics (ab.chatgpt.com) | `-c analytics.enabled=false` on every `codex exec`, `plugin marketplace add` and `plugin add` in the lane | `playbackQuiet.codexArgs` |
| OpenCode model catalog (models.opencode.ai) | `OPENCODE_DISABLE_MODELS_FETCH=1`, on v1 and v2 | `playbackQuiet.opencodeV1Env` / `opencodeV2Env` |
| OpenCode v2 TUI update check (opencode.ai) | `OPENCODE_DISABLE_AUTOUPDATE=1`, set in `.capture/opencode-v2/drive.mjs` after its `OPENCODE*` strip, and after the effect test's own strip | `playbackQuiet.opencodeV2Env` |
| Claude `plugin validate` (api.anthropic.com) | Give it the drives' environment (`claudePlaybackEnv`) with the API on a refused loopback port | `harness-playback.test.ts` |
| Codex curated plugin sync (github.com, chatgpt.com, api.github.com) | Left alone; fails harmlessly without network | — |
| Claude official marketplace (downloads.claude.ai) | Left alone; no setting found, and it fails harmlessly | — |
| Enforcement | The six Ubuntu `harness-playback` entries run through `scripts/without-network.sh`, which checks the isolation with `scripts/assert-no-network.mjs` before the tests start. The Windows entries are unchanged. | `.github/workflows/ci.yml` |

### After the change, with network (traced, WSL, as above)

Destinations reached, excluding loopback, the resolver and route probes. All
eight runs passed. Summaries are in `summaries/*-traced-after.json`.

| Lane | Reference | Latest |
|---|---|---|
| claude | downloads.claude.ai (pty TUIs; left alone) | same (2.1.329) |
| codex | github.com (git), chatgpt.com (plugin sync; left alone). ab.chatgpt.com gone. | github.com only (0.171.0) |
| opencode-v1 | registry.npmjs.org from the test's `npm install`, which runs online outside the wrapper. models.opencode.ai gone. | same (1.19.6) |
| opencode-v2 | **none** | **none** (2.3.2) |
| copilot, pi | none (unchanged) | — |

### Without network, in the wrapper (WSL, reference versions)

All six lanes passed in the namespace, with the canary green before vitest:

| Lane | Passed | Skipped |
|---|---|---|
| claude | 72 | 74 |
| codex | 71 | 75 |
| copilot | 70 | 76 |
| pi | 74 | 72 |
| opencode-v2 | 95 | 51 |
| opencode-v1 | 65 | 81 |

Why every count is exactly 4 higher than the inventory table (68/67/66/70/91/61):
- the tree, not the test selection;
- master gained four tests in `opencode-v2-playback.test.ts` between the
  inventory's base (`51d4fa22`) and this branch's (`766f2370`);
- those four run outside that file's lane gate, so every lane counts them.

The round-2 runs below add one more, the no-lane guard.

Two wrapped runs were expected to fail, and did:
- opencode-v1 without the prepare step failed 13 tests in 6 s with `ENOTCACHED`
  (26 installs). Before, it timed out.
- The wrapper with `--net` removed failed in the canary, on the interfaces,
  IPv4 and DNS checks.

The sudo path was exercised once in round 1, through a temporary sudoers rule
scoped to the wrapper and removed straight after. **Do not copy that.**
Implementation review round 1 showed that the root hop of that version trusted
the caller's environment. With such a rule, that made the wrapper a root shell
for anything running as that user. The wrapper is now hardened (rounds 2 and
3, below). Even so, it is meant for unrestricted sudo only. A rule naming
`/bin/bash <script>` still matches its call, and the script is a file you can
edit, so such a rule is a root shell (`docs/testing.md`, "Trust boundary").

### Round 2: implementation review fixes

- **Root hop hardened.**
  - Every hop after the sudo entry starts from `env -i PATH=<system>`. The
    sudo entry itself relies on sudo's `env_reset` (round 3 says so, and
    replaced the absolute tool paths with bare names under the pinned
    `PATH`).
  - `--as` must match `SUDO_UID`/`SUDO_GID`.
  - Root checks the env file (regular, 0600, the caller's, named by this
    script) but never reads or removes it. The user loads it after the drop.

  The reviewer's attacks, re-run in WSL against the round-1 wrapper (80166e8d)
  and the new one, as sudo enters root (a sanitized environment plus
  `SUDO_UID`):

  | Attack | Round 1 | Round 2 |
  |---|---|---|
  | caller `PATH` with a fake `ip` | fake `ip` ran as uid 0 | never ran |
  | caller `BASH_ENV` | sourced as uid 0 | never sourced |
  | `--env-file` naming a root-owned 0600 file | root deleted it | refused, file kept |
  | `--env-file` a symlink | accepted | refused |
  | `--as 65534:65534` with `SUDO_UID=1000` | ran as 65534 | refused |

  In the same run the legitimate command ran as 1000, the canary passed, and
  no env file was left.
- **No supplementary groups.** `--clear-groups` replaces `--init-groups`, and
  the canary checks it: with `--init-groups`, WSL showed 12 supplementary
  groups, `docker` among them. All six lanes pass without them:

  | Lane | Passed | Skipped |
  |---|---|---|
  | claude | 73 | 74 |
  | codex | 72 | 75 |
  | copilot | 71 | 76 |
  | pi | 75 | 72 |
  | opencode-v2 | 96 | 51 |
  | opencode-v1 | 66 | 81 |

  Each count is one higher than above: the no-lane guard.
- **Vacuous-green holes closed.**
  - A required variable must be non-empty.
  - `prepare-offline-playback.mjs` rejects an unknown lane (exit 2).
  - Under `HOOKNOSTIC_PLAYBACK_NETWORK=none`, `harness-playback.test.ts`
    fails when no known lane is selected. The previous file passed vacuously
    (36 passed, 41 skipped).
- **Online control.** It accepts any of 1.1.1.1, 8.8.8.8 and 9.9.9.9;
  offline requires all three to be unreachable.
- **Rollback.** Revert the `ci:` commit (5a60b406). Also revert the hunks that
  describe enforcement as current: `docs/testing.md` "Network isolation on
  Linux", the AGENTS.md clause, and the harness-integration skill bullet (from
  6cd49405 and their round-2 updates). Everything else is harmless with
  network.

### Round 3: implementation review round 2

- **Caller variables kept off the wrapper's own.** The last hop loaded the
  caller's environment over its locals.
  - The script's variables are now `_hkn_*` and readonly, and the env file's
    `_hkn_*` names are skipped with a note.
  - `set -e` is off during the load. Under it, bash 5.2 ends the run silently
    on a refused readonly assignment, even with `|| true`. That held for this
    script's names and for bash's own (`EUID`, `SHELLOPTS`, …).

  Re-run in WSL as sudo enters root, against round 2 (9cb5674b) and round 3:

  | Attack | Round 2 | Round 3 |
  |---|---|---|
  | caller `require=` (empties the required list) | "no required names", command ran | `missing or empty: HOOKNOSTIC_PLAYBACK`, nothing ran |
  | caller `here=<dir>` (replaces the check) | the fake check ran, exit 0 | the real check ran |
  | caller `_hkn_require=` / `_hkn_here=` | (names unused) | skipped with a note; real check |
  | caller exports `SHELLOPTS` | the run died silently, exit 1 | the run completes |
  | the five earlier attacks | refused or inert | refused or inert |
- **No external command before `PATH` is pinned.**
  - The sudo entry relies on sudo's `env_reset`.
  - The script finds its own path with builtins.
  - The root hops use bare tool names under the pinned system `PATH` rather
    than merged-/usr paths.
  - The root-entry path removes its own env file on exit if a hop fails. As
    first written, this covered only the hop that creates the file; round 4
    extends it to the namespace hop.
- **The refusals are tested as a normal user.** The `--as` and `--env-file`
  checks now run before the root check. `scripts/without-network.test.mjs`
  (Linux; CI's ubuntu test job) covers each refusal, and shows a valid request
  reaching "--as needs root". In WSL, reverting the `SUDO_UID` binding fails
  one of its tests, and reverting the env-file checks fails another.
- **The no-lane guard is pinned.** `isKnownLane` (`scripts/harness-lanes.mjs`)
  is unit-tested. `scripts/harness-lanes.test.mjs` also runs the guard itself
  the way a namespaced lane would, with no lane. Deleting the guard,
  `isKnownLane` returning `true`, and `isKnownLane` accepting any defined id
  each fail it.
- **Docs.**
  - The claim that a sudoers rule cannot match is gone: one naming
    `/bin/bash <script>` does. The reason never to add one is given instead.
  - "IP network" replaces "network" where unix-socket daemons remain
    reachable.
- All six lanes still pass wrapped, in WSL:

  | Lane | Passed | Skipped |
  |---|---|---|
  | claude | 73 | 74 |
  | codex | 72 | 75 |
  | copilot | 71 | 76 |
  | pi | 75 | 72 |
  | opencode-v2 | 96 | 51 |
  | opencode-v1 | 66 | 81 |

  The counts are the same as round 2's, with `groups: gid 1000 only` and all
  three required names present in every canary.

### Round 4: implementation review round 3

Re-run in WSL against round 3 (`aebf33e0`) and round 4:

| Probe | Round 3 | Round 4 |
|---|---|---|
| root entry, `ip link set lo up` failing | 1 env file left in `/tmp` | none left (the namespace hop's trap) |
| sudo shape, `ip` failing | caller's file untouched | caller's file untouched (root never removes it; the caller's own trap does) |
| env file with `POSIXLY_CORRECT` before `EUID` | the run died silently: no check, nothing ran | completes; the check sees variables loaded after `EUID` |
| `SHELLOPTS` and `EUID` | completes | completes; bash's readonly names are skipped |

The load now skips bash's own readonly names (`BASHOPTS`, `BASH_VERSINFO`,
`EUID`, `PPID`, `SHELLOPTS`, `UID`), and applies `POSIXLY_CORRECT` only after
the loop. The nested guard run in `scripts/harness-lanes.test.mjs` also drops
`HOOKNOSTIC_PLAYBACK_VERSION`, `HOOKNOSTIC_SMOKE` and `HOOKNOSTIC_PACK`.

### CI evidence (draft PR #288)

| Run | Tree | Outcome |
|---|---|---|
| [44691873247](https://github.com/roryeckel/hooknostic/actions/runs/44691873247) | first green | **Vacuous**, caught by reading the logs. The runner's sudo printed `preserving the entire environment is not supported, '--preserve-env' is ignored`. The step lost `HOOKNOSTIC_PLAYBACK`, so every playback test skipped (49 passed, 97 skipped). The same hop lost `HKN_NO_NETWORK_REQUIRE_ENV`, so the canary reported "no required names". The plan review had flagged this assumption. Fixed in `2cce6d15`: the environment now crosses sudo in a 0600 file, and the required list travels as an argument. A mutant that skips loading the file now fails the canary. |
| [44693790195](https://github.com/roryeckel/hooknostic/actions/runs/44693790195) | `2cce6d15` | Green. Every Linux canary shows the three required names present, and the counts match WSL (72/71/70/74/95/65). |
| [44694633807](https://github.com/roryeckel/hooknostic/actions/runs/44694633807) | Mutant A: `--net` dropped | All six Linux entries failed in the canary before vitest: `FAIL interfaces: non-loopback: eth0` (`enp39s0` on one runner), `FAIL public IPv4 connect: 1.1.1.1:443 -> connected`, `FAIL DNS lookup`. Windows green. |
| [44695246302](https://github.com/roryeckel/hooknostic/actions/runs/44695246302) | Mutant B: a test fetching github.com | All six Linux entries: canary green, then exactly that test failed with `fetch failed`, cause `getaddrinfo EAI_AGAIN github.com`. The Windows lanes and every `lint + typecheck + test` job were green. |
| [44695948182](https://github.com/roryeckel/hooknostic/actions/runs/44695948182) | mutants dropped by force-push (back to `2cce6d15`) | Green, with the same counts and canary lines. |
| [44700854750](https://github.com/roryeckel/hooknostic/actions/runs/44700854750) | `9cb5674b`, the round-2 hardened tree | Green. Every Linux lane shows `groups: gid 1001 only` and all three IPv4 targets `ENETUNREACH`. Counts are +1 for the guard: 73/72/71/75/96/66. On the claude runner `9.9.9.9` timed out in `--online`, and the any-of-three control absorbed it. |

A commit cannot cite the CI run of its own tree, so the round-3 run is
recorded in the PR body, not here.

Hosted runners had no IPv6 even outside the namespace
(`[2606:4700:4700::1111]:443 -> ENETUNREACH` in `--online`), which confirms
the review's point that the positive control must not require IPv6.

Linux playback step, seconds. Master is run 44679264511 at 766f2370, with the
plain step. The wrapped runs are 44693790195 and 44695948182.

| Lane | Master | Wrapped (two runs) | Notes |
|---|---|---|---|
| claude | 67 | 55, 64 | |
| codex | 26 | 90, 88 | Codex's musl resolver retries each refused lookup of its plugin sync and metrics hosts |
| copilot | 42 | 54, 45 | |
| pi | 29 | 33, 28 | |
| opencode-v1 | 210 | 200, 162 | Plus 11–12 s for the prepare step |
| opencode-v2 | 175 | 190, 154 | |

Codex's added minute is the price of leaving its plugin sync on. It is well
inside the 15-minute job timeout.

## Windows (GitHub-hosted windows-latest, 2026-11-20)

The Windows playback lanes (copilot, pi, opencode-v2) and the `code-mode` job
(Codex on Windows, `scripts/verify-code-mode.mjs`) were measured on GitHub's
own windows-latest runners. strace has no Windows equivalent, and these jobs
need the runner's admin rights, so the method is different.

### Method

A temporary workflow ran one job per lane and version (run
[44839983846](https://github.com/roryeckel/hooknostic/actions/runs/44839983846),
tree `6af11f8f`, reverted afterwards). Each job:

1. Installed the harness and ran the lane's prepare step. Neither was measured.
2. Started the audit (`windows/start-audit.ps1`):
   - Windows Filtering Platform connection auditing: Security events 5156
     (allowed) and 5157 (blocked). Each event carries the process id, image,
     destination address, port and protocol.
   - Process-creation auditing with command lines: Security event 4688.
   - The DNS Client operational log.
3. Ran CI's own test command in one `pwsh` step, the "measured step":
   - playback lanes: `vitest run` over `harness-playback.test.ts`,
     `opencode-v2-playback.test.ts` and `pi-drift-driver.test.mjs`;
   - Code Mode: `node scripts/verify-code-mode.mjs`.

   Step 3 recorded the step shell's pid and the time window.
4. Exported the audit (`windows/export-audit.ps1`):
   - It joins every outbound connection to the process that made it, and walks
     that process's creators through 4688.
   - A connection is **lane** when the measured step's shell is an ancestor.
   - Otherwise it is **runner** (`Runner.Worker`, `Runner.Listener`, or the
     runner's `externals\` node) or **system**.
   - Loopback is counted per class and image, not listed.
   - Hostnames come from the DNS log's answers.

**Positive control.** `windows/probe.mjs` runs first inside the measured step.
It connects to three public IPv4 addresses, fetches `https://github.com/`, and
makes a loopback round trip. In every job these four connections appear as
**lane** egress, attributed `node.exe < pwsh.exe`. So the audit sees the step's
processes, and the classification puts them in the lane. The control is the only
egress the step adds itself; it is left out of the tables below.

**Not lane traffic, and why.** None of these processes descends from the
measured step's shell. The runner's and agents' processes were started before
the audit. They are classified by image, and the system ones have no lane
ancestor in 4688.

| Process | Destinations | What it is |
| --- | --- | --- |
| `Runner.Worker.exe` | results-receiver.actions.githubusercontent.com:443, productionresultssa8.blob.core.windows.net:443 | Step logs and results upload. The upload runs while the step is still running. |
| `Runner.Listener.exe` | broker.actions.githubusercontent.com:443 | A long-lived connection, established before the step. It shows in the inventory's `Get-NetTCPConnection`, not in 5156, which only logs new connections. |
| `hosted-compute-agent`, `provjobd.exe*` | hosted-compute-{request-orchestrator,watchdog}-*.githubapp.com:443 | GitHub's hosted-compute agent: orchestration and watchdog |
| `WindowsAzureGuestAgent.exe`, `WaAppAgent.exe` | 168.63.129.16:80 (Azure WireServer), 169.254.169.254:80 (IMDS) | Azure VM agent |
| `svchost.exe`, `taskhostw.exe`, `System` | NTP :123, crl.microsoft.com, fs.microsoft.com, settings-win.data.microsoft.com, the resolver on 168.63.129.16:53, ICMP | OS services |
| `firefox.exe < default-browser-agent.exe` | incoming.telemetry.mozilla.org | A scheduled task of the image's Firefox |

**Attribution limit.** Some requests are carried out by a service on a
process's behalf. These are attributed to the service, not to the lane. DNS is
the visible case: the DNS Client service sends every query. The DNS log still
names the requesting process (its event `Execution ProcessID`). That is how the
lookups below are attributed to lane processes.

### Results

The playback harness already applies `playbackQuiet` on every OS, so this is
the state after the Linux switches. It is captured for Codex: the
`-c analytics.enabled=false` is in the 4688 command lines. For OpenCode it is an
inference: no `models.opencode.ai` or `opencode.ai` connection appeared. The
environment is not in the audit.

| Lane | audited | enforced | Non-loopback destinations (audited) |
| --- | --- | --- | --- |
| copilot 1.0.101 | 77 passed, 70 skipped | not run | **none** |
| copilot 1.0.114 (latest) | same | not run | **none**. DNS only: `copilot.exe` looked up `wpad.*.internal.cloudapp.net` (proxy auto-discovery), 95 queries, no answer, no connection |
| pi 1.3.0 | 82 passed, 65 skipped | not run | **none** |
| pi 1.6.0 (latest) | same | not run | **none** |
| opencode-v2 2.0.17 | 102 passed, 45 skipped | not run | **none** |
| opencode-v2 2.3.2 (latest) | same | not run | **none** |
| code-mode, codex 0.156.1 | 3 passed, 75 skipped | not run | github.com (git), chatgpt.com |
| code-mode, codex 0.171.0 (latest) | same | not run | github.com (git). **chatgpt.com was not contacted** |

Every lane also made loopback connections: its model server, the MCP servers,
and OpenCode's local server, 51 to 437 per job. This shows the audit saw the
harness processes themselves.

#### code-mode

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| github.com:443 (140.82.112.3, 140.82.113.3, 140.82.114.4) | `git-remote-https https://github.com/openai/plugins.git`, chain `git.exe < git.exe < git.exe < codex.exe < node.exe`, 4 transports in each version | The curated plugin catalog sync, as on Linux (**captured**: the URL is in the argv) | **No** | `-c features.plugins=false` (**captured** on Linux only; see codex 0.148.0 above). Linux leaves it alone. |
| chatgpt.com:443 (172.64.155.209) | `codex.exe exec -`, the Code Mode drive, already with `-c analytics.enabled=false`, 2 connections. 0.156.1 only. | The curated plugin export, as on Linux (**inference**, from the Linux evidence) | **No** | `-c features.plugins=false` (**inference** from Linux) |

There was no ab.chatgpt.com: `analytics.enabled=false` holds on Windows too
(**captured**).

### Firewall trials (same run, job "firewall trials")

`windows/firewall-trial.ps1` ran on a fresh runner.

**Inventory:**
- Firewall on in all three profiles; `DefaultOutboundAction`
  `NotConfigured`, which acts as Allow.
- Services: `mpssvc` and `bfe` running; `seclogon` stopped, manual start.
- The step runs as `runneradmin`, an administrator. `Runner.Listener` and
  `Runner.Worker` run as the same user, from
  `C:\actions-runner\cached\2.338.2\bin\`.
- The runner talks home over HTTPS to broker., launch. and
  results-receiver.actions.githubusercontent.com, and to blob storage.

Each trial ran `probe.mjs` afterwards:

| Mechanism | Public IPv4 (3) | HTTPS | DNS lookup | Loopback round trip | Side effects |
| --- | --- | --- | --- | --- | --- |
| none | connected | 200 | resolved | yes | — |
| (a) outbound block rule for `node.exe` (the toolcache image) | `EACCES` | `EACCES` | **resolved** | yes | — |
| (b) `DefaultOutboundAction Block` on all profiles, allow rules for `Runner.Listener`, `Runner.Worker` and the runner's `externals\node20`/`node24` | `EACCES` | `EACCES` | **resolved** | yes | For 30 s and one later step, the runner kept streaming logs. `actions/upload-artifact` uploaded and finalized under the block (artifact `egress-windows-firewall-trial-b`). |
| (c) outbound block rule for one dedicated local user's SID (`-LocalUser "D:(A;;CC;;;<SID>)"`), probe started as that user with `Start-Process -Credential` | `EACCES` | `EACCES` | **resolved** | yes | The step's own user stayed online under the same rule. Starting the probe as a scheduled task under that user did not run (result `267011`). |

`restore` put every profile back to its recorded state, both times, with 0
trial rules left (**captured**).

What this shows (**captured**):
- Loopback is exempt from the firewall's block rules: the round trip worked
  under all three mechanisms. WFP still logs it as 5156.
- No mechanism stops DNS resolution. Lookups go through the DNS Client service,
  which the firewall's built-in rules allow. This differs from Linux, where
  lookups in the namespace fail with `EAI_AGAIN`. A process can still leak data
  through query names, but it can open no connection to the answer.
- What (b)'s test did not cover: a runner session that lasts minutes, and the
  hosted-compute and Azure agents. None of these agents was in the allow list,
  and none of them connected during the trial.

### Marketplace (ubuntu `marketplace` job, WSL, 2026-11-20)

`node scripts/verify-marketplaces.mjs <claude|codex>` (the job's command) was
run with the Linux tools above: traced as the user, then inside
`scripts/without-network.sh`. It runs at the reference versions. It is a
loopback-model job, and today it runs outside the namespace.

| Lane | traced | nonet | Non-loopback destinations (traced) |
| --- | --- | --- | --- |
| claude 2.1.260 | 3 passed, 77 skipped | same | api.anthropic.com |
| codex 0.153.2 | 6 passed, 74 skipped | same | github.com (git), chatgpt.com, ab.chatgpt.com |

| Destination | Process and test | Purpose | Needed | Knob |
| --- | --- | --- | --- | --- |
| api.anthropic.com:443 | `claude plugin marketplace add <dir>`, 2 of 7 harness processes. `marketplace-example.test.ts` passes it the test's `env`, which has no `ANTHROPIC_BASE_URL`. | As for `plugin validate` above (**captured** for that call) | **No** | `ANTHROPIC_BASE_URL` on loopback (**captured** for `plugin validate`, **inference** for `marketplace add`) |
| github.com:443 | `git-remote-https https://github.com/openai/plugins.git`, 7 processes | Curated plugin sync (**captured**) | **No** | `-c features.plugins=false` (**captured**, codex 0.148.0) |
| chatgpt.com, ab.chatgpt.com:443 | `codex exec hello …`, 4 processes. The test builds its own `-c` list, without `analytics.enabled=false`. | Plugin export and metrics, as above | **No** | `-c analytics.enabled=false` for ab.chatgpt.com (**captured**, as above) |

### Files

| File | What it is |
| --- | --- |
| `windows/start-audit.ps1` | Turn on WFP, process-creation and DNS Client logging (admin) |
| `windows/export-audit.ps1` | Write `summary.json` and `outbound.csv`: destinations by class, process, chain and command line; DNS queries with answers and the requesting process |
| `windows/probe.mjs` | The connectivity probe and positive control |
| `windows/firewall-trial.ps1` | `inventory`, trials `a`, `b`, `c`, and `restore` |

The per-job `summary.json` and `outbound.csv` files are artifacts of run
44839983846, kept for 14 days. The marketplace traces were reduced with
`parse_strace.py`.

## Acted on: option B (2026-11-21)

The rule is the same on every OS. Every CI job that drives a real harness
and is meant to be offline runs with non-loopback IP blocked, so a lane that
needs a new download, or a build that starts calling home, fails loudly.

The goal is **accidental** egress. Stopping a deliberate escape is a
non-goal: these are our own tests against harness builds pinned by version.
"Hardening findings" below records what that would have taken.

The block covers what a lane's own processes do. The documented limitations
are what something outside them does on its behalf (`docs/testing.md`,
"Network isolation in CI"):
- on Windows, hostnames still resolve through the system DNS Client service
  (measured: a lane can look a name up, but cannot connect to it);
- other Windows service-mediated requests, such as certificate revocation
  fetches, are made outside the lane user's rule (not measured; see "Not
  measured");
- on Linux, a host daemon reachable over a unix socket could reach the
  network for the lane (`docs/testing.md`, "IP only").

| Job | Block | Where |
| --- | --- | --- |
| ci.yml `harness-playback`, Linux (×6) | loopback-only network namespace | `scripts/without-network.sh` (unchanged) |
| ci.yml `harness-playback`, Windows (copilot, pi, opencode-v2) | a dedicated standard user, with one outbound block rule on its SID | `scripts/without-network.ps1` |
| ci.yml `code-mode` (Windows) | the same | the same |
| ci.yml `marketplace` (claude, codex) | the Linux namespace, after the install switches | `without-network.sh` |
| harness-watch `verify` | the Linux namespace, after a prepare step | `without-network.sh` |
| harness-watch `drift`, playback transport | phase 2 of two containers, `--network none` | the workflow |
| harness-watch `drift`, llm transport | none: online by design (the LiteLLM sidecar) | — |

The CI evidence is in "Option B CI evidence" below.

## Supporting measurements for option B

### Marketplace with the switches (WSL, 2026-11-21)

The committed test change gives both claude install calls (`plugin
marketplace add`, `plugin install`) `ANTHROPIC_BASE_URL` on a refused
loopback port, and keeps the test's own environment object. Every codex call
gets `-c analytics.enabled=false`. It was traced with that tree.

| Lane | traced | inside `without-network.sh` | Non-loopback destinations (traced) |
| --- | --- | --- | --- |
| claude 2.1.260 | 3 passed | 3 passed | **none**: 0 of 7 harness processes (without the switch: api.anthropic.com from `plugin marketplace add`) |
| codex 0.153.2 | 6 passed | 6 passed, 17 s | github.com (git plugin sync) and chatgpt.com (plugin export). ab.chatgpt.com gone. |

### Codex's plugin sync: `features.plugins=false` measured, not used (WSL)

Inside `without-network.sh`, with `-c features.plugins=false` added to
`playbackQuiet.codexArgs`:

| Build | As is | With the key |
| --- | --- | --- |
| codex 0.148.0 (ci.yml reference) | 72 passed, 87 s | 72 passed, 13 s, the plugin drives passing |
| codex 0.171.0 (latest) | 74 passed, 15 s | 3 failed: both "through an installed plugin" drives, and "starts a projected MCP server through the generated launcher" |
| marketplace gate, codex 0.153.2 | 6 passed, 17 s | 1 failed: the marketplace install |

Newer builds gate installed plugins behind the same key, so it stays off,
and so did the namespace's resolver-retry cost, about 60 s in CI at 0.148.0
and gone at 0.171.0. That cost was later removed in the wrapper instead
("The codex resolver wait, removed").

### harness-watch verify and drift (ubuntu-latest, run 44845678483)

**verify**: a prepare step with `--version <latest> --check-online`, then
`without-network.sh`.
- opencode-v1 1.19.6: 64 passed.
- opencode-v2 2.3.2: 93 passed, 1 failed. The failure is the
  "followed-up subagent agent.stop" test, seen before with and without
  network: the drive's race, fixed in `aebf9de5` (see "Results at the latest
  versions" above).

**drift, playback transport**:
- Phase 1, `--network bridge`, installs the harness into the mounted `/drift`
  and runs `prepare-offline-playback.mjs --check-online`.
- Phase 2, `--network none`, with the phase-1 prefix, npm cache and
  `HKN_RIPGREP_DIR`, runs the isolation check, then the drive.
- The container check passed: loopback only; IPv4 and IPv6 `ENETUNREACH`;
  DNS `EAI_AGAIN`; uid 1000; CapEff 0; NoNewPrivs 1.

| Harness | bridge (old shape) | phase 2, `--network none` |
| --- | --- | --- |
| pi 1.6.0 | 0 | 0 |
| codex 0.171.0 | 0, clean | 0, clean |
| opencode-v2 2.3.2 | 4, drift | 4, drift, with the same report |

### Windows lanes as a dedicated user (windows-latest)

The prototype these measurements used is on PR #288's branch, not in
master's history (see "Hardening findings").

**As the lane user at Medium integrity**, which is option B's level (run
44845678483):

| Job | Result |
| --- | --- |
| copilot | 78 passed |
| Code Mode | 3 passed |
| pi | failed only `'pnpm' is not recognized` (2 tests) |
| opencode-v2 | failed only `'pnpm' is not recognized` (6 tests) |

pnpm/action-setup puts pnpm under the runner user's profile, which the lane
user cannot reach. With pnpm at `dest: ${{ runner.tool_cache }}/...`, pi passed
83 and opencode-v2 103 (run 44851379004). Those runs were at Low integrity.
**Medium integrity with `dest:` together was not measured before option B's
CI run**, which is that measurement.

**Network as the lane user** (every run):
- public IPv4 `EACCES` ×3;
- IPv6 `ENETUNREACH` (the runner has no IPv6 route);
- HTTPS `EACCES`;
- the loopback round trip works;
- DNS resolves;
- BITS refused ("the user has not logged on");
- `certutil -urlcache` blocked.

**Environment**: the allowlist passed 40–43 of 155–163 names. The names kept
out include the `ACTIONS_*` ones, the five file-command paths and the blank
API keys. No `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_*` or `GITHUB_TOKEN`
was in a `run` step's environment.

**Timeouts**: the `always()` cleanup ran after a 1-minute step timeout and
after a 4-minute job timeout (job cancelled). Both times, 4 lane processes
had outlived the runner's kill of the step, and the owner-SID stop left 0.
Cancellation from the UI was not tried.

## Hardening findings (out of scope)

The trials also measured what a lane user could do beyond the network,
which option B leaves alone by design.

**Windows**: a standard user at Medium integrity on windows-latest could:
- create files in the workspace (`scripts\`, `.git\`, `node_modules\`),
  `RUNNER_TEMP` and `_runner_file_commands`, `_actions`, the npm prefix on
  PATH, the toolcache, the pnpm store, and the runner's root and `bin`;
- modify toolcache files;
- read the runner's `.credentials` and `.runner`, the checkout's token file
  and the file-command files;
- make symlinks, because Developer Mode is on.

The cause is the image's volume ACLs (`Authenticated Users:(OI)(CI)(IO)(M)`
on `C:\`).

**Linux**: `/opt/hostedtoolcache` and the tool trees under it are
world-writable on ubuntu-latest. A separate lane user could create files in
node's toolcache `bin`, the npm global `node_modules` and pnpm's directory.
With traverse on `~runner` (mode 750), it could read the file-command files,
the checkout's credentials file and the runner's `.credentials` (all 644).

**Why out of scope**: the goal is accidental egress from our own tests
against pinned builds. Closing these took:
- on Windows: Low integrity, deny-read ACEs, a Low-labelled profile and a
  trusted-state snapshot;
- on Linux: read-only mount, tmpfs and PID namespaces, a separate user and a
  post-run ctime and hash check.

Both were measured working: runs 44845678483, 44846805022, 44847702464,
44848733702, 44851379004, 44852516193 and 44853112456. The evidence is those
run URLs. The prototype scripts are not kept in the tree. PR #288 is squash-merged,
so they are not in master's history either: they are on the PR's ref,
`refs/pull/288/head`, at commit `3e4430e6` and before
(`.capture/network-egress/linux/`, `windows/lane-*`). Fetch them with
`git fetch origin pull/288/head` and `git show 3e4430e6:<path>`.
The design is in the owner's planning notes, should the threat model change.

## Option B CI evidence

| Run | Tree | Outcome |
| --- | --- | --- |
| [44859999263](https://github.com/roryeckel/hooknostic/actions/runs/44859999263) | `8a704b75` | Every harness job green. The dependency policy failed: pnpm/action-setup's new `with:` block (`dest:`) made Renovate emit a versionless `pnpm` record. Fixed in `c1792a5e`, the same tolerance as for setup-node's `node`. |
| [44860715850](https://github.com/roryeckel/hooknostic/actions/runs/44860715850) | `c1792a5e` | **Green.** Every Windows lane and Code Mode passed the canary (see below), with copilot 78, pi 83, opencode-v2 103 and Code Mode 3. That is the first measurement of Medium integrity with `dest:` together, and it equals the trial's counts. Cleanup reported "lane processes left after stopping: 0; firewall rules removed: 1; left: 0". Both marketplace jobs passed their namespace canary: claude 3 passed, codex 6. |
| [44861473576](https://github.com/roryeckel/hooknostic/actions/runs/44861473576) | `ebd0f024`, Mutant A: `unshare` without `--net`, and no firewall rule | Every blocked job failed in the isolation check, and vitest never ran. Linux lanes and marketplace failed on `interfaces`, `public IPv4 connect` and `DNS lookup`. Windows lanes and Code Mode failed on `public IPv4 connect` only ("the command did not run"). The unit-test, policy and compatibility jobs stayed green. Reverted in `7e0adbcb`. |
| [44861950218](https://github.com/roryeckel/hooknostic/actions/runs/44861950218) | `5483a250`, Mutant B: a test that fetches `https://github.com/`, titled to match the Code Mode and marketplace filters | In every blocked job the canary passed and exactly that test failed (`fetch failed`): `EAI_AGAIN` in the Linux namespace, `EACCES` behind the Windows rule. All other counts were unchanged. The ordinary test jobs, with network, passed it. Reverted in `8b678a75`. |
| [44862544444](https://github.com/roryeckel/hooknostic/actions/runs/44862544444) | `8b678a75` | **Green**, with the same counts and canary lines. |
| [44862570019](https://github.com/roryeckel/hooknostic/actions/runs/44862570019) | `8b678a75`, harness-watch `workflow_dispatch`, `harness=opencode-v2`, `dry_run=true` | See below. No record, report, publish or automerge job ran. |

The harness-watch dispatch:
- **drift**: phase 1 printed "ripgrep ready at /drift/ripgrep/rg". Phase 2's canary passed, with `HOOKNOSTIC_PLAYBACK_VERSION` and `HKN_RIPGREP_DIR` present, loopback only, `ENETUNREACH`, `EAI_AGAIN`, uid 1000, CapEff 0 and NoNewPrivs 1. The drive completed: verdict drift, exit 4, the prototype's bridge result. No drive failure means no refetch.
- **verify**: the `--check-online` control and the namespace canary passed, with all three names present. Then 93 passed and 1 failed, both on the first attempt and on the retry. The failure is the pre-existing opencode-v2 2.3.2 test "reports each completion of a followed-up subagent as its own agent.stop" (`expected 1 to be 2`), which also fails with network (WSL: 1 of 5 runs with network, 2 of 5 without; master's own dispatch 44865794385 failed it on attempt 2). Cause: the drive's follow-up raced the background child; fixed by a constructed ordering (`aebf9de5`, `.capture/opencode-v2/README.md`, "subagent-followup").

### Drift's two phases, every harness, locally (2026-11-21)

The first dispatch (44862570019) ran drift for opencode-v2 only; a later
one ran codex (44928700826, see "The codex resolver wait, removed"). To check
that phase 2 needs
nothing fetched for the others, the committed step ("Run the drift
capture-compare", after `7d023fdc`) was run as it stands, with its `${{ }}`
expressions filled in:
- with Docker Desktop's Linux engine on Windows and the same
  `node:24.22.3-bookworm` image;
- on a workspace built from `HEAD` in a Linux container (`pnpm install
  --frozen-lockfile`, `pnpm run bundle`);
- at each harness's newest build, playback transport.

Every phase 2 passed the isolation check (loopback only, `ENETUNREACH`,
`EAI_AGAIN`, uid 1000, CapEff 0, NoNewPrivs 1), and every drive completed:

| Harness | Phase 1 | Phase 2 drive | Verdict (code) |
| --- | --- | --- | --- |
| claude 2.1.330 | install, `install.cjs`, prepare | harness exit 0, 6 payloads | clean (0) |
| opencode-v1 1.19.6 | install, bootstrap, npm cache for `@opencode-ai/plugin@1.19.6`, proved offline for both prefixes | plugin installed `--offline` in scratch; harness exit 0, 91 payloads | clean (0) |
| codex 0.171.0 | install, prepare | harness exit 0, 6 payloads | clean (0) |
| copilot 1.0.114 | install, prepare | harness exit 0, 7 payloads | drift (4) |
| pi 1.6.0 | install, prepare | harness exit 0, 37 payloads | clean (0) |

copilot's drift is the comparator's, not the block's: run again with phase 2
on the bridge and without the check, it gave drift (4) with an identical
report. So Claude's bootstrap keeps nothing outside `/drift/prefix` that
phase 2 needs, which was the reviewed risk, and with opencode-v2's dispatch
every harness has now run the split.

The Windows canary, as every Windows lane printed it in the green runs:

```
assert-no-network --offline: ok   user: the wrapper's SID
assert-no-network --offline: ok   administrators: not a member
assert-no-network --offline: ok   public IPv4 connect: 1.1.1.1:443 -> EACCES, 8.8.8.8:443 -> EACCES, 9.9.9.9:443 -> EACCES
assert-no-network --offline: ok   public IPv6 connect: [2606:4700:4700::1111]:443 -> ENETUNREACH
assert-no-network --offline: ok   loopback round trip: round-trip
assert-no-network --offline: ok   DNS lookup (allowed on Windows): github.com -> resolved
assert-no-network --offline: ok   environment: HOOKNOSTIC_PLAYBACK_NETWORK=none set; present: HOOKNOSTIC_PLAYBACK, HKN_PLAYBACK_ARTIFACT_DIR, HKN_RIPGREP_DIR; no forbidden names
```

The allowlist passed 42–44 names and kept 116–120 out, including the
`ACTIONS_*` names and the five file-command paths.

**Time added against master**: step times, green run 44862544444 against
master run 44679264511. Runner variance is about ±20 s on unchanged jobs.

| Job | Option B | Master | Added |
| --- | --- | --- | --- |
| copilot, Windows: the lane step / cleanup | 84 s / 3 s | 70 s | ≈ +17 s |
| pi, Windows | 69 s / 4 s | 56 s | ≈ +17 s |
| opencode-v2, Windows | 205 s / 2 s | 285 s | within variance; the wrapper's own setup is 20–28 s in its log |
| Code Mode gate / cleanup | 28 s / 3 s | 26 s | ≈ +5 s |
| marketplace codex gate | 18 s | 8 s | ≈ +10 s (the plugin sync's resolver retries; since removed, "The codex resolver wait, removed") |
| marketplace claude gate | 4 s | 6 s | ≈ 0 |
| harness-watch verify, opencode-v2 | prepare 0 s (ripgrep cached), playback 229 s | playback 132 s (2.3.0, an older build) | not attributable: another build, and a failing test that waits |
| harness-watch drift, opencode-v2 | 54 s (job) | 3–88 s (jobs) | within the range |
| Linux playback lanes | unchanged since #288's namespace | — | codex about +60 s (the plugin sync's retries; since removed, "The codex resolver wait, removed"), the others within variance |

## The codex resolver wait, removed (WSL, 2026-11-21)

The codex lane ran about a minute longer in the namespace than with
network, and the codex marketplace gate about 10 s. Measured before any
change, the cause is DNS, but only for musl.

**Lookups in a loopback-only namespace**, each configuration bound over
`/etc/resolv.conf` in a private mount namespace:
- `getent ahosts` (glibc) failed in 1-2 ms;
- Node's `dns.lookup` failed with `EAI_AGAIN` and `dns.resolve4` (c-ares)
  with `ECONNREFUSED`, in milliseconds past Node's start;
- this held for WSL's `nameserver 10.255.255.254` (no route), a runner's
  `127.0.0.53` stub, `127.0.0.1`, `timeout:1 attempts:1`, and no
  nameserver line;
- `localhost` and `127.0.0.1` resolved from `/etc/hosts`, with no DNS
  query, in every case.

**Where the codex lane's time went** (codex 0.148.0):
- 12 s with network, 90-97 s in the namespace; 80.7 s of growth, about 5 s
  for each of its codex tests;
- no non-loopback connect, and the timed sleeps (`nanosleep`) under 9 s;
- per codex process, a `tokio-rt-worker` thread sent the query for
  `chatgpt.com` (another, `api.github.com`) to the nameserver; `sendto`
  failed at once with `ENETUNREACH`. musl's resolver ignores that: it
  `poll`ed 2.5 s for a reply, sent again, and `poll`ed 2.5 s more, its
  default 5 s timeout over two attempts. Two lookups in parallel, so about
  5 s a process. The codex binary is `x86_64-unknown-linux-musl`.

**The whole codex lane in the namespace, by resolver file:**

| `/etc/resolv.conf` | Wall | Tests |
| --- | --- | --- |
| as on a runner: `nameserver 127.0.0.53` | 91 s | 72 passed |
| `nameserver 127.0.0.1` (closed port) | 92 s | 72 passed |
| `options timeout:1 attempts:1` (any nameserver, or none) | 22-24 s | 72 passed |
| `options timeout:0 attempts:1` | 13 s | 72 passed |

A closed loopback port does not help: musl sends on an unconnected socket,
so no refusal reaches it. `timeout:0` stops musl's send loop from running,
and leaves glibc and c-ares failing at once as before.

**Acted on** (`scripts/without-network.sh`): the namespace gets a private
mount namespace, and its `/etc/resolv.conf` is the host's file with
`options timeout:0 attempts:1` appended. Nothing is reachable there, so a
lookup could only fail; this only makes it fail at once. The host's file was
byte-identical after every run. The isolation check gained a bounded DNS
miss and, with `--dns-timeout 0`, a check of the effective resolver
timeout. Without the file it printed `FAIL resolver timeout: 5 s in
/etc/resolv.conf, expected 0 s`, with its own (glibc) lookup still at 2 ms.

**Through the wrapper, at the CI reference versions, before and after**, with
every count unchanged:

| Lane | Before | After |
| --- | --- | --- |
| codex 0.148.0 | 91 s | 14 s |
| marketplace codex 0.153.2 | 19 s | 3 s |
| claude 2.1.238 | 39 s | 39 s |
| copilot 1.0.101 | 33 s | 33 s |
| pi 1.3.0 | 18 s | 17 s |
| opencode-v1 1.18.18 | 156 s | 155 s |
| opencode-v2 2.0.17 | 146 s | 146 s |
| marketplace claude 2.1.260 | 3 s | 3 s |

harness-watch drift's phase 2 is a `--network none` container, not this
wrapper. It gets the same setting from Docker's `--dns-option timeout:0
--dns-option attempts:1`:
- Docker Desktop 29.6.2 wrote `options timeout:0 attempts:1` into the
  container's `/etc/resolv.conf`.
- Docker checks no option: a bogus `hkn-bogus:1` was written with exit 0.
  So phase 2's isolation check passes `--dns-timeout 0`. With the option
  misspelled (`timeout=0`), it failed `resolver timeout: 5 s`, and phase 2
  stopped before the drive.
- The committed step for codex 0.171.0, twice each: phase 2 took 20.1 s and
  17.1 s before, 11.2 s and 10.8 s after. The verdict was clean every time.
- On a runner's own Docker Engine too: harness-watch dispatch 44928700826
  (`harness=codex`, `dry_run`, at `5992283c`, codex 0.171.0). Phase 2's check
  printed `resolver timeout: 0 s in /etc/resolv.conf, expected 0 s` and
  `DNS lookup: github.com -> EAI_AGAIN in 2 ms`, and the verdict was clean.
  The whole drive step took about 19 s. Its log cannot split the phases (the
  report is printed after both), and no runner drift of codex ran before the
  option, so there is no runner before-and-after.

## Not measured

- **macOS.** No macOS job drives a real harness except the manual
  `shell-interpreter-capture.yml`. The macOS unit-test entries leave
  `HOOKNOSTIC_PLAYBACK` and `HOOKNOSTIC_SMOKE` empty and install no harness.
- **Left after option B's CI runs**:
  - drift's two phases on a GitHub-hosted runner for harnesses other than
    opencode-v2 and codex (dispatches 44862570019 and 44928700826). The
    committed step ran locally for the five besides opencode-v2 ("Drift's
    two phases, every harness, locally" above);
  - cancellation of a Windows job from the UI, where `always()` is not
    guaranteed (step and job timeouts were measured).
- **Service-mediated Windows requests** other than DNS (for example WinHTTP
  proxy auto-discovery, or certificate revocation fetches made by a service).
  They are attributed to the service. `svchost.exe` fetched crl.microsoft.com
  during the copilot and opencode-v2 jobs; whether a lane triggered it is not
  known.
- **A traced inventory on a GitHub-hosted runner.** WSL's NAT network and
  resolver differ from a runner's: the runner uses the systemd-resolved stub
  at 127.0.0.53. The destination traces ran only in WSL. The enforcement did
  run on runners (see "CI evidence" above). There, lookups inside the
  namespace failed with `EAI_AGAIN`, and the Codex resolver delay persisted,
  at about a minute per lane, until the wrapper's resolver file ("The codex
  resolver wait, removed"), measured in WSL.
- **Request paths and bodies.** Purposes come from the binaries' strings and
  from which knob removes a destination. TLS hides the path, and no MITM proxy
  was used.
- **The ripgrep cold-cache path** (#264). It is test infrastructure, already
  documented in `.capture/opencode-v2/README.md`.
- **Writes that strace does not show.** Node writes TCP data with `write` and
  `writev`, which were not traced, so SNI is missing for Node clients. Every
  connection is still recorded through its `connect` and DNS query.
- **Packed-consumer and Yarn Plug'n'Play checks.** These are separate gates,
  not playback lanes, and drive no harness. The packed-consumer marketplace
  job runs in CI; the Yarn Plug'n'Play suite runs only by hand
  (`docs/testing.md`). Marketplace and Code Mode are in "Windows" above.
