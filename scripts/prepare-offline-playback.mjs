#!/usr/bin/env node
// Fetch, while the network is still available, everything a playback lane
// needs, so the lane itself can run without network (scripts/without-network.sh).
//
//   node --experimental-strip-types scripts/prepare-offline-playback.mjs <lane> [--version V] [--check-online]
//
// --check-online  run the positive control (scripts/assert-no-network.mjs
//                 --online) first: the probe that later proves isolation must
//                 see the network here.
// opencode-v2     the pinned ripgrep in HKN_RIPGREP_DIR (or the per-user
//                 default), checked against its SHA-256 (#264).
// opencode-v1     the npm cache for @opencode-ai/plugin@<version>: one online
//                 install through the test's own helper, then the same helper
//                 offline into a second project, which fails with ENOTCACHED if
//                 the cache cannot serve both of the lane's install prefixes.
// Other lanes need nothing beyond the control.
//
// The version is the test's: HOOKNOSTIC_PLAYBACK_VERSION, else --version, else
// the lane's referenceVersion (scripts/harness-playback-version.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { harnessLaneId } from "./harness-lanes.mjs";

const args = process.argv.slice(2);
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--version");
const lane = positional.length === 1 ? harnessLaneId(positional[0]) : "";
if (!lane) {
  console.error(
    "usage: node --experimental-strip-types scripts/prepare-offline-playback.mjs <lane> [--version V] [--check-online]",
  );
  process.exit(2);
}
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const step = (message) => console.log(`prepare-offline-playback ${lane}: ${message}`);

if (args.includes("--check-online")) {
  const control = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("assert-no-network.mjs", import.meta.url)), "--online"],
    {
      stdio: "inherit",
    },
  );
  if (control.status !== 0) process.exit(control.status ?? 1);
}

if (lane === "opencode-v2") {
  const { ensureRipgrep } = await import("../.capture/opencode-v2/ripgrep.mjs");
  step(`ripgrep ready at ${await ensureRipgrep()}`);
}

if (lane === "opencode-v1") {
  const version =
    process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ??
    flagValue("--version") ??
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("harness-playback-version.mjs", import.meta.url)), lane],
      { encoding: "utf8" },
    ).trim();
  register(new URL("ts-resolve-hook.mjs", import.meta.url));
  const { prepareOpenCodePluginDependency } = await import("../packages/cli/test/harness-playback.ts");
  const scratch = await mkdtemp(join(tmpdir(), "hooknostic-offline-prepare-"));
  try {
    await mkdir(join(scratch, "online"));
    await mkdir(join(scratch, "offline"));
    await prepareOpenCodePluginDependency(join(scratch, "online"), version);
    step(`npm cache filled for @opencode-ai/plugin@${version}`);
    const previous = process.env["HOOKNOSTIC_PLAYBACK_NETWORK"];
    process.env["HOOKNOSTIC_PLAYBACK_NETWORK"] = "none";
    try {
      await prepareOpenCodePluginDependency(join(scratch, "offline"), version);
    } finally {
      if (previous === undefined) delete process.env["HOOKNOSTIC_PLAYBACK_NETWORK"];
      else process.env["HOOKNOSTIC_PLAYBACK_NETWORK"] = previous;
    }
    step("the cache serves both install prefixes offline");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
step("done");
