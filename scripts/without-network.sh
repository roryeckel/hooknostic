#!/usr/bin/env bash
# Run a command with no network but loopback, as the invoking user. Linux only.
#
#   scripts/without-network.sh <command> [args...]
#
# Run it as yourself. It re-runs itself as root through `sudo -n /bin/bash`
# to enter a new network namespace and bring loopback up, then drops back to
# your uid/gid with no supplementary groups, no capabilities and no_new_privs.
# There it restores your environment, proves the isolation with
# scripts/assert-no-network.mjs --offline, and runs the command. Inside,
# HOOKNOSTIC_PLAYBACK_NETWORK=none tells the playback helpers they are offline
# (packages/cli/test/harness-playback.ts).
#
# Trust boundary. This is a test harness, not a privilege boundary.
#   - It needs UNRESTRICTED passwordless sudo, as `runner` has on GitHub-hosted
#     runners, or `sudo -v` beforehand.
#   - It runs a file from your checkout as root, so use it only on a runner or
#     on a single-user machine.
#   - Never give it a sudoers rule of its own. Such a rule would turn the
#     script into a root shell for anything running as you. It cannot be
#     invoked through one anyway: it sudo's /bin/bash, not itself.
#
# The root hops never load your environment. Each re-enters through
# `/usr/bin/env -i ... /bin/bash` (no BASH_ENV, no caller PATH, no LD_*) and
# calls ip, setpriv and unshare by absolute path.
#
# Your environment crosses sudo in a file. The hosted runners' sudo ignores
# --preserve-env ("preserving the entire environment is not supported").
#   - The file is created 0600 by mktemp.
#   - Root only checks it is a regular file of yours with mode 0600. It does
#     not read or delete it.
#   - It is read and removed after the drop, as you.
# On the sudo path no environment value appears in argv or output.
#
# HKN_NO_NETWORK_REQUIRE_ENV (comma-separated names) is read before the sudo
# hop and handed on as an argument. The isolation check then fails if any of
# those variables is missing or empty, and the list itself cannot silently
# vanish.
#
# Root without sudo (e.g. `wsl -u root`): name the user explicitly. Here PATH
# and HOME do appear in argv, and the rest of root's own environment becomes
# the user's.
#   scripts/without-network.sh --as UID:GID --path "$PATH" --home "$HOME" -- <command>
#
# A root `unshare --net` needs no unprivileged user namespace, so AppArmor's
# userns restriction does not apply. Isolation is of IP only: a unix socket
# on the host stays reachable through the filesystem. That is why the user
# keeps no supplementary groups (e.g. `docker`, which reaches the Docker
# socket). See docs/testing.md, "Network isolation on Linux".
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
here="$(dirname "$self")"
SYSPATH=/usr/sbin:/usr/bin:/sbin:/bin
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
    uid="$2" envfile="$3" path="$4" home="$5" require="$6"
    shift 6
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || usage
    while IFS= read -r -d '' kv; do export "$kv" 2>/dev/null || true; done < "$envfile"
    rm -f "$envfile"
    [ -n "$path" ] && export PATH="$path"
    [ -n "$home" ] && export HOME="$home"
    export HOOKNOSTIC_PLAYBACK_NETWORK=none HKN_NO_NETWORK_UID="$uid"
    node "$here/assert-no-network.mjs" --offline --require-env "$require"
    exec "$@"
    ;;
  --netns)
    # Root, in the new namespace, from an empty environment: loopback up, then
    # drop to the user with no groups, capabilities or way back.
    uid="$2" gid="$3" envfile="$4" path="$5" home="$6" require="$7"
    shift 7
    [ "${1:-}" = "--" ] && shift
    /usr/sbin/ip link set lo up
    exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --no-new-privs -- \
      /usr/bin/env -i PATH="$SYSPATH" /bin/bash "$self" --inside "$uid" "$envfile" "$path" "$home" "$require" -- "$@"
    ;;
  --as)
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
    [ "$(/usr/bin/id -u)" = 0 ] || die "--as needs root"
    [ -n "$as" ] && [ "$#" -gt 0 ] || usage
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
      [ "$(/usr/bin/stat -c '%u %a' -- "$envfile")" = "$uid 600" ] || die "--env-file is not a 0600 file owned by $uid"
      case "$(/usr/bin/basename -- "$envfile")" in without-network-env.*) ;; *) die "--env-file is not one this script made" ;; esac
    else
      # Root entry: root's own environment, handed to the user in the same kind of file.
      [ -n "$path" ] && [ -n "$home" ] || usage
      envfile="$(umask 077 && /usr/bin/mktemp /tmp/without-network-env.XXXXXX)"
      /usr/bin/env -0 > "$envfile"
      /usr/bin/chown "$uid:$gid" -- "$envfile"
    fi
    exec /usr/bin/unshare --net -- /usr/bin/env -i PATH="$SYSPATH" \
      /bin/bash "$self" --netns "$uid" "$gid" "$envfile" "$path" "$home" "$require" -- "$@"
    ;;
  "" | -*)
    usage
    ;;
  *)
    [ "$(id -u)" != 0 ] || die "as root, pass --as UID:GID --path PATH --home HOME"
    envfile="$(umask 077 && mktemp "${TMPDIR:-/tmp}/without-network-env.XXXXXX")"
    trap 'rm -f "$envfile"' EXIT
    env -0 > "$envfile"
    status=0
    sudo -n -- /bin/bash "$self" --as "$(id -u):$(id -g)" --env-file "$envfile" \
      --require-env "${HKN_NO_NETWORK_REQUIRE_ENV:-}" -- "$@" || status=$?
    exit "$status"
    ;;
esac
