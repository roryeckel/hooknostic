import { describe, expect, it } from "vitest";
import type { AgentPluginProjector } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "./agent-plugin.js";
import type { TargetSpec } from "./adapter.js";

const target: TargetSpec = { id: "test", version: ">=2.1 <3", mode: "plugin", output: "dist" };
const projector: AgentPluginProjector<TargetSpec> = {
  namespace: "example.test",
  profiles: [
    {
      range: ">=2.1 <2.5",
      components: { "agent-plugin.skills": { level: "exact" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.1.0", date: "2026-09-04", method: "captured", what: "first range" }],
      },
    },
    {
      range: ">=2.5 <3",
      components: { "agent-plugin.skills": { level: "approximate", rationale: "loses metadata" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.5.0", date: "2026-09-04", method: "captured", what: "second range" }],
      },
    },
  ],
  async project() {
    return { files: [], issues: [], summary: { components: {}, omissions: [], copiedFileCount: 0 } };
  },
};

describe("resolveAgentPluginProjection", () => {
  it("takes the least capable support across every intersected profile", () => {
    const result = resolveAgentPluginProjection(target, projector);
    expect(result.diagnostics).toEqual([]);
    expect(result.matrix?.["agent-plugin.skills"]).toMatchObject({ level: "approximate" });
  });

  it("rejects version ranges not fully covered by projection evidence", () => {
    const result = resolveAgentPluginProjection({ ...target, version: ">=2 <4" }, projector);
    expect(result.matrix).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "HN203", severity: "error" }));
  });
});
