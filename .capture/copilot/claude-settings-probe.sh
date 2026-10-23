#!/usr/bin/env bash
# Does Copilot run Claude Code's project hooks, and in what form?
#
# usage, in a disposable Linux container with copilot on PATH:
#   bash .capture/copilot/claude-settings-probe.sh
#
# Each case is a scratch git project holding only a Claude settings file with a
# SessionStart hook; the hook appends its label to a log when Copilot runs it.
# sessionStart fires before any model call, so the model endpoint is
# unreachable on purpose. A case that leaves no line was not run.
set -uo pipefail
root=/tmp/claude-settings-probe
rm -rf "$root"
mkdir -p "$root"
log="$root/ran.log"
cat > "$root/mark.mjs" <<'EOF'
import { appendFileSync, readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
appendFileSync(process.argv[2], JSON.stringify({ label: process.argv[3], input: input.slice(0, 300) }) + "\n");
EOF

case_project() {
  name="$1" file="$2" body="$3"
  dir="$root/$name"
  mkdir -p "$dir/$(dirname "$file")" "$dir/home"
  printf '%s\n' "$body" > "$dir/$file"
  (cd "$dir" && git init -q && git add -A && git -c user.email=c@e.invalid -c user.name=c commit -qm probe)
  (cd "$dir" && COPILOT_HOME="$dir/home" COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:9/v1 \
    COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_API_KEY=x COPILOT_MODEL=probe \
    timeout 60 copilot --trust-folder --allow-all-tools --disable-client-telemetry --no-auto-update \
    -p "Reply OK." >/dev/null 2>&1)
  sleep 1
  ran=$(grep -c "\"label\":\"$name\"" "$log" 2>/dev/null || true)
  errors=$(grep -h 'rust:hooks' "$dir"/home/logs/* 2>/dev/null | grep -E 'ERROR|WARN' | sed 's/^[^]]*\] //' | head -n 3 | tr '\n' ' ')
  echo "$name: ran=${ran:-0} ${errors}"
}

shell_hook() { printf '{"type":"command","command":"node %s %s %s"}' "$root/mark.mjs" "$log" "$1"; }
exec_hook() { printf '{"type":"command","command":"node","args":["%s","%s","%s"]}' "$root/mark.mjs" "$log" "$1"; }

case_project settings-shell .claude/settings.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(shell_hook settings-shell)]}]}}"
case_project settings-local-shell .claude/settings.local.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(shell_hook settings-local-shell)]}]}}"
# Hooknostic's generated Claude form: command "node" with the script in args.
case_project settings-args .claude/settings.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(exec_hook settings-args)]}]}}"
# Fields Copilot's strict settings validator rejects, beside the generated form:
# if the whole hooks field is rejected, nothing runs and nothing fails closed.
exec_plus() { printf '{"type":"command","command":"node","args":["%s","%s","%s"],%s}' "$root/mark.mjs" "$log" "$1" "$2"; }
case_project settings-args-exec .claude/settings.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(exec_plus settings-args-exec '"exec":"node"')]}]}}"
case_project settings-args-timeoutsec .claude/settings.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(exec_plus settings-args-timeoutsec '"timeoutSec":"claude"')]}]}}"
# The rejection must cover sibling entries and events in the same file.
case_project settings-reject-siblings .claude/settings.json "{\"hooks\":{\"SessionStart\":[{\"hooks\":[$(exec_plus reject-a '"exec":"node"'),$(shell_hook settings-reject-siblings)]}],\"UserPromptSubmit\":[{\"hooks\":[$(shell_hook settings-reject-siblings)]}]}}"
copilot --version | head -n 1
