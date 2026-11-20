#!/usr/bin/env bash
# Standalone knob probes (network available, under strace), each variant in a
# fresh HOME: `claude plugin validate` (the one Claude invocation in the lane
# that runs without the drive's environment) and `codex exec` against
# probe-server.py, which completes one turn so Codex exits normally.
# The Claude variants ran in two rounds on the day (baseline, nonessential,
# growthbook and telemetry first; base-url, all-disable and --version second);
# they are merged here. The first Codex round used a closed loopback port,
# never finished a turn, and is superseded by the one below.
source "${HNE:-$HOME/hn-egress}/env.sh"
P="$HNE/probes2"; rm -rf "$P"; mkdir -p "$P"
ST=(strace -f --seccomp-bpf -qq -ttt -s 512 -e signal=none -e trace=connect,sendto,sendmsg,sendmmsg,recvfrom,recvmsg,execve,clone,clone3,fork,vfork)
CL="$HNE/harness/claude-2.1.238/bin/claude"
CX="$HNE/harness/codex-0.148.0/bin/codex"
plugin="$P/plugin"; mkdir -p "$plugin/.claude-plugin"
printf '{"name":"egress-probe","version":"1.0.0","description":"probe"}\n' > "$plugin/.claude-plugin/plugin.json"
python3 -I "$(dirname "$0")/probe-server.py" 18555 & srv=$!
sleep 1

claude_probe() {
  local name="$1"; shift
  local d="$P/claude-$name"; mkdir -p "$d/home"
  ( cd "$d" && env -i PATH="$PATH" HOME="$d/home" TERM=dumb CI=true GITHUB_ACTIONS=true ANTHROPIC_API_KEY= "$@" \
      timeout 60 "${ST[@]}" -o "$d/strace.log" "$CL" plugin validate --strict "$plugin" > "$d/out.txt" 2>&1; echo "exit=$?" >> "$d/out.txt" )
}
claude_probe baseline
claude_probe nonessential CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude_probe growthbook DISABLE_GROWTHBOOK=1
claude_probe telemetry DISABLE_TELEMETRY=1
claude_probe all-disable CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_GROWTHBOOK=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 DISABLE_INSTALLATION_CHECKS=1
claude_probe base-url ANTHROPIC_BASE_URL=http://127.0.0.1:18555
d="$P/claude-version"; mkdir -p "$d/home"
( cd "$d" && env -i PATH="$PATH" HOME="$d/home" TERM=dumb CI=true ANTHROPIC_API_KEY= timeout 60 "${ST[@]}" -o "$d/strace.log" "$CL" --version > "$d/out.txt" 2>&1; echo "exit=$?" >> "$d/out.txt" )

codex_probe() {
  local name="$1"; shift
  local d="$P/codex-$name"; mkdir -p "$d/home/.codex" "$d/work"
  cat > "$d/home/.codex/config.toml" <<'TOML'
model = "egress-probe"
model_provider = "loopback"
[model_providers.loopback]
name = "loopback"
base_url = "http://127.0.0.1:18555/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
TOML
  ( cd "$d/work" && env -i PATH="$PATH" HOME="$d/home" CODEX_HOME="$d/home/.codex" CI=true GITHUB_ACTIONS=true OPENAI_API_KEY= \
      timeout 60 "${ST[@]}" -o "$d/strace.log" "$CX" exec --skip-git-repo-check "$@" "say hi" < /dev/null > "$d/out.txt" 2>&1; echo "exit=$?" >> "$d/out.txt" )
}
codex_probe baseline
codex_probe analytics-off -c analytics.enabled=false
codex_probe plugins-off -c features.plugins=false
codex_probe both-off -c analytics.enabled=false -c features.plugins=false
kill $srv

for d in "$P"/*/; do
  [ -f "$d/strace.log" ] || continue
  python3 -I "$(dirname "$0")/parse_strace.py" "$d/strace.log" > "$d/summary.json"
  python3 -I - "$d/summary.json" "$(basename "$d")" "$(tail -1 "$d/out.txt")" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
names = sorted({q["name"] for q in s["dns_queries"]})
conns = sorted({f'{",".join(d["tls_sni"] or d["hostnames"]) or d["ip"]}:{d["port"]}' for d in s["destinations"] if d["port"] not in (0, 53, 65535)})
print(f'{sys.argv[2]:<22} {sys.argv[3]:<8} dns={names} connects={conns}')
PY
done
