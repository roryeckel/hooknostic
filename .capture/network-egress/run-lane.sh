#!/usr/bin/env bash
# run-lane.sh <lane> <version> <mode> [playback-version-env] [variant-tag] [extra-env-file] [seed-home-dir]
# Modes starting with "nonet" must be started as root: they unshare a network
# namespace with only loopback up, then drop to the unprivileged account for
# the lane. For those, export HN_UID, HN_GID, HN_USER and HN_HOME (that
# account's uid, gid, name and home); HNE defaults to $HN_HOME/hn-egress.
set -uo pipefail
lane="$1"; version="$2"; mode="$3"; pbv="${4:-}"; tag="${5:-}"; extra="${6:-}"; seed="${7:-}"
export HNE="${HNE:-${HN_HOME:-$HOME}/hn-egress}"
run="$HNE/runs/$lane-$version-$mode${tag:+-$tag}"
case "$mode" in
  nonet*)
    [ "$(id -u)" = 0 ] || { echo "nonet needs root"; exit 2; }
    exec unshare --net -- bash -c '
      ip link set lo up
      exec setpriv --reuid="${HN_UID:-1000}" --regid="${HN_GID:-1000}" --init-groups env HOME="$HN_HOME" USER="$HN_USER" LOGNAME="$HN_USER" HNE="$HNE" \
        bash "$HNE/lane-inner.sh" "$@"' _ "$lane" "$version" "$mode" "$run" "$pbv" "$extra" "$seed" ;;
esac
exec bash "$HNE/lane-inner.sh" "$lane" "$version" "$mode" "$run" "$pbv" "$extra" "$seed"
