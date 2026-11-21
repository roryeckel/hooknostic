#!/usr/bin/env bash
# The caller's side of the Linux lane trial (prototype; see lane-setup.sh):
# hand the step's environment to the staged root script in a 0600 file, as
# scripts/without-network.sh does, and run the command as the lane user.
#   bash lane-trial.sh --label L [--require A,B] [--node-modules-grant] -- <command...>
set -uo pipefail
envfile="$(umask 077 && mktemp "${TMPDIR:-/tmp}/hkn-lane-env.XXXXXX")"
trap 'rm -f -- "$envfile"' EXIT
env -0 > "$envfile"
sudo -n -- /bin/bash /var/lib/hkn-admin/lane-run.sh --env-file "$envfile" "$@"
