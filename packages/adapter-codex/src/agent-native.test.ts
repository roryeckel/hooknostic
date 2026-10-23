import { describe, expect, it } from "vitest";

import type { AgentDefinition, AgentPluginComponentSupport } from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

import {
  AGENT_FIELD_IGNORED,
  codexAgentNativeDegradations,
  DEFAULT_AGENT_FIELD_IGNORED,
  validateCodexAgentNative,
} from "./agent-native.js";
import { codexAgentSchemaValidation } from "./agent-native-source.js";
import { codexHarness } from "./harness.js";
import { projectComponentProfiles } from "./project.js";

const recent = codexAgentSchemaValidation[1]!.version;
const cell: AgentPluginComponentSupport = projectComponentProfiles[0]!.components["agents.native"]!;
const agent = (native: Record<string, unknown>, mode: AgentDefinition["mode"] = "subagent"): AgentDefinition => ({
  name: "reviewer",
  description: "Review changes",
  instructions: "Review changes.",
  mode,
  native: { codex: native },
  source: "/source/reviewer.md",
});
const target = (version = codexHarness.recommendedRange): TargetSpec => ({
  id: "codex",
  version,
  delivery: "project",
  output: "dist/codex",
});

describe("Codex native agent contract", () => {
  it("validates supported model settings without changing their values", () => {
    const definition = agent({
      model: "local-model",
      model_reasoning_effort: "provider-specific",
      model_reasoning_summary: "concise",
      model_verbosity: "low",
      personality: "pragmatic",
      service_tier: "default",
      nickname_candidates: ["Reader One"],
      features: { shell_tool: false, connectors: false },
      skills: { include_instructions: false },
    });
    const original = structuredClone(definition);
    expect(validateCodexAgentNative(definition, target())).toEqual([]);
    expect(codexAgentNativeDegradations([definition], undefined, cell)).toEqual([]);
    expect(definition).toEqual(original);
  });

  it.each([
    { hooknostic_unknown_key: true },
    { model: 3 },
    { model: null },
    { model_reasoning_effort: "" },
    { model_reasoning_effort: false },
    { model_reasoning_summary: "verbose" },
    { model_verbosity: "extreme" },
    { sandbox_mode: "readonly" },
    { approval_policy: "sometimes" },
    { model_provider: true },
    { skills: { max_context_tokens: -1 } },
    { model_context_window: 1.5 },
    { model_context_window: Infinity },
    { model_context_window: Number.MAX_SAFE_INTEGER + 1 },
    { features: { unknown_feature: false } },
    { features: { shell_tool: "no" } },
    { skills: { config: [{ path: "/skill", enabled: "no" }] } },
    { sandbox_workspace_write: { writable_roots: [42] } },
    { shell_environment_policy: { typo: true } },
    { nickname_candidates: [] },
    { nickname_candidates: [" "] },
    { nickname_candidates: ["A", " A "] },
    { nickname_candidates: ["a/b"] },
  ])("refuses invalid authoring input %j", (native) => {
    expect(validateCodexAgentNative(agent(native), target()).length).toBeGreaterThan(0);
  });

  it("uses every schema family covered by the requested range", () => {
    const definition = agent({ allow_symlinked_codex_home: true });
    expect(validateCodexAgentNative(definition, target(recent))).toEqual([]);
    expect(validateCodexAgentNative(definition, target(codexHarness.referenceVersion)).length).toBeGreaterThan(0);
    expect(validateCodexAgentNative(definition, target()).length).toBeGreaterThan(0);
    const referenceOnly = agent({ experimental_thread_config_endpoint: "http://127.0.0.1/" });
    expect(validateCodexAgentNative(referenceOnly, target(codexHarness.referenceVersion))).toEqual([]);
    expect(validateCodexAgentNative(referenceOnly, target(recent)).length).toBeGreaterThan(0);
    expect(validateCodexAgentNative(referenceOnly, target()).length).toBeGreaterThan(0);
  });

  it.each(["sandbox_mode", "approval_policy", "permissions"])(
    "reports an inherited %s policy without discarding it",
    (field) => {
      const definition = agent({
        [field]: field === "sandbox_mode" ? "read-only" : field === "approval_policy" ? "never" : {},
      });
      expect(codexAgentNativeDegradations([definition], undefined, cell, codexHarness.referenceVersion)).toEqual([
        expect.objectContaining({ id: AGENT_FIELD_IGNORED, name: "reviewer", reason: expect.stringContaining(field) }),
      ]);
      expect(definition.native["codex"]).toHaveProperty(field);
    },
  );

  it("reports newer bounded role fields, feature enabling and ignored skill settings", () => {
    const definition = agent({
      model_provider: "custom",
      web_search: "disabled",
      features: { shell_tool: true, multi_agent: false },
      skills: { include_instructions: true, config: [{ path: "/skill", enabled: true }], max_context_tokens: 10 },
    });
    expect(codexAgentNativeDegradations([definition], undefined, cell, codexHarness.referenceVersion)).toEqual([]);
    const report = codexAgentNativeDegradations([definition], undefined, cell, recent);
    expect(report).toHaveLength(1);
    for (const field of [
      "model_provider",
      "web_search",
      "features.shell_tool",
      "features.multi_agent",
      "skills.include_instructions",
      "skills.config",
      "skills.max_context_tokens",
    ])
      expect(report[0]!.reason).toContain(field);
  });

  it("reports extra fields on the primary side of an all-mode default", () => {
    const definition = agent({ model: "local-model", model_reasoning_effort: "low", personality: "friendly" }, "all");
    expect(codexAgentNativeDegradations([definition], "reviewer", cell, recent)).toEqual([
      expect.objectContaining({ id: DEFAULT_AGENT_FIELD_IGNORED, reason: expect.stringContaining("personality") }),
    ]);
    expect(codexAgentNativeDegradations([definition], undefined, cell, recent)).toEqual([]);
    expect(codexAgentNativeDegradations([agent({ sandbox_mode: "read-only" }, "primary")], "reviewer", cell)).toEqual(
      [],
    );
  });

  it("does not report fields absent from a profile's declarations", () => {
    expect(codexAgentNativeDegradations([agent({ sandbox_mode: "read-only" })], undefined, { level: "exact" })).toEqual(
      [],
    );
  });
});
