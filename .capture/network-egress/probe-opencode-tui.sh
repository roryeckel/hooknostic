#!/usr/bin/env bash
# OpenCode v2 interactive TUI startup under a pty (script(1)), stopped after
# 10 s, with each knob. Network available, under strace.
source "${HNE:-$HOME/hn-egress}/env.sh"
P="$HNE/probes-opencode-tui"; rm -rf "$P"; mkdir -p "$P"
ST="strace -f --seccomp-bpf -qq -ttt -s 512 -e signal=none -e trace=connect,sendto,sendmsg,sendmmsg,recvfrom,recvmsg,execve,clone,clone3,fork,vfork"
bin="$HNE/harness/opencode-v2-2.0.17/bin/opencode"
probe() {
  local name="$1"; shift
  local d="$P/$name"; mkdir -p "$d/project" "$d/root"
  cp "$HNE/probes-opencode/opencode-v2-2.0.17-baseline/project/opencode.json" "$d/project/"
  ( cd "$d/project" && env -i PATH="$PATH" HOME="$d/root" PWD="$d/project" TERM=xterm-256color COLUMNS=120 LINES=35 CI=true HKN_PLAYBACK_KEY=probe \
      XDG_DATA_HOME="$d/root/data" XDG_CONFIG_HOME="$d/root/config" XDG_CACHE_HOME="$d/root/cache" XDG_STATE_HOME="$d/root/state" "$@" \
      timeout -s KILL 12 script -q -e -c "$ST -o $d/strace.log $bin --standalone --auto" /dev/null < /dev/null > "$d/out.txt" 2>&1; echo "exit=$?" >> "$d/out.txt" )
}
probe baseline
probe autoupdate-off OPENCODE_DISABLE_AUTOUPDATE=1
probe models-off OPENCODE_DISABLE_MODELS_FETCH=1
probe both-off OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
for d in "$P"/*/; do
  python3 -I "$(dirname "$0")/parse_strace.py" "$d/strace.log" > "$d/summary.json"
  python3 -I - "$d/summary.json" "$(basename "$d")" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
names = sorted({q["name"] for q in s["dns_queries"]})
conns = sorted({f'{",".join(d["tls_sni"] or d["hostnames"]) or d["ip"]}:{d["port"]}' for d in s["destinations"] if d["port"] not in (0, 53, 65535)})
print(f'tui-{sys.argv[2]:<20} dns={names} connects={conns}')
PY
done
