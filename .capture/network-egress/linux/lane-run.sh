#!/usr/bin/env bash
# Run one command as the lane user, in a new network namespace (prototype;
# see lane-setup.sh). Root runs only the staged copy:
#   sudo -n /bin/bash /var/lib/hkn-admin/lane-run.sh --env-file F --label L [--require A,B] [--node-modules-grant] -- <command...>
# - F is the caller's environment (env -0, a 0600 file of the caller's).
#   Only allowlisted names pass: PATH, LANG, LC_*, TERM, CI, GITHUB_ACTIONS,
#   RUNNER_OS/ARCH/ENVIRONMENT/TRACKING_ID, HOOKNOSTIC_*, HKN_*. HOME, TMPDIR,
#   USER, LOGNAME, SHELL and npm's cache point into the scratch tree. The
#   dropped names that look sensitive are listed (names only).
# - HKN_RIPGREP_DIR is copied into the scratch tree; HKN_PLAYBACK_ARTIFACT_DIR
#   moves there. The scratch tree is then handed to the lane user.
# - Before the lane runs it records a ctime stamp and SHA-256 sums of the
#   file-command files, ~runner's dotfiles, the workspace's .git/config and
#   scripts, and the staged root scripts. lane-after.sh compares them.
# - The lane runs in new network, mount and PID namespaces (lane-ns.sh):
#   - only loopback;
#   - every mount read-only but the scratch tree;
#   - private /tmp, /var/tmp and /dev/shm;
#   - RUNNER_TEMP and the runner's directory hidden;
#   - the workspace an overlay with its upper layer in the scratch tree.
#   It runs as hknlane: no supplementary groups, no capabilities, no_new_privs,
#   an empty environment. lane-probe.mjs loads its environment, probes, runs
#   the canary, then the command.
# - --node-modules-grant (trial only) lets the lane create entries directly
#   in the workspace's node_modules, where one test makes a temporary directory.
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
admin="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$admin/state"
envfile="" label="" require="" nmgrant="" mutant=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) envfile="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --require) require="$2"; shift 2 ;;
    --node-modules-grant) nmgrant=1; shift ;;
    --mutant-no-readonly) mutant=no-ro; shift ;;
    --) shift; break ;;
    *) echo "lane-run: bad argument" >&2; exit 2 ;;
  esac
done
[ -n "$label" ] && [ "$#" -gt 0 ] || { echo "lane-run: usage" >&2; exit 2; }
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "lane-run: bad label" >&2; exit 2; }
[ ! -L "$envfile" ] && [ -f "$envfile" ] && [ "$(stat -c '%u %a' -- "$envfile")" = "$caller 600" ] ||
  { echo "lane-run: --env-file is not the caller's 0600 regular file" >&2; exit 2; }
t0=$(date +%s%N)
ms() { echo $(( ($(date +%s%N) - t0) / 1000000 )); }

# 1. The allowlisted environment.
allow='^(PATH|LANG|LC_[A-Z]+|TERM|CI|GITHUB_ACTIONS|RUNNER_OS|RUNNER_ARCH|RUNNER_ENVIRONMENT|RUNNER_TRACKING_ID|HOOKNOSTIC_[A-Z0-9_]+|HKN_[A-Z0-9_]+)$'
sensitive='^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)|(TOKEN|SECRET|PASSWORD|_KEY)$'
laneenv="$scratch/bin/lane.env"
: > "$laneenv"
kept=0 dropped=0 dropped_sensitive=() callerpath="" rgdir="" artdir=""
while IFS= read -r -d '' kv; do
  name="${kv%%=*}"
  if [[ "$name" =~ $allow ]]; then
    kept=$((kept + 1))
    case "$name" in
      PATH) callerpath="${kv#*=}" ;;
      HKN_RIPGREP_DIR) rgdir="${kv#*=}"; continue ;;
      HKN_PLAYBACK_ARTIFACT_DIR) artdir="${kv#*=}"; continue ;;
    esac
    printf '%s\0' "$kv" >> "$laneenv"
  else
    dropped=$((dropped + 1))
    [[ "$name" =~ $sensitive ]] && dropped_sensitive+=("$name")
  fi
done < "$envfile"
if [ -n "$rgdir" ]; then
  [ -d "$rgdir" ] && cp -a -- "$rgdir" "$scratch/work/ripgrep" || mkdir -p "$scratch/work/ripgrep"
  printf '%s\0' "HKN_RIPGREP_DIR=$scratch/work/ripgrep" >> "$laneenv"
fi
[ -n "$artdir" ] && printf '%s\0' "HKN_PLAYBACK_ARTIFACT_DIR=$scratch/work/playback-artifacts" >> "$laneenv"
printf '%s\0' "HOME=$scratch/home" "TMPDIR=$scratch/tmp" "USER=hknlane" "LOGNAME=hknlane" "SHELL=/bin/bash" \
  "npm_config_cache=$scratch/npm-cache" "HOOKNOSTIC_PLAYBACK_NETWORK=none" "HKN_NO_NETWORK_UID=$uid" >> "$laneenv"
