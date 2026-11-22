#!/usr/bin/env node
// Prove, by effect, the network state a playback step relies on.
//
//   node scripts/assert-no-network.mjs --offline [--require-env A,B]
//     Inside scripts/without-network.sh, before the playback command. Fails
//     unless the process has no route out:
//       - no non-loopback interface;
//       - every public IPv4 probe and every public IPv6 probe (Cloudflare and
//         Google) refused by the kernel with ENETUNREACH;
//       - a loopback round trip works;
//       - DNS failing, within DNS_FAST_MS;
//       - with --dns-timeout N, the resolver configuration's effective timeout
//         is N. scripts/without-network.sh passes 0: musl, which codex is
//         built against, otherwise waits its timeout after a send that has
//         already failed (5 s a lookup), where glibc and c-ares fail at once;
//       - the expected unprivileged user, with no supplementary groups, no
//         capabilities and no_new_privs;
//       - every required variable present and non-empty.
//   node scripts/assert-no-network.mjs --offline --require-env A,B --expect-sid S
//     On Windows, inside scripts/without-network.ps1, as its dedicated user.
//     The block there is a firewall rule on that user's SID, not a
//     namespace: the adapters stay, so there is no interface check, and the
//     block is shown by effect. Fails unless:
//       - every public IPv4 probe is refused by the firewall (EACCES), and
//         every public IPv6 probe is refused or unroutable. All ENETUNREACH
//         passes, with a note: no IPv6 route exists, so that alone does not
//         prove the firewall;
//       - a loopback round trip works;
//       - the process runs as exactly the SID the wrapper created, and not as
//         an administrator;
//       - every required variable is present and non-empty, and no name the
//         wrapper's allowlist must keep out (ACTIONS_*, GITHUB_TOKEN, the
//         file-command paths, INPUT_*) reached the lane.
//     DNS is reported, not required to fail: the DNS Client service resolves
//     names on the lane's behalf (one of the documented limitations,
//     docs/testing.md, "Network isolation in CI").
//   node scripts/assert-no-network.mjs --online
//     The positive control, run outside the namespace. At least one IPv4
//     probe and the DNS lookup must succeed, so --offline cannot pass because
//     the probe itself is broken. Several targets, so one filtered address
//     does not fail a lane. IPv6 is reported but never required: hosted
//     runners have none.
//
// Prints one line per check, every check, then exits 1 if any failed. Prints
// names of environment variables, never their values.
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Public anycast resolvers that also listen on 443 (DNS over HTTPS). */
export const PROBE_IPV4 = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
export const PROBE_IPV6 = ["2606:4700:4700::1111", "2001:4860:4860::8888"];
export const PROBE_HOST = "github.com";
const TIMEOUT_MS = 5000;
/** How long a lookup may take to fail without network: a miss must be quick. */
export const DNS_FAST_MS = 1000;

/**
 * The resolver timeout, in seconds, that resolv.conf text configures: the
 * last `timeout:N` on an `options` line, as glibc and musl both read it, or
 * their default of 5.
 * @param {string} text
 */
export function resolverTimeout(text) {
  let timeout = 5;
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "options") continue;
    for (const word of words.slice(1)) {
      const value = /^timeout:(\d+)$/.exec(word)?.[1];
      if (value !== undefined) timeout = Number(value);
    }
  }
  return timeout;
}

/**
 * The required names that are missing or empty. An empty value selects
 * nothing, just as an absent one does (`HOOKNOSTIC_PLAYBACK=""` skips every
 * playback test), so it counts as missing.
 * @param {string[]} required
 * @param {Record<string, string | undefined>} env
 */
export function missingNames(required, env) {
  return required.filter((name) => !env[name]);
}

/** Names scripts/without-network.ps1's allowlist keeps out of a Windows lane. */
export const FORBIDDEN_NAME = /^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)/i;
/** How a refused IPv6 connect may read on Windows: blocked, or no route at all. */
const REFUSED_IPV6 = ["EACCES", "ENETUNREACH", "EHOSTUNREACH"];

