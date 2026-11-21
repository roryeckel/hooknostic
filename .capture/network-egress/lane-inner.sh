#!/usr/bin/env bash
# Run one playback lane exactly as CI's "Run model-free playback" step does.
#   lane-inner.sh <lane> <version> <mode> <run-dir> [playback-version-env] [extra-env-file] [seed-home-dir]
# mode: traced | nonet | nonet-traced. Runs as the unprivileged user. Modes
# containing "traced" run the whole vitest process tree under strace; modes
# starting with "nonet" are entered by run-lane.sh inside a network namespace
# with only loopback up.
# extra-env-file: KEY=VALUE lines exported before the run (knob probes and
# measurement variants only; never credentials).
# seed-home-dir: copied into the fresh HOME first (e.g. a warmed npm cache).
set -uo pipefail
source "${HNE:-$HOME/hn-egress}/env.sh"
lane="$1"; version="$2"; mode="$3"; run="$4"; pbv="${5:-}"; extra="${6:-}"; seed="${7:-}"
rm -rf "$run"; mkdir -p "$run/home" "$run/tmp" "$run/artifacts"
[ -n "$seed" ] && cp -a "$seed/." "$run/home/"
export HOME="$run/home" TMPDIR="$run/tmp"
export PATH="$HNE/harness/$lane-$version/bin:$PATH"
export CI=true GITHUB_ACTIONS=true
export HOOKNOSTIC_PLAYBACK="$lane"
[ -n "$pbv" ] && export HOOKNOSTIC_PLAYBACK_VERSION="$pbv"
export HKN_PLAYBACK_ARTIFACT_DIR="$run/artifacts"
export HKN_RIPGREP_DIR="$HNE/ripgrep"
export ANTHROPIC_API_KEY="" ANTHROPIC_AUTH_TOKEN="" OPENAI_API_KEY="" OPENROUTER_API_KEY=""
if [ -n "$extra" ]; then
  set -a; source "$extra"; set +a
fi
cd "$HNE/repo"
{
  echo "lane=$lane version=$version mode=$mode date_utc=$(date -u +%FT%TZ)"
  echo "playback_version_env=${pbv:-unset} extra_env=${extra:-none} seed_home=${seed:-none}"
  [ -n "$extra" ] && sed 's/^/  extra: /' "$extra"
  echo "kernel=$(uname -sr) node=$(node -v) which=$(command -v "$(case $lane in opencode*) echo opencode;; *) echo "$lane";; esac)")"
  ip -br addr 2>/dev/null
} > "$run/meta.txt"
cmd=(pnpm exec vitest run packages/cli/test/harness-playback.test.ts packages/cli/test/opencode-v2-playback.test.ts scripts/pi-drift-driver.test.mjs
     --reporter=verbose --reporter=json --outputFile.json="$run/vitest.json")
# Optional: repeat one test by name (HN_TEST_FILTER, a vitest -t pattern).
[ -n "${HN_TEST_FILTER:-}" ] && cmd+=(-t "$HN_TEST_FILTER")
start=$(date +%s)
case "$mode" in
  *traced)
    strace -f --seccomp-bpf -qq -ttt -s 512 -e signal=none \
      -e trace=connect,sendto,sendmsg,sendmmsg,recvfrom,recvmsg,execve,clone,clone3,fork,vfork \
      -o "$run/strace.log" "${cmd[@]}" > "$run/vitest.out" 2>&1 ;;
  *)
    "${cmd[@]}" > "$run/vitest.out" 2>&1 ;;
esac
code=$?
echo "exit=$code seconds=$(( $(date +%s) - start ))" >> "$run/meta.txt"
tail -5 "$run/vitest.out"
echo "exit=$code"
