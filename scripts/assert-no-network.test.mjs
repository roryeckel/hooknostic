// These tests pin the judgement in evaluate() and missingNames(). The probes
// themselves (tcp, DNS) are proven by the --online positive control in CI's
// prepare step: a probe that always reported ENETUNREACH would pass these
// tests and fail there.
import { expect, it } from "vitest";

import { evaluate, missingNames } from "./assert-no-network.mjs";

const unreachable = ["ENETUNREACH", "ENETUNREACH", "ENETUNREACH"];
const isolated = {
  interfaces: [],
  ipv4: unreachable,
  ipv6: "ENETUNREACH",
  dns: "ECONNREFUSED",
  linux: {
    uid: 1001,
    expectedUid: 1001,
    gid: 1001,
    groups: [1001],
    capEff: "0000000000000000",
    capPrm: "0000000000000000",
    noNewPrivs: "1",
  },
  env: { required: ["HOOKNOSTIC_PLAYBACK"], missing: [], offlineMarker: true },
};
const failing = (checks) => checks.filter((check) => !check.ok).map((check) => check.name);

it("accepts a namespace with only loopback, as an unprivileged user with the step's environment", () => {
  expect(failing(evaluate("offline", isolated))).toEqual([]);
  expect(failing(evaluate("offline", { ...isolated, linux: { ...isolated.linux, groups: [] } }))).toEqual([]);
});

it.each([
  ["interfaces", { interfaces: ["eth0"] }],
  // Reachable, or merely unanswered: neither proves the kernel has no route.
  ["public IPv4 connect", { ipv4: ["connected", "ENETUNREACH", "ENETUNREACH"] }],
  ["public IPv4 connect", { ipv4: ["ENETUNREACH", "ENETUNREACH", "TIMEOUT"] }],
  ["public IPv4 connect", { ipv4: ["ENETUNREACH", "ECONNREFUSED", "ENETUNREACH"] }],
  ["public IPv4 connect", { ipv4: [] }],
  ["public IPv6 connect", { ipv6: "connected" }],
  ["DNS lookup", { dns: "resolved" }],
  ["user", { linux: { ...isolated.linux, uid: 0, expectedUid: undefined } }],
  ["user", { linux: { ...isolated.linux, uid: 1002 } }],
  // e.g. `docker`, through which the Docker socket reaches the network.
  ["groups", { linux: { ...isolated.linux, groups: [1001, 27, 999] } }],
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
  const hostNamespace = {
    ...isolated,
    interfaces: ["eth0"],
    ipv4: ["connected", "connected", "connected"],
    ipv6: "ENETUNREACH",
    dns: "resolved",
  };
  expect(failing(evaluate("offline", hostNamespace))).toEqual(["interfaces", "public IPv4 connect", "DNS lookup"]);
});

it("requires one reachable IPv4 target and DNS for --online, never IPv6", () => {
  const online = {
    interfaces: ["eth0"],
    ipv4: ["connected", "connected", "connected"],
    ipv6: "ENETUNREACH",
    dns: "resolved",
  };
  expect(failing(evaluate("online", online))).toEqual([]);
  // One filtered address (or one provider's outage) does not fail a lane.
  expect(failing(evaluate("online", { ...online, ipv4: ["TIMEOUT", "connected", "ECONNREFUSED"] }))).toEqual([]);
  expect(failing(evaluate("online", { ...online, ipv4: unreachable }))).toEqual(["public IPv4 connect (any)"]);
  expect(failing(evaluate("online", { ...online, dns: "EAI_AGAIN" }))).toEqual(["DNS lookup"]);
});

it("counts an empty required variable as missing: it selects nothing, like an absent one", () => {
  const env = { HOOKNOSTIC_PLAYBACK: "", HKN_PLAYBACK_ARTIFACT_DIR: "/tmp/a", HKN_RIPGREP_DIR: "/tmp/r" };
  expect(missingNames(["HOOKNOSTIC_PLAYBACK", "HKN_PLAYBACK_ARTIFACT_DIR", "HKN_RIPGREP_DIR", "UNSET"], env)).toEqual([
    "HOOKNOSTIC_PLAYBACK",
    "UNSET",
  ]);
  expect(missingNames(["HKN_RIPGREP_DIR"], env)).toEqual([]);
});