/**
 * Judge what was observed. Pure, so the decision is unit-tested apart from
 * the probes; only the --online control proves the probes themselves.
 * @param {"offline" | "online"} mode
 * @param {{
 *   interfaces: string[],
 *   ipv4: string[],
 *   ipv6: string[],
 *   loopback: string,
 *   dns: string,
 *   dnsMs?: number,
 *   resolver?: { timeout: number, expected: number },
 *   linux?: { uid: number, expectedUid?: number, gid: number, groups: number[], capEff: string, capPrm: string, noNewPrivs: string },
 *   windows?: { sid: string, expectedSid?: string, admin: boolean },
 *   env?: { required: string[], missing: string[], offlineMarker: boolean, forbidden?: string[] },
 * }} seen `ipv4` holds one result per PROBE_IPV4 address, and `ipv6` one
 *   per PROBE_IPV6 address: "connected" or an error code. `loopback` is
 *   "round-trip" or an error code for every offline lane. `dns` is "resolved"
 *   or an error code. `interfaces` names those with a non-internal address.
 *   `windows` marks a Windows lane.
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function evaluate(mode, seen) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const v4 = seen.ipv4.map((result, index) => `${PROBE_IPV4[index] ?? "?"}:443 -> ${result}`).join(", ");
  const v6 = seen.ipv6.map((result, index) => `[${PROBE_IPV6[index] ?? "?"}]:443 -> ${result}`).join(", ");
  // All unroutable is consistent with a firewall block, but on a host with no
  // IPv6 route it proves only that. Say so instead of reading it as the rule.
  const noIpv6Route = seen.ipv6.length > 0 && seen.ipv6.every((result) => result === "ENETUNREACH");
  if (mode === "offline" && seen.windows) {
    // A firewall rule on the lane user's SID: the adapters stay, so the block
    // is shown by effect, never by the interface list.
    const { sid, expectedSid, admin } = seen.windows;
    check(
      "user",
      Boolean(expectedSid) && sid === expectedSid,
      expectedSid ? (sid === expectedSid ? "the wrapper's SID" : "not the wrapper's SID") : "no expected SID given",
    );
    check("administrators", !admin, admin ? "member" : "not a member");
    check("public IPv4 connect", seen.ipv4.length > 0 && seen.ipv4.every((result) => result === "EACCES"), v4);
    check(
      "public IPv6 connect",
      seen.ipv6.length === PROBE_IPV6.length && seen.ipv6.every((result) => REFUSED_IPV6.includes(result)),
      `${v6}${noIpv6Route ? "; all ENETUNREACH: no IPv6 route, so this does not prove the firewall" : ""}`,
    );
    check("loopback round trip", seen.loopback === "round-trip", seen.loopback);
    // The DNS Client service resolves for the lane; documented, not enforced.
    check("DNS lookup (allowed on Windows)", true, `${PROBE_HOST} -> ${seen.dns}`);
  } else if (mode === "offline") {
    check(
      "interfaces",
      seen.interfaces.length === 0,
      seen.interfaces.length === 0 ? "loopback only" : `non-loopback: ${seen.interfaces.join(", ")}`,
    );
    check("public IPv4 connect", seen.ipv4.length > 0 && seen.ipv4.every((result) => result === "ENETUNREACH"), v4);
    check(
      "public IPv6 connect",
      seen.ipv6.length === PROBE_IPV6.length && seen.ipv6.every((result) => result === "ENETUNREACH"),
      v6,
    );
    check("loopback round trip", seen.loopback === "round-trip", seen.loopback);
    const fast = seen.dnsMs !== undefined && seen.dnsMs < DNS_FAST_MS;
    check(
      "DNS lookup",
      seen.dns !== "resolved" && fast,
      `${PROBE_HOST} -> ${seen.dns} in ${seen.dnsMs ?? "?"} ms${fast ? "" : `, not under ${DNS_FAST_MS} ms`}`,
    );
    if (seen.resolver) {
      const { timeout, expected } = seen.resolver;
      check("resolver timeout", timeout === expected, `${timeout} s in /etc/resolv.conf, expected ${expected} s`);
    }
  }
  if (mode === "offline") {
    if (seen.linux) {
      const { uid, expectedUid, gid, groups, capEff, capPrm, noNewPrivs } = seen.linux;
      check(
        "user",
        uid !== 0 && (expectedUid === undefined || uid === expectedUid),
        `uid ${uid}${expectedUid === undefined ? "" : `, expected ${expectedUid}`}`,
      );
      const supplementary = groups.filter((group) => group !== gid);
      check(
        "groups",
        supplementary.length === 0,
        supplementary.length === 0 ? `gid ${gid} only` : `supplementary: ${supplementary.join(", ")}`,
      );
      check("capabilities", /^0+$/.test(capEff) && /^0+$/.test(capPrm), `CapEff ${capEff}, CapPrm ${capPrm}`);
      check("no_new_privs", noNewPrivs === "1", `NoNewPrivs ${noNewPrivs}`);
    }
    if (seen.env) {
      // Only a Windows lane's environment is an allowlist, so only there is a
      // forbidden name a failure.
      const forbidden = seen.env.forbidden ?? [];
      check(
        "environment",
        seen.env.offlineMarker && seen.env.missing.length === 0 && forbidden.length === 0,
        `HOOKNOSTIC_PLAYBACK_NETWORK=none ${seen.env.offlineMarker ? "set" : "missing"}; ` +
          (seen.env.required.length === 0
            ? "no required names"
            : seen.env.missing.length === 0
              ? `present: ${seen.env.required.join(", ")}`
              : `missing or empty: ${seen.env.missing.join(", ")}`) +
          (seen.env.forbidden === undefined
            ? ""
            : `; ${forbidden.length === 0 ? "no forbidden names" : `forbidden names present: ${forbidden.join(", ")}`}`),
      );
    }
  } else {
    check(
      "public IPv4 connect (any)",
      seen.ipv4.some((result) => result === "connected"),
      v4,
    );
    check("DNS lookup", seen.dns === "resolved", `${PROBE_HOST} -> ${seen.dns}`);
    // Informational: a host without IPv6 egress is still online.
    check("public IPv6 connect (not required)", true, v6);
  }
  return checks;
}

function tcp(host) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443 });
    const done = (result) => {
      globalThis.clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = globalThis.setTimeout(() => done("TIMEOUT"), TIMEOUT_MS);
    socket.once("connect", () => done("connected"));
    socket.once("error", (error) => done(error.code ?? error.message));
  });
}

let dnsMs;
async function dns() {
  const start = globalThis.performance.now();
  try {
    await lookup(PROBE_HOST);
    return "resolved";
  } catch (error) {
    return error.code ?? error.message;
  } finally {
    dnsMs = Math.round(globalThis.performance.now() - start);
  }
}

function status(field) {
  return readFileSync("/proc/self/status", "utf8").match(new RegExp(`^${field}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
}

/** A loopback round trip through a server in this process. */
async function loopbackRoundTrip() {
  const server = createServer((socket) => socket.end("pong"));
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    return await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: server.address().port });
      let data = "";
      const timer = globalThis.setTimeout(() => {
        socket.destroy();
        resolve("TIMEOUT");
      }, TIMEOUT_MS);
      socket.on("data", (chunk) => (data += chunk));
      socket.once("end", () => {
        globalThis.clearTimeout(timer);
        resolve(data === "pong" ? "round-trip" : "unexpected reply");
      });
      socket.once("error", (error) => {
        globalThis.clearTimeout(timer);
        resolve(error.code ?? error.message);
      });
    });
  } catch (error) {
    return error.code ?? error.message;
  } finally {
    server.close();
  }
}

