#!/usr/bin/env bash
# Does GITHUB_WORKSPACE change how Copilot starts project stdio MCP servers?
#
# usage, in a disposable Linux container with copilot on PATH:
#   bash .capture/copilot/workspace-probe.sh
#
# Two projects each declare stdio servers that log their launch; the session
# starts in project A with GITHUB_WORKSPACE unset, set to A, set to B, and set
# to a missing directory. The model endpoint is unreachable on purpose: stdio
# servers spawn at startup, so no model call is needed.
set -uo pipefail
root=/tmp/ws-probe
rm -rf "$root"
for name in a b; do
  dir="$root/$name"
  mkdir -p "$dir/.github" "$dir/home" "$dir/sub"
  cat > "$dir/server.mjs" <<'EOF'
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify({ server: process.argv[3], cwd: process.cwd() }) + "\n");
setTimeout(() => process.exit(0), 20000);
EOF
  cat > "$dir/.github/mcp.json" <<EOF
{ "mcpServers": {
  "probe$name": { "type": "stdio", "command": "node", "args": ["$dir/server.mjs", "$root/launch.jsonl", "$name"] },
  "reldot$name": { "type": "stdio", "command": "node", "args": ["./server.mjs", "$root/launch.jsonl", "reldot-$name"], "cwd": "." },
  "relsub$name": { "type": "stdio", "command": "node", "args": ["../server.mjs", "$root/launch.jsonl", "relsub-$name"], "cwd": "sub" },
  "relargs$name": { "type": "stdio", "command": "node", "args": ["./server.mjs", "$root/launch.jsonl", "relargs-$name"] }
} }
EOF
  (cd "$dir" && git init -q && git add -A && git -c user.email=c@e.invalid -c user.name=c commit -qm probe)
done
run() {
  label="$1"; shift
  : > "$root/launch.jsonl"
  (cd "$root/a" && env "$@" COPILOT_HOME="$root/a/home-$label" COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:9/v1 \
    COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_API_KEY=x COPILOT_MODEL=probe \
    timeout 60 copilot --trust-folder --allow-all-tools --disable-client-telemetry --no-auto-update -p "Reply OK." >/dev/null 2>&1)
  sleep 2
  echo "$label: $(tr '\n' ' ' < "$root/launch.jsonl")"
}
run unset GITHUB_WORKSPACE_UNUSED=1
run workspace-a GITHUB_WORKSPACE="$root/a"
run workspace-b GITHUB_WORKSPACE="$root/b"
run workspace-missing GITHUB_WORKSPACE="$root/missing"
copilot --version
