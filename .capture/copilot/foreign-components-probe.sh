#!/usr/bin/env bash
# Does Copilot load Claude Code's project skills and MCP servers, and what
# happens when the same name exists in Copilot's own location too?
#
# usage, in a disposable Linux container with copilot on PATH:
#   bash .capture/copilot/foreign-components-probe.sh
#
# Every case is a scratch git project. `copilot skill list` and `copilot mcp
# list`/`get` report what Copilot discovered without a model or a session.
set -uo pipefail
root=/tmp/foreign-components-probe
rm -rf "$root"
mkdir -p "$root"

project() {
  dir="$root/$1"
  mkdir -p "$dir/home"
  (cd "$dir" && git init -q)
  echo "$dir"
}
skill() { # dir name description
  mkdir -p "$1/$2"
  printf -- '---\nname: %s\ndescription: %s\n---\n\nBody from %s.\n' "$(basename "$2")" "$3" "$3" > "$1/$2/SKILL.md"
}
run() { # dir args...
  dir="$1"; shift
  (cd "$dir" && COPILOT_HOME="$dir/home" timeout 60 copilot "$@" 2>&1)
}

echo "### skills: .claude/skills only"
d=$(project skills-claude-only)
skill "$d/.claude/skills" demo claude-copy
run "$d" skill list | grep -i -E 'demo|claude|project' | head -n 10

echo "### skills: same name in .claude/skills and .agents/skills"
d=$(project skills-same-name)
skill "$d/.claude/skills" demo claude-copy
skill "$d/.agents/skills" demo agents-copy
run "$d" skill list | grep -i -E 'demo|claude|agents|copy' | head -n 10

echo "### skills: distinct names"
d=$(project skills-distinct)
skill "$d/.claude/skills" claude-only claude-copy
skill "$d/.agents/skills" agents-only agents-copy
run "$d" skill list | grep -i -E 'only|copy' | head -n 10

# `copilot mcp list` does not report workspace servers outside a trusted
# session, so these cases start one: each stdio server appends its label to a
# log when Copilot launches it, before any model request (the endpoint is
# unreachable on purpose).
log="$root/launched.log"
cat > "$root/server.mjs" <<'EOF'
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], process.argv[3] + "\n");
setTimeout(() => process.exit(0), 15000);
EOF
server() { printf '"%s":{"type":"stdio","command":"node","args":["%s","%s","%s"]}' "$1" "$root/server.mjs" "$log" "$2"; }
session() { # dir case-label
  : > "$log"
  (cd "$1" && COPILOT_HOME="$1/home" COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:9/v1 COPILOT_PROVIDER_TYPE=openai \
    COPILOT_PROVIDER_API_KEY=x COPILOT_MODEL=probe timeout 60 copilot --trust-folder --allow-all-tools \
    --disable-client-telemetry --no-auto-update -p "Reply OK." >/dev/null 2>&1)
  sleep 2
  echo "$2: launched=[$(sort "$log" | tr '\n' ' ')]"
}

d=$(project mcp-root-only)
printf '{"mcpServers":{%s}}' "$(server shared root-copy)" > "$d/.mcp.json"
session "$d" "mcp root .mcp.json only"

d=$(project mcp-same-name)
mkdir -p "$d/.github"
printf '{"mcpServers":{%s}}' "$(server shared root-copy)" > "$d/.mcp.json"
printf '{"mcpServers":{%s}}' "$(server shared github-copy)" > "$d/.github/mcp.json"
session "$d" "mcp same name in both"

d=$(project mcp-distinct)
mkdir -p "$d/.github"
printf '{"mcpServers":{%s}}' "$(server root-only root-copy)" > "$d/.mcp.json"
printf '{"mcpServers":{%s}}' "$(server github-only github-copy)" > "$d/.github/mcp.json"
session "$d" "mcp distinct names"

# Controls and fallbacks: .github/mcp.json alone, and beside a root .mcp.json
# that is empty, unparseable, or holds an entry Copilot rejects.
d=$(project mcp-github-only)
mkdir -p "$d/.github"
printf '{"mcpServers":{%s}}' "$(server github-only github-copy)" > "$d/.github/mcp.json"
session "$d" "mcp .github/mcp.json only"

for variant in empty unparseable rejected-entry; do
  d=$(project "mcp-root-$variant")
  mkdir -p "$d/.github"
  case "$variant" in
    empty) printf '{"mcpServers":{}}' > "$d/.mcp.json" ;;
    unparseable) printf '{"mcpServers":' > "$d/.mcp.json" ;;
    rejected-entry) printf '{"mcpServers":{"bad":{"type":"bogus"},%s}}' "$(server root-sibling root-copy)" > "$d/.mcp.json" ;;
  esac
  printf '{"mcpServers":{%s}}' "$(server github-only github-copy)" > "$d/.github/mcp.json"
  session "$d" "mcp root $variant beside .github"
done

# A root .mcp.json shared with Claude, fenced both ways: Claude's
# disabledMcpjsonServers (.claude/settings.json, which Copilot also reads) and
# Copilot's disabledMcpServers (.github/copilot/settings.json). The session runs
# with GITHUB_WORKSPACE elsewhere, as on a runner, so the cwd "." entry shows
# whether a composed entry still starts in the project.
d=$(project mcp-shared-fenced)
mkdir -p "$d/.claude" "$d/.github/copilot"
cat > "$root/cwd-server.mjs" <<'EOF'
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], process.argv[3] + "@" + process.cwd() + "\n");
setTimeout(() => process.exit(0), 15000);
EOF
cwd_server() { printf '"%s":{"command":"node","args":["%s","%s","%s"]%s}' "$1" "$root/cwd-server.mjs" "$log" "$1" "$2"; }
printf '{"mcpServers":{%s,%s,%s,%s}}' "$(cwd_server plain '')" "$(cwd_server claude-fenced '')" \
  "$(cwd_server copilot-fenced '')" "$(cwd_server with-cwd-dot ',"cwd":"."')" > "$d/.mcp.json"
printf '{"enableAllProjectMcpServers":true,"disabledMcpjsonServers":["claude-fenced"]}' > "$d/.claude/settings.json"
printf '{"disabledMcpServers":["copilot-fenced"]}' > "$d/.github/copilot/settings.json"
mkdir -p "$root/elsewhere"
: > "$log"
(cd "$d" && GITHUB_WORKSPACE="$root/elsewhere" COPILOT_HOME="$d/home" COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:9/v1 \
  COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_API_KEY=x COPILOT_MODEL=probe timeout 60 copilot --trust-folder \
  --allow-all-tools --disable-client-telemetry --no-auto-update -p "Reply OK." >/dev/null 2>&1)
sleep 2
echo "mcp shared and fenced: launched=[$(sort -u "$log" | sed "s#$root#<root>#g" | tr '\n' ' ')]"

copilot --version | head -n 1
