#!/usr/bin/env bash
# Run a command with no network but loopback, as the invoking user. Linux only.
#
#   scripts/without-network.sh <command> [args...]
#
# Run it as yourself: it re-runs itself under passwordless `sudo -n` (as on
# GitHub-hosted runners) to enter a new network namespace, brings loopback up,
# drops back to your uid/gid with no capabilities and no_new_privs, proves the
# isolation with scripts/assert-no-network.mjs --offline, then runs the command
# with your environment. Inside, HOOKNOSTIC_PLAYBACK_NETWORK=none tells the
# playback helpers they are offline (packages/cli/test/harness-playback.ts).
#
# The environment crosses sudo in a file, not through `sudo --preserve-env`:
# the hosted runners' sudo ignores --preserve-env ("preserving the entire
# environment is not supported"). The file is created 0600 by mktemp, read by
# the root hop, and removed. Values never appear in argv or output.
#
# HKN_NO_NETWORK_REQUIRE_ENV (comma-separated names) is read here, before the
# sudo hop, and handed on as an argument: the isolation check then fails if any
# of those variables did not arrive, and the list itself cannot silently vanish.
#
# Root without sudo (e.g. `wsl -u root`): name the user explicitly,
#   scripts/without-network.sh --as UID:GID --path "$PATH" --home "$HOME" -- <command>
# A root `unshare --net` needs no unprivileged user namespace, so AppArmor's
# userns restriction does not apply. See docs/testing.md, "Network isolation on Linux".
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
    require=""
    if [ "${1:-}" = "--require-env" ]; then require="$2"; shift 2; fi
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || usage
    node "$here/assert-no-network.mjs" --offline --require-env "$require"
    exec "$@"
    ;;
  --netns)
    # Root, in the new namespace: loopback up, then drop to the user.
    shift
    uid="$1" gid="$2" path="$3" home="$4" require="$5"
    shift 5
    [ "${1:-}" = "--" ] && shift
    PATH="$PATH:/usr/sbin:/usr/bin:/sbin:/bin" ip link set lo up
    exec setpriv --reuid="$uid" --regid="$gid" --init-groups --inh-caps=-all --no-new-privs -- \
      env PATH="$path" HOME="$home" HOOKNOSTIC_PLAYBACK_NETWORK=none HKN_NO_NETWORK_UID="$uid" \
      "$self" --inside --require-env "$require" -- "$@"
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
    [ "$(id -u)" = 0 ] || { echo "without-network: --as needs root" >&2; exit 2; }
    if [ -n "$envfile" ]; then
      # Replace root's environment with the caller's, NUL-separated, then drop the file.
      vars=()
      while IFS= read -r -d '' kv; do vars+=("$kv"); done < "$envfile"
      rm -f "$envfile"
      for name in $(compgen -e); do unset "$name" 2>/dev/null || true; done
      for kv in "${vars[@]}"; do export "$kv" 2>/dev/null || true; done
      path="${path:-${PATH:-}}" home="${home:-${HOME:-}}"
    fi
    [ -n "$as" ] && [ -n "$path" ] && [ -n "$home" ] && [ "$#" -gt 0 ] || usage
    uid="${as%%:*}" gid="${as#*:}"
    [ "$uid" != 0 ] || { echo "without-network: refusing to run the command as root" >&2; exit 2; }
    exec /usr/bin/unshare --net -- "$self" --netns "$uid" "$gid" "$path" "$home" "$require" -- "$@"
    ;;
  "" | -*)
    usage
    ;;
  *)
    [ "$(id -u)" != 0 ] || { echo "without-network: as root, pass --as UID:GID --path PATH --home HOME" >&2; exit 2; }
    envfile="$(umask 077 && mktemp "${TMPDIR:-/tmp}/without-network-env.XXXXXX")"
    trap 'rm -f "$envfile"' EXIT
    env -0 > "$envfile"
    status=0
    sudo -n -- "$self" --as "$(id -u):$(id -g)" --env-file "$envfile" \
      --require-env "${HKN_NO_NETWORK_REQUIRE_ENV:-}" -- "$@" || status=$?
    exit "$status"
    ;;
esac
