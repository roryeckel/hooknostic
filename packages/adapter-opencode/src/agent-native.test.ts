import { describe, expect, it } from "vitest";

import type { AgentDefinition, AgentPluginComponentSupport } from "@hooknostic/agent-plugin";

import { AGENT_STEP_LIMIT_IGNORED, stepLimitDegradations } from "./agent-native.js";

const cell: AgentPluginComponentSupport = {
  level: "exact",
  degradations: [{ id: AGENT_STEP_LIMIT_IGNORED, summary: "Captured child step limit", evidence: ".capture/agents" }],
};
const agent = (native: Record<string, unknown>, mode: AgentDefinition["mode"] = "subagent"): AgentDefinition => ({
  name: "reviewer",
  description: "Review",
  instructions: "Review",
  mode,
  source: "/reviewer.md",
  native: { opencode: native },
});

describe("OpenCode v1 native child caps", () => {
  it.each(["steps", "maxSteps"])("reports requested %s without changing the native fields", (key) => {
    const definition = agent({ [key]: 2, custom_provider_option: "keep" });
    expect(stepLimitDegradations([definition], cell)).toEqual([
      expect.objectContaining({ id: AGENT_STEP_LIMIT_IGNORED, name: "reviewer", reason: expect.stringContaining(key) }),
    ]);
    expect(definition.native["opencode"]).toEqual({ [key]: 2, custom_provider_option: "keep" });
  });
  it("does not claim an uncaptured primary-only limit or degrade an uncapped agent", () => {
    expect(stepLimitDegradations([agent({ steps: 2 }, "primary"), agent({ temperature: 0.2 })], cell)).toEqual([]);
  });
  it("reports both spellings once for an all-mode agent's delegation route", () => {
    expect(stepLimitDegradations([agent({ steps: 2, maxSteps: 2 }, "all")], cell)).toHaveLength(1);
  });
  it("requires a declaring profile, keeping the v2 native route unaffected", () => {
    expect(stepLimitDegradations([agent({ steps: 2 })], { level: "exact" })).toEqual([]);
  });
});
