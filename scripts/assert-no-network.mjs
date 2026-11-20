#!/usr/bin/env node
// Prove, by effect, the network state a playback step relies on.
//
//   node scripts/assert-no-network.mjs --offline
//     Inside scripts/without-network.sh, before the playback command. Fails
//     unless the process has no route out: no non-loopback interface, public
//     IPv4 and IPv6 connects refused by the kernel with ENETUNREACH, DNS
//     failing, running as the expected unprivileged user with no capabilities
//     and no_new_privs, and the step's environment carried in.
//   node scripts/assert-no-network.mjs --online
//     The positive control, run outside the namespace: the same IPv4 connect
//     and DNS lookup must succeed, so --offline cannot pass because the probe
//     itself is broken. IPv6 is reported but never required: hosted runners
//     and many hosts have none.
//
// Prints one line per check, every check, then exits 1 if any failed. Prints
// names of environment variables, never their values.
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

export const PROBE_IPV4 = "1.1.1.1";
export const PROBE_IPV6 = "2606:4700:4700::1111";
export const PROBE_HOST = "github.com";
const TIMEOUT_MS = 5000;

/**
 * Judge what was observed. Pure, so the decision is unit-tested apart from
 * the probes.
 * @param {"offline" | "online"} mode
 * @param {{
 *   interfaces: string[],
 *   ipv4: string,
 *   ipv6: string,
 *   dns: string,
 *   linux?: { uid: number, expectedUid?: number, capEff: string, capPrm: string, noNewPrivs: string },
 *   env?: { required: string[], missing: string[], offlineMarker: boolean },
 * }} seen `ipv4`/`ipv6` are "connected" or an error code; `dns` is "resolved" or an error code;
 *   `interfaces` are the names with a non-internal address.
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function evaluate(mode, seen) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  if (mode === "offline") {
    check(
      "interfaces",
      seen.interfaces.length === 0,
      seen.interfaces.length === 0 ? "loopback only" : `non-loopback: ${seen.interfaces.join(", ")}`,
    );
    check("public IPv4 connect", seen.ipv4 === "ENETUNREACH", `${PROBE_IPV4}:443 -> ${seen.ipv4}`);
    check("public IPv6 connect", seen.ipv6 === "ENETUNREACH", `[${PROBE_IPV6}]:443 -> ${seen.ipv6}`);
    check("DNS lookup", seen.dns !== "resolved", `${PROBE_HOST} -> ${seen.dns}`);
    if (seen.linux) {
      const { uid, expectedUid, capEff, capPrm, noNewPrivs } = seen.linux;
      check(
        "user",
        uid !== 0 && (expectedUid === undefined || uid === expectedUid),
        `uid ${uid}${expectedUid === undefined ? "" : `, expected ${expectedUid}`}`,
      );
      check("capabilities", /^0+$/.test(capEff) && /^0+$/.test(capPrm), `CapEff ${capEff}, CapPrm ${capPrm}`);
      check("no_new_privs", noNewPrivs === "1", `NoNewPrivs ${noNewPrivs}`);
    }
    if (seen.env) {
      check(
        "environment",
        seen.env.offlineMarker && seen.env.missing.length === 0,
        `HOOKNOSTIC_PLAYBACK_NETWORK=none ${seen.env.offlineMarker ? "set" : "missing"}; ` +
          (seen.env.required.length === 0
            ? "no required names"
            : seen.env.missing.length === 0
              ? `present: ${seen.env.required.join(", ")}`
              : `missing: ${seen.env.missing.join(", ")}`),
      );
    }
  } else {
    check("public IPv4 connect", seen.ipv4 === "connected", `${PROBE_IPV4}:443 -> ${seen.ipv4}`);
    check("DNS lookup", seen.dns === "resolved", `${PROBE_HOST} -> ${seen.dns}`);
    // Informational: a host without IPv6 egress is still online.
    check("public IPv6 connect (not required)", true, `[${PROBE_IPV6}]:443 -> ${seen.ipv6}`);
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

async function dns() {
  try {
    await lookup(PROBE_HOST);
    return "resolved";
  } catch (error) {
    return error.code ?? error.message;
  }
}

function status(field) {
  return readFileSync("/proc/self/status", "utf8").match(new RegExp(`^${field}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
}

async function observe(mode) {
  const [ipv4, ipv6, resolved] = await Promise.all([tcp(PROBE_IPV4), tcp(PROBE_IPV6), dns()]);
  const seen = {
    interfaces: Object.entries(networkInterfaces())
      .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal))
      .map(([name]) => name),
    ipv4,
    ipv6,
    dns: resolved,
  };
  if (mode === "offline" && process.platform === "linux") {
    const expected = process.env["HKN_NO_NETWORK_UID"];
    seen.linux = {
      uid: process.getuid(),
      ...(expected ? { expectedUid: Number(expected) } : {}),
      capEff: status("CapEff"),
      capPrm: status("CapPrm"),
      noNewPrivs: status("NoNewPrivs"),
    };
  }
  if (mode === "offline") {
    const required = (process.env["HKN_NO_NETWORK_REQUIRE_ENV"] ?? "").split(",").filter(Boolean);
    seen.env = {
      required,
      missing: required.filter((name) => process.env[name] === undefined),
      offlineMarker: process.env["HOOKNOSTIC_PLAYBACK_NETWORK"] === "none",
    };
  }
  return seen;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] === "--offline" ? "offline" : process.argv[2] === "--online" ? "online" : undefined;
  if (!mode) {
    console.error("usage: node scripts/assert-no-network.mjs --offline | --online");
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
