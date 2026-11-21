#!/usr/bin/env bash
# Standalone OpenCode knob probes (network available, under strace). The v2
# playback drive strips every OPENCODE* variable, so knobs are probed here.
source "${HNE:-$HOME/hn-egress}/env.sh"
P="$HNE/probes-opencode"; rm -rf "$P"; mkdir -p "$P"
ST=(strace -f --seccomp-bpf -qq -ttt -s 512 -e signal=none -e trace=connect,sendto,sendmsg,sendmmsg,recvfrom,recvmsg,execve,clone,clone3,fork,vfork)
python3 -I "$(dirname "$0")/probe-server.py" 18556 & srv=$!
sleep 1

probe() { # family version name env...
  local fam="$1" ver="$2" name="$3"; shift 3
  local d="$P/$fam-$ver-$name"; mkdir -p "$d/project" "$d/root"
  local bin="$HNE/harness/$fam-$ver/bin/opencode"
  if [ "$fam" = opencode-v2 ]; then
    cat > "$d/project/opencode.json" <<'JSON'
{"model":"playback/egress-probe","providers":{"playback":{"name":"Playback","env":["HKN_PLAYBACK_KEY"],"package":"@opencode/ai/providers/openai-compatible","settings":{"baseURL":"http://127.0.0.1:18556/v1"},"models":{"egress-probe":{"name":"Probe","limit":{"context":128000,"output":4096}}}}}}
JSON
    args=(run --standalone --auto --format json "say hi")
  else
    cat > "$d/project/opencode.json" <<'JSON'
{"$schema":"https://opencode.ai/config.json","provider":{"playback":{"npm":"@ai-sdk/openai-compatible","name":"Playback","options":{"baseURL":"http://127.0.0.1:18556/v1","apiKey":"probe"},"models":{"egress-probe":{"name":"Probe"}}}}}
JSON
    args=(run "say hi" --model playback/egress-probe --print-logs --log-level DEBUG)
  fi
  ( cd "$d/project" && env -i PATH="$PATH" HOME="$d/root" PWD="$d/project" CI=true GITHUB_ACTIONS=true HKN_PLAYBACK_KEY=probe \
      XDG_DATA_HOME="$d/root/data" XDG_CONFIG_HOME="$d/root/config" XDG_CACHE_HOME="$d/root/cache" XDG_STATE_HOME="$d/root/state" "$@" \
      timeout 60 "${ST[@]}" -o "$d/strace.log" "$bin" "${args[@]}" < /dev/null > "$d/out.txt" 2>&1; echo "exit=$?" >> "$d/out.txt" )
}
for fv in opencode-v2:2.0.17 opencode-v1:1.18.18; do
  f="${fv%%:*}"; v="${fv#*:}"
  probe "$f" "$v" baseline
  probe "$f" "$v" models-off OPENCODE_DISABLE_MODELS_FETCH=1
  probe "$f" "$v" autoupdate-off OPENCODE_DISABLE_AUTOUPDATE=1
  probe "$f" "$v" both-off OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
done
kill $srv
for d in "$P"/*/; do
  python3 -I "$(dirname "$0")/parse_strace.py" "$d/strace.log" > "$d/summary.json"
  python3 -I - "$d/summary.json" "$(basename "$d")" "$(tail -1 "$d/out.txt")" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
names = sorted({q["name"] for q in s["dns_queries"]})
conns = sorted({f'{",".join(d["tls_sni"] or d["hostnames"]) or d["ip"]}:{d["port"]}' for d in s["destinations"] if d["port"] not in (0, 53, 65535)})
print(f'{sys.argv[2]:<34} {sys.argv[3]:<8} dns={names} connects={conns}')
PY
done
