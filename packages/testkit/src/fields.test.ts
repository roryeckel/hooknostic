import { describe, expect, it } from "vitest";

import type { AdapterRegistry, CapabilityProfile } from "@hooknostic/core";
import { analyzeCapabilities, buildPluginIR, resolveCapabilityMatrix } from "@hooknostic/core";
import type { HooknosticConfig } from "@hooknostic/sdk";
import { definePlugin, hook, hooknosticConfigSchema } from "@hooknostic/sdk";

import { makeFakeAdapter, syntheticSource } from "./fake-adapter.js";

// ADR-0027: field-level fidelity. One fake harness sends everything, one
// derives the turn's fields, one never produces them.
const full: CapabilityProfile = {
  range: ">=1.0 <2",
  source: syntheticSource(),
  matrix: { "turn.stop.observe": { level: "exact" }, "prompt.before.observe": { level: "exact" } },
  fields: { "turn.stop.lastMessage": { level: "exact" }, "turn.stop.correlation.turnId": { level: "exact" } },
};
const derived: CapabilityProfile = {
  range: ">=1.0 <2",
  source: syntheticSource(),
  matrix: { "turn.stop.observe": { level: "exact" } },
  fields: {
    "turn.stop.lastMessage": { level: "emulated", rationale: "read back from the session" },
    "turn.stop.correlation.turnId": { level: "approximate", rationale: "the newest prompt, not the turn's" },
  },
};
const bare: CapabilityProfile = {
  range: ">=1.0 <2",
  source: syntheticSource(),
  matrix: { "turn.stop.observe": { level: "exact" } },
};

function registry(): AdapterRegistry {
  return {
    full: makeFakeAdapter({ id: "full", profiles: [full] }),
    derived: makeFakeAdapter({ id: "derived", profiles: [derived] }),
    bare: makeFakeAdapter({ id: "bare", profiles: [bare] }),
  };
}

function config(overrides: Partial<Pick<HooknosticConfig, "compatibility">> = {}, targetAccept?: string[]) {
  const target = (id: string) => ({ version: ">=1.0 <2", delivery: "package" as const, output: `./dist/${id}` });
  return {
    entry: "./src/hooks.ts",
    targets: {
      full: target("full"),
      derived: target("derived"),
      bare: {
        ...target("bare"),
        ...(targetAccept ? { compatibility: { accept: targetAccept as `${string}:turn.stop.lastMessage`[] } } : {}),
      },
    },
    ...overrides,
  } satisfies HooknosticConfig;
}

function ir(fields?: string[]) {
  const result = buildPluginIR(
    definePlugin({
      name: "fields",
      hooks: [
        hook("turn.stop", {
          id: "summarize",
          ...(fields ? { fields: fields as ("lastMessage" | "correlation.turnId")[] } : {}),
          run() {},
        }),
      ],
    }),
  );
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}

const hn108 = (analysis: ReturnType<typeof analyzeCapabilities>, target: string) =>
  analysis.targets[target]!.diagnostics.filter((d) => d.code === "HN108");

