#!/usr/bin/env bash
# Run a command with no IP network but loopback, as the invoking user. Linux only.
#
#   scripts/without-network.sh <command> [args...]
#
# Run it as yourself. It re-runs itself as root through `sudo -n /bin/bash`,
# enters a new network namespace and brings loopback up. It then drops back to
# your uid/gid with no supplementary groups, no capabilities and
# no_new_privs, restores your environment, proves the isolation with
# scripts/assert-no-network.mjs --offline, and runs the command. Inside,
# HOOKNOSTIC_PLAYBACK_NETWORK=none tells the playback helpers they are offline
# (packages/cli/test/harness-playback.ts).
#
# Trust boundary: this is a test harness, not a privilege boundary.
#   - It needs UNRESTRICTED passwordless sudo, as `runner` has on
#     GitHub-hosted runners, or `sudo -v` beforehand.
#   - It runs this file, from your checkout, as root. Use it only on a runner
#     or on a single-user machine.
#   - Never give it a sudoers rule of its own. A rule can name it (e.g.
#     `NOPASSWD: /bin/bash /path/to/without-network.sh *`), but the script is
#     a file you can edit, so that rule is a root shell for anything running
#     as you.
#
# Environment handling:
#   - The sudo entry runs /bin/bash under sudo's env_reset. With the default
#     policy that means no caller PATH, BASH_ENV or LD_*, and sudo's SUDO_UID
#     and SUDO_GID. No external command runs before PATH is pinned to the
#     system directories.
#   - Every later hop starts from `env -i PATH=<system>`, and finds ip,
#     setpriv and unshare only there.
#   - Your environment crosses sudo in a file, because the hosted runners'
#     sudo ignores --preserve-env ("preserving the entire environment is not
#     supported"). The file is created 0600 by mktemp. Root only checks it: a
#     regular file of yours, mode 0600, named by this script. Root never reads
#     or removes it.
#   - The file is read and removed after the drop, as you. The script's own
#     variables are named _hkn_* and readonly, and the file's _hkn_* names
#     are skipped, so no name in it can replace the script's own. Bash's own
#     readonly names are skipped too, and POSIXLY_CORRECT is applied last,
#     so no name in it can end the load.
#   - On the sudo path no environment value appears in argv or output.
#
# HKN_NO_NETWORK_REQUIRE_ENV (comma-separated names) is required: name the
# variables the command needs. It is read before the sudo hop and handed on
# as an argument. The isolation check then fails if any of those variables is
# missing or empty, and the list itself cannot silently vanish. An empty list
# is refused, because it would check nothing.
#
# The checks on --as and --env-file run before the root check, so a normal
# user can test them (scripts/without-network.test.mjs).
#
# Root without sudo (e.g. `wsl -u root`): name the user explicitly. Here PATH
# and HOME do appear in argv, and the rest of root's own environment becomes
# the user's:
#   scripts/without-network.sh --as UID:GID --path "$PATH" --home "$HOME" -- <command>
#
# A root `unshare --net` needs no unprivileged user namespace, so AppArmor's
# userns restriction does not apply. Isolation is of the IP network only: a
# unix socket on the host stays reachable through the filesystem. That is why
# the user keeps no supplementary groups (e.g. `docker`). See docs/testing.md,
# "Network isolation on Linux".
set -euo pipefail
# Builtins only until PATH is pinned: this may already be root.
_hkn_src="${BASH_SOURCE[0]}"
case "$_hkn_src" in */*) _hkn_dir="${_hkn_src%/*}" ;; *) _hkn_dir=. ;; esac
_hkn_here="$(CDPATH='' cd -P -- "$_hkn_dir" && pwd)"
readonly _hkn_here
readonly _hkn_self="$_hkn_here/${_hkn_src##*/}"
readonly _hkn_syspath=/usr/sbin:/usr/bin:/sbin:/bin
usage() {
  echo "usage: $0 <command> [args...]   (as root: $0 --as UID:GID --path PATH --home HOME -- <command> [args...])" >&2
  exit 2
}
die() {
  echo "without-network: $*" >&2
  exit 2
}

