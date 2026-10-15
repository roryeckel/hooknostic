import { describe, expect, it } from "vitest";

import type { HarnessAdapter } from "@hooknostic/core";

import { assertComponentShortfalls } from "./component-shortfalls.js";

type Profile = NonNullable<HarnessAdapter["projectComponentProfiles"]>[number];
type Cell = NonNullable<Profile["components"]["agent-plugin.mcp.stdio"]>;
const declaration = { id: "known-shortfall", summary: "A synthetic shortfall.", evidence: "synthetic" };
const kinds = ["omission", "deviation", "degradation"] as const;
type Kind = (typeof kinds)[number];

function cell(kind: Kind): Cell {
  return {
    level: kind === "omission" ? "unsupported" : "exact",
    ...(kind === "omission" ? { omission: { ...declaration } } : { [`${kind}s`]: [{ ...declaration }] }),
  };
}

function profile(components: Profile["components"], range = ">=1 <2"): Profile {
  return {
    range,
    components,
    source: {
      date: "2026-01-01",
      validatedOn: [
        { version: "1.0.0", date: "2026-01-01", method: "doc-derived", artifact: "synthetic", what: "test" },
      ],
    },
  };
}

function adapter(packageProfiles: Profile[], projectProfiles: Profile[]) {
  return {
    agentPluginProjector: {
      namespace: "test",
      profiles: packageProfiles,
      async project(): Promise<never> {
        throw new Error("Not used by declaration validation.");
      },
    },
    projectComponentProfiles: projectProfiles,
  };
}

describe("adapter-wide component shortfall IDs", () => {
  it.each(kinds)("rejects an omission ID reused by a %s on another component", (kind) => {
    const value = profile({ "agent-plugin.mcp.stdio": cell("omission"), "agent-plugin.mcp.sse": cell(kind) });
    expect(() => assertComponentShortfalls(adapter([value], []))).toThrow(/known-shortfall/);
  });

  it.each(kinds)("rejects reuse across package and project profiles (%s first)", (kind) => {
    const first = profile({ "agent-plugin.mcp.stdio": cell(kind) });
    const second = profile({ "agent-plugin.mcp.sse": cell("omission") });
    expect(() => assertComponentShortfalls(adapter([first], [second]))).toThrow(/known-shortfall/);
  });

  it("rejects reuse for another shortfall kind on the same component", () => {
    const first = profile({ "agent-plugin.mcp.stdio": cell("omission") });
    const second = profile({ "agent-plugin.mcp.stdio": cell("deviation") }, ">=2 <3");
    expect(() => assertComponentShortfalls(adapter([first, second], []))).toThrow(/known-shortfall/);
  });

  it("rejects a shared ID between a deviation and a degradation", () => {
    const value = profile({ "agent-plugin.mcp.stdio": cell("deviation"), "agent-plugin.skills": cell("degradation") });
    expect(() => assertComponentShortfalls(adapter([], [value]))).toThrow(/known-shortfall/);
  });

  it("allows the same omission on its component across versions and deliveries", () => {
    const first = profile({ "agent-plugin.mcp.stdio": cell("omission") });
    const later = profile({ "agent-plugin.mcp.stdio": cell("omission") }, ">=2 <3");
    expect(() => assertComponentShortfalls(adapter([first, later], [first, later]))).not.toThrow();
  });

  it("keeps shared deviation facts valid across MCP transports", () => {
    const value = profile({ "agent-plugin.mcp.stdio": cell("deviation"), "agent-plugin.mcp.sse": cell("deviation") });
    expect(() => assertComponentShortfalls(adapter([value], [value]))).not.toThrow();
  });
});
