#!/usr/bin/env bash
# Linux shell-dialect capture for the GitHub Copilot CLI adapter.
#
# Runs in a disposable Debian container as root. The Copilot CLI is installed
# from npm with lifecycle scripts disabled, a scratch repository is created,
# and one prompt drives a single bash call whose command reports the process
# that interpreted it. The hook tee records the native payload; the tool output
# records the interpreter. No repository credential is written anywhere.
set -u

CAPTURE_DIR=/capture/captured/host-linux
WORK=/work
rm -rf "$WORK" "$CAPTURE_DIR"
mkdir -p "$WORK/.github/hooks" "$CAPTURE_DIR" "$WORK/.copilot-home"

node -e '
const fs = require("node:fs");
const dir = "/capture/captured/host-linux";
const tee = (event) => ({
  type: "command",
  exec: "node",
  args: ["/capture/tee.mjs", dir, event, "", "0"],
  timeoutSec: 30,
});
fs.writeFileSync("/work/.github/hooks/probe.json", JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [tee("sessionStart")],
    sessionEnd: [tee("sessionEnd")],
    preToolUse: [tee("preToolUse")],
    postToolUse: [tee("postToolUse")],
  },
}, null, 2));
'

cd "$WORK"
git init -q
printf 'probe\n' > README.md
git add -A
git -c user.email=capture@example.invalid -c user.name=capture commit -qm probe

copilot --trust-folder --allow-all-tools --disable-client-telemetry -p \
  'Use a shell tool exactly once to run exactly this command and report its output verbatim, then reply DONE: node -e "const fs=require(\"fs\"); console.log(fs.readlinkSync(\"/proc/\"+process.ppid+\"/exe\"))" ; echo hooknostic-shell-finished'
status=$?
echo "copilot exit=$status"
ls -la "$CAPTURE_DIR"
for file in "$CAPTURE_DIR"/*.jsonl; do
  echo "--- $file"
  cat "$file"
done
exit 0