case "${1:-}" in
  --inside)
    # Last hop: in the namespace, as the user, from an empty environment.
    # Restore the caller's environment, prove the isolation, run the command.
    readonly _hkn_uid="$2" _hkn_envfile="$3" _hkn_path="$4" _hkn_home="$5" _hkn_require="$6"
    shift 6
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || usage
    # This script's own names (_hkn_*) are skipped, so no caller variable can
    # replace the required list or the canary's path; they are readonly too.
    # The note names the variable, never its value.
    # A refused readonly assignment ends a bash run silently: always under
    # `set -e`, and in any mode once POSIXLY_CORRECT has switched bash to
    # POSIX mode. So:
    #   - the names bash itself keeps readonly are skipped (a child process
    #     gets its own);
    #   - POSIXLY_CORRECT is exported only after the loop;
    #   - `set -e` is off for the load, as a backstop.
    set +e
    _hkn_posix=""
    while IFS= read -r -d '' _hkn_kv; do
      case "$_hkn_kv" in
        _hkn_*) echo "without-network: ignoring the caller's ${_hkn_kv%%=*}, a name this script reserves" >&2 ;;
        BASHOPTS=* | BASH_VERSINFO=* | EUID=* | PPID=* | SHELLOPTS=* | UID=*) ;;
        POSIXLY_CORRECT=*) _hkn_posix="$_hkn_kv" ;;
        *) export "$_hkn_kv" 2>/dev/null ;;
      esac
    done < "$_hkn_envfile"
    set -e
    [ -n "$_hkn_posix" ] && export "$_hkn_posix"
    rm -f -- "$_hkn_envfile"
    [ -n "$_hkn_path" ] && export PATH="$_hkn_path"
    [ -n "$_hkn_home" ] && export HOME="$_hkn_home"
    export HOOKNOSTIC_PLAYBACK_NETWORK=none HKN_NO_NETWORK_UID="$_hkn_uid"
    node "$_hkn_here/assert-no-network.mjs" --offline --require-env "$_hkn_require"
    exec "$@"
    ;;
  --netns)
    # Root, in the new namespace, from an empty environment: loopback up, then
    # drop to the user with no groups, capabilities or way back.
    PATH="$_hkn_syspath"
    uid="$2" gid="$3" envfile="$4" owner="$5" path="$6" home="$7" require="$8"
    shift 8
    [ "${1:-}" = "--" ] && shift
    # Only a file root made (root entry); a successful exec drops the trap.
    [ "$owner" = root ] && trap 'rm -f -- "$envfile"' EXIT
    ip link set lo up
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --no-new-privs -- \
      env -i PATH="$_hkn_syspath" bash "$_hkn_self" --inside "$uid" "$envfile" "$path" "$home" "$require" -- "$@"
    ;;
  --as)
    # Pin PATH before any external command: under sudo this is already root.
    PATH="$_hkn_syspath"
    as="" path="" home="" envfile="" require="${HKN_NO_NETWORK_REQUIRE_ENV:-}"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --as) as="$2"; shift 2 ;;
        --path) path="$2"; shift 2 ;;
        --home) home="$2"; shift 2 ;;
        --env-file) envfile="$2"; shift 2 ;;
        --require-env) require="$2"; shift 2 ;;
        --) shift; break ;;
        *) usage ;;
      esac
    done
    [ -n "$as" ] && [ "$#" -gt 0 ] || usage
    [ -n "$require" ] || die "no required variables: set HKN_NO_NETWORK_REQUIRE_ENV or pass --require-env (an empty list checks nothing)"
    uid="${as%%:*}" gid="${as#*:}"
    [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || die "--as takes numeric UID:GID"
    [ "$uid" != 0 ] || die "refusing to run the command as root"
    # Through sudo, run only as the user who invoked sudo.
    if [ -n "${SUDO_UID:-}" ]; then
      [ "$uid" = "$SUDO_UID" ] && [ "$gid" = "${SUDO_GID:-}" ] || die "--as $as is not the invoking user"
    fi
    if [ -n "$envfile" ]; then
      # The caller's file, as mktemp made it. Root checks it but never reads or removes it.
      [ ! -L "$envfile" ] && [ -f "$envfile" ] || die "--env-file is not a regular file"
      [ "$(stat -c '%u %a' -- "$envfile")" = "$uid 600" ] || die "--env-file is not a 0600 file owned by $uid"
      case "${envfile##*/}" in without-network-env.*) ;; *) die "--env-file is not one this script made" ;; esac
    fi
    # Everything above can be checked as a normal user; everything below is root's.
    [ "$(id -u)" = 0 ] || die "--as needs root"
    owner=caller
    if [ -z "$envfile" ]; then
      # Root entry: root's own environment, handed to the user in the same kind
      # of file. Root made it, so root removes it if a root hop fails: this
      # trap until `unshare` starts, the --netns one until `setpriv` starts.
      # The sudo caller's file is never root's to remove; their own trap does.
      [ -n "$path" ] && [ -n "$home" ] || usage
      envfile="$(umask 077 && mktemp /tmp/without-network-env.XXXXXX)"
      owner=root
      trap 'rm -f -- "$envfile"' EXIT
      env -0 > "$envfile"
      chown "$uid:$gid" -- "$envfile"
    fi
    exec unshare -- env -i PATH="$_hkn_syspath" \
      bash "$_hkn_self" --netns "$uid" "$gid" "$envfile" "$owner" "$path" "$home" "$require" -- "$@"
    ;;
  "" | -*)
    usage
    ;;
  *)
    [ "$(id -u)" != 0 ] || die "as root, pass --as UID:GID --path PATH --home HOME"
    [ -n "${HKN_NO_NETWORK_REQUIRE_ENV:-}" ] || die "no required variables: set HKN_NO_NETWORK_REQUIRE_ENV (an empty list checks nothing)"
    envfile="$(umask 077 && mktemp "${TMPDIR:-/tmp}/without-network-env.XXXXXX")"
    trap 'rm -f -- "$envfile"' EXIT
    env -0 > "$envfile"
    status=0
    # /bin/bash by path, not `bash`: sudo resolves a bare name by its own
    # policy (secure_path or not), and this is the one hop that runs before
    # PATH is pinned.
    sudo -n -- /bin/bash "$_hkn_self" --as "$(id -u):$(id -g)" --env-file "$envfile" \
      --require-env "${HKN_NO_NETWORK_REQUIRE_ENV:-}" -- "$@" || status=$?
    exit "$status"
    ;;
esac