/** The current token's user SID and Administrators membership, from whoami. */
function windowsIdentity() {
  const whoami = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe");
  const user = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const groups = execFileSync(whoami, ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" });
  return {
    sid: user.trim().split(",").pop()?.replace(/"/g, "") ?? "",
    admin: groups.split(/\r?\n/).some((line) => line.includes('"S-1-5-32-544"')),
  };
}

function argument(name) {
  const flag = process.argv.indexOf(name);
  return flag === -1 ? undefined : (process.argv[flag + 1] ?? "");
}

async function observe(mode) {
  const [ipv4, ipv6, resolved, loopback] = await Promise.all([
    Promise.all(PROBE_IPV4.map(tcp)),
    Promise.all(PROBE_IPV6.map(tcp)),
    dns(),
    mode === "offline" ? loopbackRoundTrip() : Promise.resolve(undefined),
  ]);
  const seen = {
    interfaces: Object.entries(networkInterfaces())
      .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal))
      .map(([name]) => name),
    ipv4,
    ipv6,
    dns: resolved,
    dnsMs,
    ...(loopback === undefined ? {} : { loopback }),
  };
  const dnsTimeout = argument("--dns-timeout");
  if (mode === "offline" && dnsTimeout !== undefined) {
    let text = "";
    try {
      text = readFileSync("/etc/resolv.conf", "utf8");
    } catch {
      // No file: the resolvers' defaults, which resolverTimeout("") gives.
    }
    seen.resolver = { timeout: resolverTimeout(text), expected: Number(dnsTimeout) };
  }
  if (mode === "offline" && process.platform === "linux") {
    const expected = process.env["HKN_NO_NETWORK_UID"];
    seen.linux = {
      uid: process.getuid(),
      ...(expected ? { expectedUid: Number(expected) } : {}),
      gid: process.getgid(),
      groups: process.getgroups(),
      capEff: status("CapEff"),
      capPrm: status("CapPrm"),
      noNewPrivs: status("NoNewPrivs"),
    };
  }
  if (mode === "offline" && process.platform === "win32") {
    const expectedSid = argument("--expect-sid");
    seen.windows = {
      ...windowsIdentity(),
      ...(expectedSid ? { expectedSid } : {}),
    };
  }
  if (mode === "offline") {
    // From scripts/without-network.sh or without-network.ps1, which read the
    // list before handing over, so a list lost on the way cannot pass for
    // "nothing required".
    const flag = process.argv.indexOf("--require-env");
    const list = flag === -1 ? (process.env["HKN_NO_NETWORK_REQUIRE_ENV"] ?? "") : (process.argv[flag + 1] ?? "");
    const required = list.split(",").filter(Boolean);
    seen.env = {
      required,
      missing: missingNames(required, process.env),
      offlineMarker: process.env["HOOKNOSTIC_PLAYBACK_NETWORK"] === "none",
      ...(process.platform === "win32"
        ? { forbidden: Object.keys(process.env).filter((name) => FORBIDDEN_NAME.test(name)) }
        : {}),
    };
  }
  return seen;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] === "--offline" ? "offline" : process.argv[2] === "--online" ? "online" : undefined;
  if (!mode) {
    console.error(
      "usage: node scripts/assert-no-network.mjs --offline [--require-env A,B] [--dns-timeout N] [--expect-sid S] | --online",
    );
    process.exit(2);
  }
  const checks = evaluate(mode, await observe(mode));
  for (const { name, ok, detail } of checks)
    console.log(`assert-no-network --${mode}: ${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (checks.some((check) => !check.ok)) {
    console.error(`assert-no-network --${mode}: the network is not in the state this step requires`);
    process.exit(1);
  }
}