describe("event field fidelity (ADR-0027)", () => {
  it("fails where a declared field is never produced, and says how to accept it", () => {
    const analysis = analyzeCapabilities(ir(["lastMessage"]), config(), registry());
    expect(hn108(analysis, "full")).toEqual([]);
    expect(analysis.targets.bare?.ok).toBe(false);
    expect(hn108(analysis, "bare")).toEqual([
      expect.objectContaining({
        severity: "error",
        hookId: "summarize",
        field: "turn.stop.lastMessage",
        target: "bare",
        support: "unsupported",
      }),
    ]);
    expect(hn108(analysis, "bare")[0]?.remediation).toContain('"bare:turn.stop.lastMessage"');
    expect(analysis.targets.bare?.fields).toEqual([
      {
        id: "bare:turn.stop.lastMessage",
        hookId: "summarize",
        field: "turn.stop.lastMessage",
        support: "unsupported",
        accepted: false,
      },
    ]);
  });

  it("reports a derived field as information at or above the floor, and by policy below it", () => {
    const analysis = analyzeCapabilities(ir(["lastMessage", "correlation.turnId"]), config(), registry());
    expect(hn108(analysis, "derived").map((d) => [d.field, d.severity, d.rationale])).toEqual([
      ["turn.stop.lastMessage", "info", "read back from the session"],
      ["turn.stop.correlation.turnId", "error", "the newest prompt, not the turn's"],
    ]);
    const relaxed = analyzeCapabilities(
      ir(["correlation.turnId"]),
      config({ compatibility: { minimum: "approximate" } }),
      registry(),
    );
    expect(hn108(relaxed, "derived").map((d) => d.severity)).toEqual(["info"]);
    const warned = analyzeCapabilities(
      ir(["correlation.turnId"]),
      config({ compatibility: { onBelowMinimum: "warn" } }),
      registry(),
    );
    expect(hn108(warned, "derived").map((d) => d.severity)).toEqual(["warn"]);
  });

  it("downgrades an accepted shortfall to information and records it as accepted", () => {
    for (const cfg of [
      config({ compatibility: { accept: ["bare:turn.stop.lastMessage"] } }),
      config({}, ["bare:turn.stop.lastMessage"]),
    ]) {
      const analysis = analyzeCapabilities(ir(["lastMessage"]), cfg, registry());
      expect(analysis.ok).toBe(true);
      expect(hn108(analysis, "bare").map((d) => d.severity)).toEqual(["info"]);
      expect(analysis.targets.bare?.fields[0]?.accepted).toBe(true);
    }
  });

  it("refuses an acceptance that names nothing below exact", () => {
    for (const accepted of ["full:turn.stop.lastMessage", "nobody:turn.stop.lastMessage"]) {
      const analysis = analyzeCapabilities(
        ir(),
        config({ compatibility: { accept: [accepted as never] } }),
        registry(),
      );
      expect(analysis.ok).toBe(false);
      expect(analysis.diagnostics).toEqual([
        expect.objectContaining({ code: "HN501", severity: "error", message: expect.stringContaining(accepted) }),
      ]);
    }
    // Per target, the id must name that target's own adapter.
    const analysis = analyzeCapabilities(ir(), config({}, ["derived:turn.stop.lastMessage"]), registry());
    expect(analysis.targets.bare?.ok).toBe(false);
    expect(analysis.targets.bare?.diagnostics.map((d) => d.code)).toEqual(["HN501"]);
  });

  it("checks nothing for a hook that declares no fields", () => {
    const analysis = analyzeCapabilities(ir(), config(), registry());
    expect(analysis.ok).toBe(true);
    expect(analysis.diagnostics.filter((d) => d.code === "HN108")).toEqual([]);
  });

  it("reports no field where the event itself is unavailable", () => {
    const plugin = buildPluginIR(
      definePlugin({
        name: "p",
        hooks: [hook("prompt.before", { id: "p", fields: ["correlation.turnId"], run() {} })],
      }),
    ).ir!;
    const analysis = analyzeCapabilities(plugin, config(), registry());
    expect(analysis.targets.bare?.diagnostics.map((d) => d.code)).toEqual(["HN202"]);
    expect(hn108(analysis, "full").map((d) => d.field)).toEqual(["prompt.before.correlation.turnId"]);
  });

  it("resolves several profiles to the least capable field level", () => {
    const later: CapabilityProfile = { ...full, range: ">=2.0 <3" };
    const resolved = resolveCapabilityMatrix("x", [derived, later], ">=1.5 <2.5");
    expect(resolved.fields).toEqual(derived.fields);
    const absent = resolveCapabilityMatrix("x", [bare, later], ">=1.5 <2.5");
    expect(absent.fields).toEqual({});
  });

  it("canonicalizes field keys and rejects fields of another event", () => {
    const def = hook("turn.stop", { id: "t", fields: ["lastMessage", "turn.stop.correlation.turnId"], run() {} });
    expect(def.fields).toEqual(["turn.stop.lastMessage", "turn.stop.correlation.turnId"]);
    expect(() => hook("turn.stop", { id: "t", fields: ["lastMessage", "turn.stop.lastMessage"], run() {} })).toThrow(
      /declares field "turn.stop.lastMessage" twice/,
    );
    const foreign = buildPluginIR(
      definePlugin({
        name: "p",
        hooks: [hook("turn.stop", { id: "t", fields: ["agent.stop.lastMessage" as "lastMessage"], run() {} })],
      }),
    );
    expect(foreign.diagnostics).toEqual([
      expect.objectContaining({ code: "HN501", hookId: "t", field: "agent.stop.lastMessage" }),
    ]);
    const unknown = buildPluginIR(
      definePlugin({
        name: "p",
        hooks: [hook("turn.stop", { id: "t", fields: ["lastMesage" as "lastMessage"], run() {} })],
      }),
    );
    expect(unknown.diagnostics.map((d) => d.code)).toEqual(["HN501"]);
  });

  it("validates the spelling of an acceptance in the config schema", () => {
    const parse = (accept: string[]) =>
      hooknosticConfigSchema.safeParse({ entry: "h.ts", compatibility: { accept }, targets: {} }).success;
    expect(parse(["opencode:turn.stop.lastMessage"])).toBe(true);
    expect(parse(["opencode:turn.stop.lastMesage"])).toBe(false);
    expect(parse(["turn.stop.lastMessage"])).toBe(false);
    expect(parse(["Open Code:turn.stop.lastMessage"])).toBe(false);
  });
});
