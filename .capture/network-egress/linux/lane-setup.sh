#!/usr/bin/env bash
# Prototype of the Linux dedicated lane user, for measurement on a throwaway
# GitHub-hosted ubuntu runner only: it needs root (passwordless sudo) and
# creates a system user. It is not the implementation; it measures what the
# plan's Linux lane-user section relies on.
#   sudo -n bash lane-setup.sh <workspace> <runner temp> <runner home> <caller PATH> [--grant-traverse]
# In order:
# - stages the root-side scripts in /var/lib/hkn-admin (root only, 0700);
# - creates the system user hknlane: its own group, no others, no login shell;
# - creates the lane scratch tree /var/tmp/hkn-lane, owned by the invoking
#   user for now, so the prepare step can fill it; lane-run hands it over;
# - prints the ownership and modes that decide what the lane can reach;
# - checks the lane can reach what the tests need (the workspace, node, the
#   installed harness, pnpm). With --grant-traverse it grants the missing
#   execute-only (traverse) bits through an ACL for that user alone.
# Paths are printed with %GITHUB_WORKSPACE%, %RUNNER_TEMP% and ~runner in
# place of their values.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ws="${1:?workspace}" rt="${2:?runner temp}" rhome="${3:?runner home}" cpath="${4:?caller PATH}"
grant="${5:-}"
[ "$(id -u)" = 0 ] || { echo "lane-setup: needs root" >&2; exit 2; }
caller="${SUDO_UID:?run through sudo}" callergid="${SUDO_GID:?run through sudo}"
here="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
admin=/var/lib/hkn-admin scratch=/var/tmp/hkn-lane
t0=$(date +%s%N)
mark() { echo "lane-setup: $(( ($(date +%s%N) - t0) / 1000000 )) ms $*"; }
redact() { sed -e "s#$ws#%GITHUB_WORKSPACE%#g" -e "s#$rt#%RUNNER_TEMP%#g" -e "s#$rhome#~runner#g"; }

install -d -m 0700 -o root -g root "$admin"
install -m 0700 -o root -g root "$here/lane-run.sh" "$here/lane-after.sh" "$admin/"
mark "staged root scripts: $(stat -c '%A %U:%G' "$admin")"

useradd --system --user-group --no-create-home --home-dir "$scratch/home" --shell /usr/sbin/nologin hknlane
uid="$(id -u hknlane)" gid="$(id -g hknlane)"
mark "user hknlane uid $uid gid $gid; groups: $(id -Gn hknlane)"

install -d -m 0755 -o "$caller" -g "$callergid" "$scratch"
for d in home tmp work npm-cache bin; do install -d -m 0755 -o "$caller" -g "$callergid" "$scratch/$d"; done
install -m 0644 -o "$caller" -g "$callergid" "$here/lane-probe.mjs" "$scratch/bin/"
worker="$(pgrep -x Runner.Worker | head -n 1 || true)"
runner_bin="$( [ -n "$worker" ] && dirname "$(readlink -f "/proc/$worker/exe")" || true)"
node_bin="$(PATH="$cpath" command -v node || true)"
printf '%s\n' "uid=$uid" "gid=$gid" "caller=$caller" "callergid=$callergid" "scratch=$scratch" "ws=$ws" "rt=$rt" "rhome=$rhome" "runner_bin=$runner_bin" > "$admin/state"
chmod 0600 "$admin/state"
mark "scratch tree $(stat -c '%A %U' "$scratch") (owned by the caller until lane-run)"

echo "== ownership and modes"
for p in /home "$rhome" "$rhome/work" "$ws" "$ws/node_modules" "$ws/.git" "$rt" "$rt/_runner_file_commands" "$(dirname "$(dirname "$ws")")/_actions" \
  /opt/hostedtoolcache /var/run/docker.sock "$runner_bin" "$(dirname "$runner_bin" 2>/dev/null)" "$rhome/.gitconfig" "$rhome/.npmrc" "$rhome/.bashrc"; do
  if [ -n "$p" ] && [ -e "$p" ]; then stat -c '   %A %U:%G %n' "$p" | redact; fi
done
echo "   file-command files: $(find "$rt/_runner_file_commands" -maxdepth 1 -type f -printf '%m %u\n' 2>/dev/null | sort | uniq -c | tr -s ' ' | paste -sd ';')"
echo "   checkout credentials files: $(find "$rt" -maxdepth 1 -name 'git-credentials-*' -printf '%m %u\n' 2>/dev/null | sort | uniq -c | tr -s ' ' | paste -sd ';')"
echo "   runner credentials: $(find "$(dirname "$runner_bin" 2>/dev/null)" "$(dirname "$(dirname "$runner_bin" 2>/dev/null)" 2>/dev/null)" -maxdepth 1 -name '.credentials*' -printf '%m %u %f\n' 2>/dev/null | sort -u | paste -sd ';')"
echo "   workspace file modes: $(find "$ws" -path "$ws/node_modules" -prune -o -path "$ws/.git" -prune -o -type f -printf '%m\n' | sort | uniq -c | tr -s ' ' | paste -sd ';')"

echo "== what the lane can reach"
needs=("$ws/package.json" "$ws/node_modules/vitest/vitest.mjs" "$node_bin")
for tool in pnpm claude codex copilot opencode pi; do
  found="$(PATH="$cpath" command -v "$tool" || true)"
  if [ -n "$found" ]; then needs+=("$found" "$(readlink -f "$found")"); fi
done
for p in "${needs[@]}"; do
  [ -n "$p" ] || continue
  if setpriv --reuid="$uid" --regid="$gid" --clear-groups -- test -r "$p"; then
    echo "   readable: $(echo "$p" | redact)"
  else
    blocked=""
    q="$p"
    while [ "$q" != / ]; do
      q="$(dirname "$q")"
      setpriv --reuid="$uid" --regid="$gid" --clear-groups -- test -x "$q" || blocked="$q"
    done
    echo "   NOT readable: $(echo "$p" | redact); outermost untraversable ancestor: $(echo "${blocked:-none}" | redact)"
    if [ "$grant" = --grant-traverse ] && [ -n "$blocked" ]; then
      q="$p"
      while [ "$q" != / ]; do
        q="$(dirname "$q")"
        setpriv --reuid="$uid" --regid="$gid" --clear-groups -- test -x "$q" || { setfacl -m "u:hknlane:x" "$q"; echo "   granted traverse (ACL u:hknlane:x): $(echo "$q" | redact)"; }
      done
    fi
  fi
done
mark done
