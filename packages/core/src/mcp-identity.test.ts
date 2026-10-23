import { describe, expect, it } from "vitest";

import type { McpIdentitySupport } from "./adapter.js";
import { mcpIdentityApplies, statedMcpEvents } from "./mcp-identity.js";

const statement: McpIdentitySupport = {
  source: "statement",
  events: ["tool.after", "tool.error"],
  range: ">=4 <5",
  rationale: "fake harness",
  evidence: "fixtures/fake",
};

describe("statedMcpEvents", () => {
  it("names a statement's events for a range or build within its evidence", () => {
    expect(statedMcpEvents(statement, ">=4 <5")).toEqual(["tool.after", "tool.error"]);
    expect(statedMcpEvents(statement, ">=4.2 <4.3")).toEqual(["tool.after", "tool.error"]);
    expect(statedMcpEvents(statement, "4.1.0")).toEqual(["tool.after", "tool.error"]);
  });

  it("names none where the range only overlaps the evidence, or misses it", () => {
    expect(statedMcpEvents(statement, ">=3 <5")).toEqual([]);
    expect(statedMcpEvents(statement, ">=3 <4")).toEqual([]);
    expect(statedMcpEvents(statement, "not a range")).toEqual([]);
    expect(mcpIdentityApplies(statement, ">=3 <5")).toBe(false);
  });

  it("names none for a name or none source, or no declaration", () => {
    expect(statedMcpEvents(undefined, ">=4 <5")).toEqual([]);
    expect(statedMcpEvents({ ...statement, source: "name" }, ">=4 <5")).toEqual([]);
    expect(statedMcpEvents({ ...statement, source: "none" }, ">=4 <5")).toEqual([]);
  });

  it("holds everywhere for a statement without a range", () => {
    const { range: _range, ...unbounded } = statement;
    expect(mcpIdentityApplies(unbounded, ">=1 <99")).toBe(true);
    expect(statedMcpEvents(unbounded, "0.1.0")).toEqual(["tool.after", "tool.error"]);
  });
});
