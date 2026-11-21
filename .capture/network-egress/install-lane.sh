#!/usr/bin/env bash
# Install one playback lane's harness the way CI's harness-playback job does
# (`npm install --global <pkg>@<version>`), into a per-lane prefix so lanes
# never see each other's binaries. Network is allowed here: install is not
# part of the measurement.
#   install-lane.sh <lane> [version]
set -euo pipefail
source "${HNE:-$HOME/hn-egress}/env.sh"
lane="$1"
cd "$HNE/repo"
pkg="$(node --input-type=module -e 'import { harnessLanes } from "./scripts/harness-lanes.mjs"; console.log(harnessLanes[process.argv[1]].pkg)' "$lane")"
bootstrap="$(node --input-type=module -e 'import { harnessLanes } from "./scripts/harness-lanes.mjs"; console.log(harnessLanes[process.argv[1]].bootstrap ?? "")' "$lane")"
version="${2:-$(node --experimental-strip-types scripts/harness-playback-version.mjs "$lane" 2>/dev/null)}"
prefix="$HNE/harness/$lane-$version"
rm -rf "$prefix"
mkdir -p "$prefix"
echo "lane=$lane pkg=$pkg version=$version prefix=$prefix"
npm_config_prefix="$prefix" npm install --global --no-fund --no-audit "$pkg@$version"
# npm 11 may skip lifecycle scripts; run the known bootstrap exactly as
# harness-watch does when the package names one.
if [ -n "$bootstrap" ]; then
  node "$prefix/lib/node_modules/$pkg/$bootstrap" || echo "bootstrap exited $?"
fi
ls -l "$prefix/bin"
