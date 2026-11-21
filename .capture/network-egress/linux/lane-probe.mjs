#!/usr/bin/env node
// The first code that runs as the Linux lane user (prototype; see
// lane-setup.sh), inside the network namespace, from an empty environment.
//   node lane-probe.mjs <scratch>
// Reads <scratch>/bin/lane.json and lane.env, which root wrote before the
// lane started. Then it:
// 1. reports what it started with (names only), and its identity;
// 2. probes escape routes: writes and reads of what later steps trust, the
//    Docker socket, sudo, and symlink creation;
// 3. checks the environment it hands on (required names, forbidden names);
// 4. runs scripts/assert-no-network.mjs --offline, then the command, with
//    that environment, and exits with the command's code.
// Prints labels and results, never environment values or file contents.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const scratch = process.argv[2];
const cfg = JSON.parse(readFileSync(join(scratch, "bin", "lane.json"), "utf8"));
const env = {};
for (const entry of readFileSync(join(scratch, "bin", "lane.env"), "utf8").split("\0")) {
  const at = entry.indexOf("=");
  if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
}
const log = (line) => console.log(`lane-probe ${cfg.label}: ${line}`);
const failed = [];
const check = (name, ok, detail) => {
  if (!ok) failed.push(name);
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};
const forbidden = /^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)/;
const status = (field) => readFileSync("/proc/self/status", "utf8").match(new RegExp(`^${field}:\\s*(\\S+)`, "m"))?.[1] ?? "?";

log(`started with ${Object.keys(process.env).length} variables`);
const extra = process.getgroups().filter((g) => g !== cfg.gid);
check("identity", process.getuid() === cfg.uid && process.getgid() === cfg.gid && extra.length === 0, `uid ${process.getuid()}, gid ${process.getgid()}, supplementary ${extra.join(",") || "none"}`);
check("privileges", /^0+$/.test(status("CapEff")) && status("NoNewPrivs") === "1", `CapEff ${status("CapEff")}, NoNewPrivs ${status("NoNewPrivs")}`);

const code = (error) => error.code ?? error.message;
function probe(target) {
  try {
    statSync(target.path);
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : `cannot stat: ${code(error)}`;
  }
  if (target.kind === "dir") {
    const file = join(target.path, `hkn-probe-${randomBytes(4).toString("hex")}`);
    try {
      closeSync(openSync(file, "wx"));
    } catch (error) {
      return `denied (${code(error)})`;
    }
    try {
      unlinkSync(file);
      return "WRITABLE";
    } catch (error) {
      return `WRITABLE (left behind: ${code(error)})`;
    }
  }
  try {
    closeSync(openSync(target.path, target.kind === "write" ? "r+" : "r"));
    return target.kind === "write" ? "WRITABLE" : "READABLE";
  } catch (error) {
    return `denied (${code(error)})`;
  }
}
const exposed = [];
for (const target of cfg.targets) {
  const result = probe(target);
  if (/^(WRITABLE|READABLE)/.test(result)) exposed.push(`${target.kind} ${target.label}`);
  log(`probe ${target.kind} ${target.label}: ${result}`);
}
check("nothing later steps trust is writable or secret-readable", exposed.length === 0, exposed.join("; ") || "none");

const docker = await new Promise((resolve) => {
  const socket = connect({ path: "/var/run/docker.sock" });
  socket.once("connect", () => {
    socket.destroy();
    resolve("CONNECTED");
  });
  socket.once("error", (error) => resolve(code(error)));
});
check("Docker socket", docker !== "CONNECTED", docker);
const sudo = spawnSync("/usr/bin/sudo", ["-n", "true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
check("sudo", sudo.status !== 0, `exit ${sudo.status}: ${(sudo.stderr || "").trim().split("\n")[0].slice(0, 100)}`);
try {
  writeFileSync(join(scratch, "work", "link-target"), "x");
  symlinkSync(join(scratch, "work", "link-target"), join(scratch, "work", "link"));
  log("symlink in scratch: created (so admin-side readers of the scratch tree must not follow links)");
} catch (error) {
  log(`symlink in scratch: ${code(error)}`);
}

const missing = cfg.require.filter((name) => !env[name]);
check(
  "environment",
  env.HOOKNOSTIC_PLAYBACK_NETWORK === "none" && missing.length === 0 && !Object.keys(env).some((n) => forbidden.test(n)),
  `${Object.keys(env).length} names; required ${cfg.require.join(", ") || "none"}${missing.length ? `; MISSING ${missing.join(", ")}` : ""}; forbidden: ${Object.keys(env).filter((n) => forbidden.test(n)).join(", ") || "none"}`,
);
log(`checks: ${failed.length ? `FAILED ${failed.join(", ")}` : "all passed"}`);

const canary = spawnSync(cfg.node, [join(cfg.cwd, "scripts", "assert-no-network.mjs"), "--offline", "--require-env", cfg.require.join(",")], {
  env,
  cwd: cfg.cwd,
  stdio: "inherit",
});
log(`canary exit ${canary.status}`);
const start = Date.now();
const run = spawnSync(cfg.command[0], cfg.command.slice(1), { env, cwd: cfg.cwd, stdio: "inherit" });
log(`command exit ${run.status}${run.signal ? ` signal ${run.signal}` : ""}${run.error ? ` error ${run.error.code}` : ""} after ${Math.round((Date.now() - start) / 1000)} s`);
process.exit(run.status ?? 1);
