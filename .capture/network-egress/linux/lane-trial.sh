#!/usr/bin/env bash
# The caller's side of the Linux lane trial (prototype; see lane-setup.sh):
# hand the step's environment to the staged root script in a 0600 file, as
# scripts/without-network.sh does, run the command as the lane user, then run
# the trusted-state check in the same step, before any step boundary lets
# the runner write for later steps.
#   bash lane-trial.sh --label L [--require A,B] [--node-modules-grant] [--mutant-no-readonly] -- <command...>
set -uo pipefail
envfile="$(umask 077 && mktemp "${TMPDIR:-/tmp}/hkn-lane-env.XXXXXX")"
trap 'rm -f -- "$envfile"' EXIT
env -0 > "$envfile"
sudo -n -- /bin/bash /var/lib/hkn-admin/lane-run.sh --env-file "$envfile" "$@"
lane=$?
label="$2"
sudo -n -- /bin/bash /var/lib/hkn-admin/lane-after.sh --label "$label" --in-step
after=$?
echo "lane-trial $label: lane exit $lane, check exit $after"
[ "$lane" = 0 ] && [ "$after" = 0 ]
