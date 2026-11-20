#!/usr/bin/env node
// Prove, by effect, the network state a playback step relies on.
//
//   node scripts/assert-no-network.mjs --offline [--require-env A,B]
//     Inside scripts/without-network.sh, before the playback command. Fails
//     unless the process has no route out:
//       - no non-loopback interface;
//       - every public IPv4 probe and the IPv6 probe refused by the kernel
//         with ENETUNREACH;
//       - DNS failing;
//       - the expected unprivileged user, with no supplementary groups, no
//         capabilities and no_new_privs;
//       - every required variable present and non-empty.
//   node scripts/assert-no-network.mjs --online
//     The positive control, run outside the namespace. At least one IPv4
//     probe and the DNS lookup must succeed, so --offline cannot pass because
//     the probe itself is broken. Several targets, so one filtered address
//     does not fail a lane. IPv6 is reported but never required: hosted
//     runners have none.
//
// Prints one line per check, every check, then exits 1 if any failed. Prints
// names of environment variables, never their values.
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

/** Public anycast resolvers that also listen on 443 (DNS over HTTPS). */
export const PROBE_IPV4 = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];
export const PROBE_IPV6 = "2606:4700:4700::1111";
export const PROBE_HOST = "github.com";
const TIMEOUT_MS = 5000;

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

/**
 * Judge what was observed. Pure, so the decision is unit-tested apart from
 * the probes; only the --online control proves the probes themselves.
 * @param {"offline" | "online"} mode
 * @param {{
 *   interfaces: string[],
 *   ipv4: string[],
 *   ipv6: string,
 *   dns: string,
 *   linux?: { uid: number, expectedUid?: number, gid: number, groups: number[], capEff: string, capPrm: string, noNewPrivs: string },
 *   env?: { required: string[], missing: string[], offlineMarker: boolean },
 * }} seen `ipv4` holds one result per PROBE_IPV4 address, and `ipv6` one
 *   result: "connected" or an error code. `dns` is "resolved" or an error
 *   code. `interfaces` names those with a non-internal address.
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function evaluate(mode, seen) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const v4 = seen.ipv4.map((result, index) => `${PROBE_IPV4[index] ?? "?"}:443 -> ${result}`).join(", ");
  if (mode === "offline") {
    check(
      "interfaces",
      seen.interfaces.length === 0,
      seen.interfaces.length === 0 ? "loopback only" : `non-loopback: ${seen.interfaces.join(", ")}`,
    );
    check("public IPv4 connect", seen.ipv4.length > 0 && seen.ipv4.every((result) => result === "ENETUNREACH"), v4);
    check("public IPv6 connect", seen.ipv6 === "ENETUNREACH", `[${PROBE_IPV6}]:443 -> ${seen.ipv6}`);
    check("DNS lookup", seen.dns !== "resolved", `${PROBE_HOST} -> ${seen.dns}`);
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
      check(
        "environment",
        seen.env.offlineMarker && seen.env.missing.length === 0,
        `HOOKNOSTIC_PLAYBACK_NETWORK=none ${seen.env.offlineMarker ? "set" : "missing"}; ` +
          (seen.env.required.length === 0
            ? "no required names"
            : seen.env.missing.length === 0
              ? `present: ${seen.env.required.join(", ")}`
              : `missing or empty: ${seen.env.missing.join(", ")}`),
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
  const [ipv4, ipv6, resolved] = await Promise.all([Promise.all(PROBE_IPV4.map(tcp)), tcp(PROBE_IPV6), dns()]);
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
      gid: process.getgid(),
      groups: process.getgroups(),
      capEff: status("CapEff"),
      capPrm: status("CapPrm"),
      noNewPrivs: status("NoNewPrivs"),
    };
  }
  if (mode === "offline") {
    // From scripts/without-network.sh, which read the list before the sudo
    // hop, so a list lost in that hop cannot pass for "nothing required".
    const flag = process.argv.indexOf("--require-env");
    const list = flag === -1 ? (process.env["HKN_NO_NETWORK_REQUIRE_ENV"] ?? "") : (process.argv[flag + 1] ?? "");
    const required = list.split(",").filter(Boolean);
    seen.env = {
      required,
      missing: missingNames(required, process.env),
      offlineMarker: process.env["HOOKNOSTIC_PLAYBACK_NETWORK"] === "none",
    };
  }
  return seen;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] === "--offline" ? "offline" : process.argv[2] === "--online" ? "online" : undefined;
  if (!mode) {
    console.error("usage: node scripts/assert-no-network.mjs --offline [--require-env A,B] | --online");
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
