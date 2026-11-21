#!/usr/bin/env node
// The lane side of scripts/without-network.ps1: the first code that runs as
// its dedicated user.
//   node scripts/without-network-lane.mjs <lane.json>
// lane.json, written by the wrapper before the lane started, holds the
// allowlisted environment, the required names, the expected SID, the command
// line and its directory. With that environment, this runs
// scripts/assert-no-network.mjs --offline, and runs the command line (through
// cmd.exe, for .cmd shims such as pnpm) only if the check passes. Exits with
// the check's code, or the command's.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lane = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^﻿/, ""));
const check = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("assert-no-network.mjs", import.meta.url)),
    "--offline",
    "--require-env",
    lane.require.join(","),
    "--expect-sid",
    lane.sid,
  ],
  { cwd: lane.cwd, env: lane.env, stdio: "inherit" },
);
if (check.status !== 0) {
  console.error("without-network: the isolation check failed, so the command did not run");
  process.exit(check.status ?? 1);
}
const run = spawnSync(lane.command, { cwd: lane.cwd, env: lane.env, stdio: "inherit", shell: true });
if (run.error) console.error(`without-network: could not start the command: ${run.error.code ?? run.error.message}`);
process.exit(run.status ?? 1);