echo "lane-run $label: step environment $((kept + dropped)) names; passed $kept; dropped $dropped"
echo "lane-run $label: dropped names that look sensitive: $(printf '%s\n' "${dropped_sensitive[@]}" | sort | paste -sd, -)"
node="$(PATH="$callerpath" command -v node)"

# 2. What the lane must not write or read. Labels, not paths, are printed.
work="$(dirname "$(dirname "$ws")")"
targets=()
t() { [ -n "$3" ] && targets+=("$1" "$2" "$3"); }
t dir 'workspace' "$ws"; t dir 'workspace/scripts' "$ws/scripts"; t dir 'workspace/.git' "$ws/.git"
t dir 'workspace/node_modules' "$ws/node_modules"; t dir 'RUNNER_TEMP' "$rt"; t dir 'RUNNER_TEMP/_runner_file_commands' "$rt/_runner_file_commands"
t dir '_actions' "$work/_actions"; t dir 'runner home' "$rhome"; t dir 'hostedtoolcache' /opt/hostedtoolcache
t dir 'node toolcache bin' "$(dirname "$node")"; t dir 'npm global node_modules' "$(dirname "$(dirname "$node")")/lib/node_modules"
pnpm="$(PATH="$callerpath" command -v pnpm || true)"; [ -n "$pnpm" ] && t dir 'pnpm dir' "$(dirname "$(readlink -f "$pnpm")")"
t dir 'runner bin' "$runner_bin"; t dir 'admin staging' "$admin"
for f in "$rt"/_runner_file_commands/*; do [ -f "$f" ] && t write "file-command $(basename "$f" | sed 's/_[0-9a-f-]*$//')" "$f" && t read "file-command $(basename "$f" | sed 's/_[0-9a-f-]*$//')" "$f"; done
for f in "$rt"/git-credentials-*; do [ -f "$f" ] && t read 'checkout credentials file' "$f"; done
for f in "$(dirname "$runner_bin")"/.credentials* "$(dirname "$runner_bin")"/.runner "$(dirname "$(dirname "$runner_bin")")"/.credentials* "$(dirname "$(dirname "$runner_bin")")"/.runner; do
  [ -f "$f" ] && t read "runner $(basename "$f")" "$f"
done
for f in .gitconfig .bashrc .profile .npmrc; do [ -f "$rhome/$f" ] && t write "~runner/$f" "$rhome/$f"; done
t write 'workspace scripts/without-network.sh' "$ws/scripts/without-network.sh"; t write 'workspace .git/config' "$ws/.git/config"
t write 'node binary' "$node"; t read 'admin state' "$admin/state"
{
  printf '{"label":%s,"uid":%s,"gid":%s,"cwd":%s,"node":%s,"require":%s,"command":[' \
    "$(printf '%s' "$label" | jq -Rs .)" "$uid" "$gid" "$(printf '%s' "$ws" | jq -Rs .)" "$(printf '%s' "$node" | jq -Rs .)" \
    "$(printf '%s' "$require" | jq -Rc 'split(",") | map(select(length > 0))')"
  first=1; for a in "$@"; do [ $first = 1 ] || printf ','; first=0; printf '%s' "$a" | jq -Rs .; done
  printf '],"targets":['
  first=1; i=0
  while [ $i -lt ${#targets[@]} ]; do
    [ $first = 1 ] || printf ','; first=0
    jq -nc --arg kind "${targets[$i]}" --arg label "${targets[$((i + 1))]}" --arg path "${targets[$((i + 2))]}" '{kind:$kind,label:$label,path:$path}'
    i=$((i + 3))
  done
  printf ']}'
} > "$scratch/bin/lane.json"

# 3. Hand the scratch tree over. The trial-only node_modules grant is applied
# inside the namespace, to the workspace overlay, never to the real tree.
if [ -n "$nmgrant" ]; then echo "lane-run $label: TRIAL ONLY: the lane may create entries in the overlay's node_modules"; fi
chown -R "$uid:$gid" "$scratch"
chmod 0600 "$laneenv"

# 4. Before-snapshot.
snap() {
  {
    find "$rt/_runner_file_commands" -maxdepth 1 -type f -print0 2>/dev/null
    for f in .gitconfig .bashrc .profile .npmrc .bash_profile; do [ -f "$rhome/$f" ] && printf '%s\0' "$rhome/$f"; done
    printf '%s\0' "$ws/.git/config" "$admin/lane-run.sh" "$admin/lane-after.sh" "$admin/state"
    find "$ws/scripts" -maxdepth 1 -type f -print0
  } | sort -z | xargs -0 sha256sum
}
touch "$admin/stamp.$label"
snap > "$admin/before.$label"
echo "lane-run $label: snapshot of $(wc -l < "$admin/before.$label") trusted files; setup $(ms) ms"

# 5. Run.
start=$(date +%s)
runner_dir="${runner_bin%%/cached/*}"
unshare --net --mount --pid --fork --mount-proc -- env -i /bin/bash "$admin/lane-ns.sh" \
  "$uid" "$gid" "$node" "$scratch" "$ws" "$rt" "$runner_dir" "${nmgrant:+grant}" "$mutant"
code=$?
echo "lane-run $label: exit $code after $(( $(date +%s) - start )) s"
exit "$code"
