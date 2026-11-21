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
label="" where="always() step"
[ "${1:-}" = --label ] && label="${2:-}"
[ "${3:-}" = --in-step ] && where="in the lane step"
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
  runner_root="$(dirname "$(dirname "$runner_bin")")"
  t0=$(date +%s%N)
  changed_home="$(find "$rhome" -xdev -cnewer "$admin/stamp.$label" -print 2>/dev/null)"
  t1=$(date +%s%N)
  changed_tc="$(find /opt/hostedtoolcache -xdev -cnewer "$admin/stamp.$label" -print 2>/dev/null)"
  t2=$(date +%s%N)
  changed="$(printf '%s\n%s\n' "$changed_home" "$changed_tc" | grep . || true)"
  noise="$(printf '%s\n' "$changed" | grep -E "^($runner_root|$(dirname "$runner_root"))/(.*/)?_diag(/|$)" || true)"
  # What the runner writes for the steps after this one: their scripts, their
  # file-command files, the event payload. Only possible across a step boundary.
  churn="$(printf '%s\n' "$changed" | grep -E "^$rt(/[0-9a-f-]{36}\.sh|/_github_workflow(/event\.json)?|/_runner_file_commands(/[a-z_]+_[0-9a-f-]{36})?)?$" || true)"
  real="$(printf '%s\n' "$changed" | grep . | grep -v -x -F -f <(printf '%s\n' "$noise" "$churn" | grep .) || true)"
  echo "lane-after $label ($where): changed since the stamp (find -cnewer: ~runner $(( (t1 - t0) / 1000000 )) ms, toolcache $(( (t2 - t1) / 1000000 )) ms): $(printf '%s\n' "$changed" | grep -c .) paths; runner _diag $(printf '%s\n' "$noise" | grep -c .); runner step churn $(printf '%s\n' "$churn" | grep -c .); OTHER $(printf '%s\n' "$real" | grep -c .)"
  printf '%s\n' "$real" | grep . | head -n 20 | redact | sed 's/^/   CHANGED /'
  [ -z "$(printf '%s\n' "$real" | grep .)" ] || problems+=("trusted paths changed")
  # The recorded files only: file-command files of later steps are new, not changed.
  if (cd / && sha256sum --check --quiet --status "$admin/before.$label"); then
    echo "lane-after $label: $(wc -l < "$admin/before.$label") recorded trusted files hash the same"
  else
    echo "lane-after $label: RECORDED TRUSTED FILES DIFFER: $( (cd / && sha256sum --check --quiet "$admin/before.$label" 2>&1) | redact | head -n 10 | paste -sd ';' -)"
    problems+=("trusted file hashes differ")
  fi
fi
if [ "${#problems[@]}" -gt 0 ]; then echo "lane-after $label: PROBLEMS: ${problems[*]}"; exit 1; fi
echo "lane-after $label: clean"
