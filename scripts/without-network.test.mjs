// The wrapper's refusals that need no root: --as must be the user who invoked
// sudo, and --env-file must be a regular 0600 file of that user's, made by the
// script. They run before the root check, so a normal user exercises them
// here; the accepted case reaches that root check and stops. Linux only (bash
// and GNU stat), which is where the wrapper runs; CI's ubuntu test job runs it.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

const linux = process.platform === "linux";
const script = fileURLToPath(new URL("without-network.sh", import.meta.url));
const dir = linux ? mkdtempSync(join(tmpdir(), "without-network-test-")) : "";
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const me = linux ? userInfo() : { uid: -1, gid: -1 };
const envFile = (name, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, "");
  chmodSync(path, mode);
  return path;
};
// As sudo would enter the root hop for this user: SUDO_UID/SUDO_GID set.
const asRoot = (as, envfile, require = ["--require-env", "HOOKNOSTIC_PLAYBACK"]) =>
  spawnSync("/bin/bash", [script, "--as", as, "--env-file", envfile, ...require, "--", "true"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", SUDO_UID: String(me.uid), SUDO_GID: String(me.gid) },
  });
const refusal = (result) => `${result.status} ${result.stderr.trim()}`;

it.skipIf(!linux || me.uid === 0)("refuses an empty required list on both entries, before sudo", () => {
  // The caller's entry: refused before it would reach sudo, so nothing runs.
  const caller = spawnSync("/bin/bash", [script, "true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  expect(refusal(caller)).toBe(
    "2 without-network: no required variables: set HKN_NO_NETWORK_REQUIRE_ENV (an empty list checks nothing)",
  );
  expect(refusal(asRoot(`${me.uid}:${me.gid}`, envFile("without-network-env.empty"), ["--require-env", ""]))).toBe(
    "2 without-network: no required variables: set HKN_NO_NETWORK_REQUIRE_ENV or pass --require-env (an empty list checks nothing)",
  );
});

it.skipIf(!linux || me.uid === 0)("refuses --as for anyone but the user who invoked sudo", () => {
  const file = envFile("without-network-env.as");
  expect(refusal(asRoot("65534:65534", file))).toBe("2 without-network: --as 65534:65534 is not the invoking user");
  expect(refusal(asRoot(`${me.uid}:65534`, file))).toBe(
    `2 without-network: --as ${me.uid}:65534 is not the invoking user`,
  );
  expect(refusal(asRoot("0:0", file))).toBe("2 without-network: refusing to run the command as root");
});

it.skipIf(!linux || me.uid === 0)("takes --as as numeric UID:GID, never as root or with root's group", () => {
  const file = envFile("without-network-env.numeric");
  // 00:00 is root written with leading zeros.
  expect(refusal(asRoot("00:00", file))).toBe("2 without-network: refusing to run the command as root");
  expect(refusal(asRoot(`${me.uid}:0`, file))).toBe("2 without-network: refusing to run the command with root's group");
  // A missing colon is not UID:UID, and a second colon is malformed.
  expect(refusal(asRoot(String(me.uid), file))).toBe("2 without-network: --as takes numeric UID:GID");
  expect(refusal(asRoot(`${me.uid}:${me.gid}:0`, file))).toBe("2 without-network: --as takes numeric UID:GID");
  // Leading zeros are decimal, not a different request: the leading-zero
  // form reaches the same check as the canonical one.
  expect(refusal(asRoot(`0${me.uid}:0${me.gid}`, file))).toBe("2 without-network: --as needs root");
});

it.skipIf(!linux || me.uid === 0)("refuses an --env-file that is not the caller's own 0600 file", () => {
  const as = `${me.uid}:${me.gid}`;
  expect(refusal(asRoot(as, envFile("without-network-env.wide", 0o644)))).toBe(
    `2 without-network: --env-file is not a 0600 file owned by ${me.uid}`,
  );
  // Owned by root, as /etc/passwd is on any Linux host.
  expect(refusal(asRoot(as, "/etc/passwd"))).toMatch(/^2 without-network: --env-file is not a 0600 file owned by/);
  const link = join(dir, "without-network-env.link");
  symlinkSync(envFile("without-network-env.target"), link);
  expect(refusal(asRoot(as, link))).toBe("2 without-network: --env-file is not a regular file");
  expect(refusal(asRoot(as, envFile("not-ours")))).toBe("2 without-network: --env-file is not one this script made");
  expect(refusal(asRoot(as, join(dir, "without-network-env.missing")))).toBe(
    "2 without-network: --env-file is not a regular file",
  );
});

it.skipIf(!linux || me.uid === 0)("lets a valid request through every check to the root check", () => {
  expect(refusal(asRoot(`${me.uid}:${me.gid}`, envFile("without-network-env.ok")))).toBe(
    "2 without-network: --as needs root",
  );
});
