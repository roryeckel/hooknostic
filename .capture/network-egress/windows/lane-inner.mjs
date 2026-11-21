#!/usr/bin/env node
// The first code that runs as the lane user (prototype; see lane-setup.ps1).
//   node lane-inner.mjs <scratch> <expected SID>
// Reads <scratch>\bin\lane.json, which lane-run.ps1 wrote before the lane
// started. Then it:
// 1. reports what it started with (variable names only);
// 2. checks its identity: the exact SID the wrapper created, its integrity
//    level, and that it is not in Administrators;
// 3. probes the network: public IPv4 and IPv6, DNS, HTTPS, and a loopback
//    round trip;
// 4. probes escape routes: writes and reads the admin later trusts, symlink
//    and junction creation, and BITS when asked;
// 5. checks the allowlisted environment it will hand on;
// 6. runs the command with that environment and exits with its code.
// Prints labels and results, never environment values or file contents.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { closeSync, existsSync, openSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const [scratch, expectedSid] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(join(scratch, "bin", "lane.json"), "utf8").replace(/^\uFEFF/, ""));
const log = (line) => console.log(`lane-inner ${cfg.label}: ${line}`);
const failed = [];
const check = (name, ok, detail) => {
  if (!ok) failed.push(name);
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};
const forbidden = /^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)/i;
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

// 1. The environment this process started with.
const startNames = Object.keys(process.env);
log(`started with ${startNames.length} variables; forbidden names: ${startNames.filter((n) => forbidden.test(n)).join(", ") || "none"}`);

// 2. Identity.
const whoami = (...args) => execFileSync(join(system32, "whoami.exe"), args, { encoding: "utf8" });
const sid = whoami("/user", "/fo", "csv", "/nh").trim().split(",").pop().replace(/"/g, "");
const groups = whoami("/groups", "/fo", "csv", "/nh");
const level = groups.match(/"Mandatory Label\\([^"]+)"/)?.[1] ?? "none";
const admins = groups.split(/\r?\n/).find((line) => line.includes('"S-1-5-32-544"'));
check("identity", sid === expectedSid, sid === expectedSid ? "the wrapper's SID" : "a different SID");
const wantLevel = cfg.integrity === "Low" ? "Low Mandatory Level" : "Medium Mandatory Level";
check("integrity", level === wantLevel, level);
check("administrators", !admins, admins ? `present: ${admins.split(",").pop()}` : "not a member");

// 3. Network.
function tcp(host) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443 });
    const done = (result) => {
      globalThis.clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = globalThis.setTimeout(() => done("TIMEOUT"), 5000);
    socket.once("connect", () => done("connected"));
    socket.once("error", (error) => done(error.code ?? error.message));
  });
}
async function loopback() {
  const server = createServer((socket) => socket.end("pong"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: server.address().port });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.once("end", () => resolve(data === "pong" ? "round-trip" : "unexpected"));
    socket.once("error", (error) => resolve(error.code ?? error.message));
  });
  server.close();
  return result;
}
const [v4, v6, dns, https, loop] = await Promise.all([
  Promise.all(["1.1.1.1", "8.8.8.8", "9.9.9.9"].map(tcp)),
  tcp("2606:4700:4700::1111"),
  lookup("github.com").then(
    () => "resolved",
    (error) => error.code,
  ),
  fetch("https://github.com/", { method: "HEAD", signal: AbortSignal.timeout(5000) }).then(
    (response) => `status ${response.status}`,
    (error) => error.cause?.code ?? error.name,
  ),
  loopback(),
]);
check("public IPv4 connect", v4.every((r) => r === "EACCES"), v4.join(", "));
check("public IPv6 connect", v6 !== "connected" && v6 !== "TIMEOUT", v6);
check("HTTPS", !https.startsWith("status"), https);
check("loopback round trip", loop === "round-trip", loop);
log(`DNS lookup (not enforced on Windows): ${dns}`);

