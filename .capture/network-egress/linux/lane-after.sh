#!/usr/bin/env bash
# After a Linux lane run (prototype; see lane-setup.sh). Root runs the staged
# copy, in an always() step:
#   sudo -n /bin/bash /var/lib/hkn-admin/lane-after.sh --label L
# 1. Stops every process of the lane user (pkill -KILL -u), and fails unless
#    none is left.
# 2. Fails if anything later steps trust changed since lane-run's stamp:
#    - a find -cnewer over the runner's home (the workspace, RUNNER_TEMP with
#      the file-command files, _actions, the runner itself, the dotfiles) and
#      /opt/hostedtoolcache. ctime cannot be set back by the writer, so a
#      change cannot hide;
#    - the SHA-256 sums lane-run recorded.
#    Paths the runner itself writes while a step runs (its _diag logs) are
#    reported apart, and so are the trial-only node_modules entries.
# Deletes nothing.
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
admin="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$admin/state"
label=""
[ "${1:-}" = --label ] && label="${2:-}"
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "lane-after: --label L" >&2; exit 2; }
problems=()
redact() { sed -e "s#$ws#%GITHUB_WORKSPACE%#g" -e "s#$rt#%RUNNER_TEMP%#g" -e "s#$rhome#~runner#g"; }

alive="$(pgrep -u hknlane -c || true)"
echo "lane-after $label: lane processes alive: $alive $(pgrep -u hknlane -l 2>/dev/null | awk '{print $2}' | sort | uniq -c | tr -s ' ' | paste -sd, -)"
pkill -KILL -u hknlane 2>/dev/null || true
sleep 1
left="$(pgrep -u hknlane -c || true)"
echo "lane-after $label: lane processes after stopping: $left"
[ "${left:-0}" = 0 ] || problems+=("$left lane processes survive")

if [ ! -f "$admin/stamp.$label" ]; then
  problems+=("no stamp: lane-run did not reach its snapshot")
else
  t0=$(date +%s%N)
  runner_root="$(dirname "$(dirname "$runner_bin")")"
  changed="$(find "$rhome" /opt/hostedtoolcache -xdev -path "$scratch" -prune -o -cnewer "$admin/stamp.$label" -print 2>/dev/null)"
  secs=$(( ($(date +%s%N) - t0) / 1000000 ))
  noise="$(printf '%s\n' "$changed" | grep -E "^($runner_root|$(dirname "$runner_root"))/(.*/)?_diag(/|$)" || true)"
  trial="$(printf '%s\n' "$changed" | grep -E "^$ws/node_modules(/\.hooknostic-ripgrep-test-[^/]*(/.*)?)?$" || true)"
  real="$(printf '%s\n' "$changed" | grep . | grep -v -x -F -f <(printf '%s\n' "$noise" "$trial" | grep .) || true)"
  echo "lane-after $label: changed since the stamp (find -cnewer, $secs ms): $(printf '%s\n' "$changed" | grep -c .) paths; runner _diag $(printf '%s\n' "$noise" | grep -c .); trial-only node_modules $(printf '%s\n' "$trial" | grep -c .); OTHER $(printf '%s\n' "$real" | grep -c .)"
  printf '%s\n' "$real" | grep . | head -n 20 | redact | sed 's/^/   CHANGED /'
  [ -z "$(printf '%s\n' "$real" | grep .)" ] || problems+=("trusted paths changed")
  after="$(
    {
      find "$rt/_runner_file_commands" -maxdepth 1 -type f -print0 2>/dev/null
      for f in .gitconfig .bashrc .profile .npmrc .bash_profile; do [ -f "$rhome/$f" ] && printf '%s\0' "$rhome/$f"; done
      printf '%s\0' "$ws/.git/config" "$admin/lane-run.sh" "$admin/lane-after.sh" "$admin/state"
      find "$ws/scripts" -maxdepth 1 -type f -print0
    } | sort -z | xargs -0 sha256sum
  )"
  if [ "$after" = "$(cat "$admin/before.$label")" ]; then
    echo "lane-after $label: $(wc -l < "$admin/before.$label") trusted files hash the same"
  else
    echo "lane-after $label: TRUSTED FILES DIFFER:"
    diff <(cat "$admin/before.$label") <(printf '%s\n' "$after") | redact | head -n 20
    problems+=("trusted file hashes differ")
  fi
fi
if [ "${#problems[@]}" -gt 0 ]; then echo "lane-after $label: PROBLEMS: ${problems[*]}"; exit 1; fi
echo "lane-after $label: clean"
