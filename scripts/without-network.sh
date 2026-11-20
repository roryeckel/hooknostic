#!/usr/bin/env bash
# Run a command with no network but loopback, as the invoking user. Linux only.
#
#   scripts/without-network.sh <command> [args...]
#
# Run it as yourself: it re-runs itself under passwordless `sudo -n` (as on
# GitHub-hosted runners) to enter a new network namespace, brings loopback up,
# drops back to your uid/gid with no capabilities and no_new_privs, proves the
# isolation with scripts/assert-no-network.mjs --offline, then runs the command.
# Inside, HOOKNOSTIC_PLAYBACK_NETWORK=none tells the playback helpers they are
# offline (packages/cli/test/harness-playback.ts).
#
# Root without sudo (e.g. `wsl -u root`): name the user explicitly,
#   scripts/without-network.sh --as UID:GID --path "$PATH" --home "$HOME" -- <command>
#
# HKN_NO_NETWORK_REQUIRE_ENV (comma-separated names) makes the check also fail
# when any of those variables did not survive the sudo hop. A root
# `unshare --net` needs no unprivileged user namespace, so AppArmor's userns
# restriction does not apply. See docs/testing.md, "Network isolation on Linux".
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
here="$(dirname "$self")"
usage() {
  echo "usage: $0 <command> [args...]   (as root: $0 --as UID:GID --path PATH --home HOME -- <command> [args...])" >&2
  exit 2
}

case "${1:-}" in
  --inside)
    # Last hop: in the namespace, as the user. Prove it, then run the command.
    shift
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || usage
    node "$here/assert-no-network.mjs" --offline
    exec "$@"
    ;;
  --netns)
    # Root, in the new namespace: loopback up, then drop to the user.
    shift
    uid="$1" gid="$2" path="$3" home="$4"
    shift 4
    [ "${1:-}" = "--" ] && shift
    ip link set lo up
    exec setpriv --reuid="$uid" --regid="$gid" --init-groups --inh-caps=-all --no-new-privs -- \
      env PATH="$path" HOME="$home" HOOKNOSTIC_PLAYBACK_NETWORK=none HKN_NO_NETWORK_UID="$uid" \
      "$self" --inside -- "$@"
    ;;
  --as)
    as="" path="" home=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --as) as="$2"; shift 2 ;;
        --path) path="$2"; shift 2 ;;
        --home) home="$2"; shift 2 ;;
        --) shift; break ;;
        *) usage ;;
      esac
    done
    [ -n "$as" ] && [ -n "$path" ] && [ -n "$home" ] && [ "$#" -gt 0 ] || usage
    [ "$(id -u)" = 0 ] || { echo "without-network: --as needs root" >&2; exit 2; }
    uid="${as%%:*}" gid="${as#*:}"
    [ "$uid" != 0 ] || { echo "without-network: refusing to run the command as root" >&2; exit 2; }
    exec unshare --net -- "$self" --netns "$uid" "$gid" "$path" "$home" -- "$@"
    ;;
  "" | -*)
    usage
    ;;
  *)
    [ "$(id -u)" != 0 ] || { echo "without-network: as root, pass --as UID:GID --path PATH --home HOME" >&2; exit 2; }
    exec sudo -n --preserve-env -- "$self" --as "$(id -u):$(id -g)" --path "$PATH" --home "$HOME" -- "$@"
    ;;
esac