// 4. Escape routes.
function code(error) {
  return error.code ?? error.message;
}
function probe(target) {
  try {
    statSync(target.path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    return `cannot stat: ${code(error)}`;
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
check("nothing the admin trusts is writable or secret-readable", exposed.length === 0, exposed.join("; ") || "none");

const linkDir = join(scratch, "work");
try {
  writeFileSync(join(linkDir, "link-target.txt"), "x");
  symlinkSync(join(linkDir, "link-target.txt"), join(linkDir, "file-symlink"), "file");
  log("file symlink: created");
  unlinkSync(join(linkDir, "file-symlink"));
} catch (error) {
  log(`file symlink: ${code(error)}`);
}
try {
  symlinkSync("C:\\actions-runner", join(linkDir, "junction"), "junction");
  log(`junction to C:\\actions-runner: created; listing through it: ${(() => {
    try {
      return `${execFileSync(join(system32, "cmd.exe"), ["/d", "/c", "dir", "/b", join(linkDir, "junction")], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).length} entries`;
    } catch (error) {
      return code(error);
    }
  })()}`);
  rmdirSync(join(linkDir, "junction"));
} catch (error) {
  log(`junction: ${code(error)}`);
}

// Can the lane open the runner's worker process, or the admin step's shell?
// Their memory holds the job's secrets. OpenProcess with exact rights:
// 0x1000 query-limited, 0x0410 query + VM read, 0x1F0FFF all access.
for (const [name, pid] of Object.entries(cfg.processes ?? {})) {
  if (!pid) continue;
  const script = [
    "Add-Type -Namespace Hkn -Name K -MemberDefinition '",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern System.IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);',
    "'",
    `foreach ($a in 0x1000, 0x0410, 0x1F0FFF) { $h = [Hkn.K]::OpenProcess($a, $false, ${Number(pid)}); $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()`,
    "  if ($h -ne [IntPtr]::Zero) { [void][Hkn.K]::CloseHandle($h); '0x{0:X} OPENED' -f $a } else { '0x{0:X} denied ({1})' -f $a, $e } }",
  ].join("\n");
  const open = spawnSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 90_000,
    env: cfg.env,
  });
  const answer = (open.stdout || "").trim().split(/\r?\n/).join("; ") || (open.stderr || "").trim().split(/\r?\n/)[0] || `exit ${open.status}`;
  log(`probe OpenProcess ${name}: ${answer.slice(0, 200)}`);
}

if (cfg.bits) {
  const dest = join(scratch, "work", "bits-robots.txt");
  const bits = spawnSync(
    join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", `Start-BitsTransfer -Source 'https://github.com/robots.txt' -Destination '${dest}' -ErrorAction Stop`],
    { encoding: "utf8", timeout: 120_000, env: cfg.env },
  );
  const reason = (bits.stderr || bits.stdout || "").split(/\r?\n/).find((line) => line.trim()) ?? "";
  log(`BITS download as the lane user: exit ${bits.status}${bits.error ? ` (${bits.error.code})` : ""}; file ${existsSync(dest) ? "DOWNLOADED" : "absent"}${reason ? `; ${reason.trim().slice(0, 160)}` : ""}`);
  const certutil = spawnSync(join(system32, "certutil.exe"), ["-urlcache", "-split", "-f", "https://github.com/robots.txt", join(scratch, "work", "certutil.txt")], {
    encoding: "utf8",
    timeout: 60_000,
    env: cfg.env,
  });
  log(`certutil download as the lane user: exit ${certutil.status}; file ${existsSync(join(scratch, "work", "certutil.txt")) ? "DOWNLOADED" : "absent"}`);
}

// 5. The environment handed on.
const env = cfg.env;
const missing = cfg.require.filter((name) => !env[name]);
check(
  "environment",
  env.HOOKNOSTIC_PLAYBACK_NETWORK === "none" && missing.length === 0 && !Object.keys(env).some((n) => forbidden.test(n)),
  `${Object.keys(env).length} names; required ${cfg.require.length ? cfg.require.join(", ") : "none"}${missing.length ? `; MISSING ${missing.join(", ")}` : ""}; forbidden names: ${Object.keys(env).filter((n) => forbidden.test(n)).join(", ") || "none"}`,
);
log(`checks: ${failed.length ? `FAILED ${failed.join(", ")}` : "all passed"}`);

// 6. The command. Run even when a check failed: this is a measurement.
if (!cfg.command) process.exit(failed.length ? 1 : 0);
const start = Date.now();
const run = spawnSync(cfg.command, { shell: true, stdio: "inherit", env, cwd: cfg.cwd });
log(`command exit ${run.status}${run.signal ? ` signal ${run.signal}` : ""}${run.error ? ` error ${run.error.code}` : ""} after ${Math.round((Date.now() - start) / 1000)} s`);
process.exit(run.status ?? 1);
