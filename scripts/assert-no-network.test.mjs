import { expect, it } from "vitest";

import { evaluate } from "./assert-no-network.mjs";

const isolated = {
  interfaces: [],
  ipv4: "ENETUNREACH",
  ipv6: "ENETUNREACH",
  dns: "ECONNREFUSED",
  linux: { uid: 1001, expectedUid: 1001, capEff: "0000000000000000", capPrm: "0000000000000000", noNewPrivs: "1" },
  env: { required: ["HOOKNOSTIC_PLAYBACK"], missing: [], offlineMarker: true },
};
const failing = (checks) => checks.filter((check) => !check.ok).map((check) => check.name);

it("accepts a namespace with only loopback, as an unprivileged user with the step's environment", () => {
  expect(failing(evaluate("offline", isolated))).toEqual([]);
});

it.each([
  ["interfaces", { interfaces: ["eth0"] }],
  // Reachable, or merely unanswered: neither proves the kernel has no route.
  ["public IPv4 connect", { ipv4: "connected" }],
  ["public IPv4 connect", { ipv4: "TIMEOUT" }],
  ["public IPv4 connect", { ipv4: "ECONNREFUSED" }],
  ["public IPv6 connect", { ipv6: "connected" }],
  ["DNS lookup", { dns: "resolved" }],
  ["user", { linux: { ...isolated.linux, uid: 0, expectedUid: undefined } }],
  ["user", { linux: { ...isolated.linux, uid: 1002 } }],
  ["capabilities", { linux: { ...isolated.linux, capEff: "000001ffffffffff" } }],
  ["capabilities", { linux: { ...isolated.linux, capPrm: "0000000000200000" } }],
  ["no_new_privs", { linux: { ...isolated.linux, noNewPrivs: "0" } }],
  ["environment", { env: { ...isolated.env, missing: ["HOOKNOSTIC_PLAYBACK"] } }],
  ["environment", { env: { ...isolated.env, offlineMarker: false } }],
])("rejects --offline when %s shows a way out (%j)", (name, change) => {
  expect(failing(evaluate("offline", { ...isolated, ...change }))).toEqual([name]);
});

it("names a dropped --net by both the interface and the connect checks", () => {
  // What scripts/without-network.sh without `--net` looks like from inside.
  const hostNamespace = { ...isolated, interfaces: ["eth0"], ipv4: "connected", ipv6: "ENETUNREACH", dns: "resolved" };
  expect(failing(evaluate("offline", hostNamespace))).toEqual(["interfaces", "public IPv4 connect", "DNS lookup"]);
});

it("requires IPv4 and DNS for --online, never IPv6", () => {
  const online = { interfaces: ["eth0"], ipv4: "connected", ipv6: "ENETUNREACH", dns: "resolved" };
  expect(failing(evaluate("online", online))).toEqual([]);
  expect(failing(evaluate("online", { ...online, ipv4: "ENETUNREACH" }))).toEqual(["public IPv4 connect"]);
  expect(failing(evaluate("online", { ...online, dns: "EAI_AGAIN" }))).toEqual(["DNS lookup"]);
});
