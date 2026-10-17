#!/bin/bash
# Disposable Docker setup; /source is the read-only checkout, /evidence the output mount.
set -euo pipefail
apt-get update -qq
apt-get install -y -qq fish tcsh zsh >/dev/null
mkdir -p /work /tools
tar -C /source --exclude=.git --exclude=node_modules --exclude=dist --exclude=captured\* --exclude=scratch -cf - . | tar -C /work -xf -
useradd --create-home hkncaptureaccount
chown -R hkncaptureaccount:hkncaptureaccount /work /tools /evidence
pi_version=$(node --experimental-strip-types --input-type=module -e 'import { piHarness } from "/source/packages/adapter-pi/src/harness.ts"; process.stdout.write(piHarness.referenceVersion)')
pnpm_version=$(node -p 'JSON.parse(require("fs").readFileSync("/source/package.json", "utf8")).packageManager')
su hkncaptureaccount -s /bin/bash -c "npm install --prefix /tools @earendil-works/pi-coding-agent@$pi_version $pnpm_version"
su hkncaptureaccount -s /bin/bash -c 'cd /work && /tools/node_modules/.bin/pnpm install --frozen-lockfile'
su hkncaptureaccount -s /bin/bash -c 'cd /work && PATH=/tools/node_modules/.bin:$PATH pnpm run bundle'
su hkncaptureaccount -s /bin/bash -c 'cd /work && HKN_PI_BINARY=/tools/node_modules/.bin/pi HKN_PI_FEATURE_OUTPUT=/evidence node --experimental-strip-types .capture/pi/probe-features.mjs shells'
