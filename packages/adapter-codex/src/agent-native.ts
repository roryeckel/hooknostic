import Ajv from "ajv";
import { intersects } from "semver";

import type { AgentDefinition, AgentPluginComponentSupport, AgentPluginDegradation } from "@hooknostic/agent-plugin";
import { servesAsSubagent } from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

import { codexAgentSchemas } from "./agent-native-schema.js";
import { codexAgentSchemaValidation } from "./agent-native-source.js";
import { codexHarness } from "./harness.js";

export const AGENT_FIELD_IGNORED = "agent-field-ignored";
export const DEFAULT_AGENT_FIELD_IGNORED = "default-agent-field-ignored";
export const DEFAULT_AGENT_KEYS = ["model", "model_reasoning_effort"];
const newer = codexAgentSchemaValidation[1]!.version;
const families = [`${codexHarness.recommendedRange} <${newer}`, `${codexHarness.recommendedRange} >=${newer}`];
const validator = new Ajv({
  allErrors: true,
  jsonPointers: true,
  strictNumbers: true,
  formats: {
    uint: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 },
    uint32: {
      type: "number",
      validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
    },
    uint16: { type: "number", validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff },
    uint8: { type: "number", validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xff },
    int32: {
      type: "number",
      validate: (value: number) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff,
    },
    uint64: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 },
    int64: { type: "number", validate: (value: number) => Number.isSafeInteger(value) },
    double: { type: "number", validate: (value: number) => Number.isFinite(value) },
  },
});
const schemas = codexAgentSchemas.map((schema) => validator.compile(schema));

/** A role file uses ConfigToml's shape; accepting its shape is not proof of effect. */
export function validateCodexAgentNative(agent: AgentDefinition, target: TargetSpec): string[] {
  const native = agent.native["codex"];
  if (native === undefined) return [];
  const errors = new Set<string>();
  for (let index = 0; index < schemas.length; index++) {
    if (!intersects(target.version, families[index]!)) continue;
    const validate = schemas[index]!;
    if (validate(native)) continue;
    for (const error of validate.errors ?? []) {
      const key =
        error.keyword === "additionalProperties"
          ? `/${String((error.params as { additionalProperty: string }).additionalProperty)}`
          : "";
      errors.add(
        `native.codex${error.dataPath}${key} ${error.message} (schema ${codexAgentSchemaValidation[index]!.version})`,
      );
    }
  }
  const names = native["nickname_candidates"];
  if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
    const normalized = names.map((name: string) => name.trim());
    if (new Set(normalized).size !== normalized.length)
      errors.add("native.codex.nickname_candidates must not repeat a name after trimming");
  }
  return [...errors];
}

const newerFields = new Set([
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "service_tier",
  "features",
  "skills",
  "nickname_candidates",
]);
const livePolicy = new Set([
  "sandbox_mode",
  "sandbox_workspace_write",
  "approval_policy",
  "approvals_reviewer",
  "permissions",
  "default_permissions",
]);
const disableFeatures = new Set([
  "shell_tool",
  "apps",
  "connectors",
  "plugins",
  "memory_tool",
  "request_permissions_tool",
]);

function ignoredFields(native: Record<string, unknown>, range: string): string[] {
  const result: string[] = [];
  const bounded = intersects(range, families[1]!);
  for (const [key, value] of Object.entries(native)) {
    if (livePolicy.has(key) || (bounded && !newerFields.has(key))) result.push(key);
    else if (bounded && key === "features" && value && typeof value === "object") {
      for (const [feature, enabled] of Object.entries(value))
        if (!disableFeatures.has(feature) || enabled !== false) result.push(`features.${feature}`);
    } else if (bounded && key === "skills" && value && typeof value === "object") {
      for (const [field, setting] of Object.entries(value)) {
        if (field === "config" && Array.isArray(setting)) {
          if (setting.some((entry) => entry.enabled !== false)) result.push("skills.config (enabled entries)");
        } else if (field === "bundled" && setting && typeof setting === "object") {
          if ((setting as { enabled?: unknown }).enabled !== false) result.push("skills.bundled");
        } else if (field !== "include_instructions" || setting !== false) result.push(`skills.${field}`);
      }
    }
  }
  return result;
}

export function codexAgentNativeDegradations(
  agents: readonly AgentDefinition[],
  defaultAgent: string | undefined,
  cell: AgentPluginComponentSupport | undefined,
  range = codexHarness.recommendedRange,
): AgentPluginDegradation[] {
  const result: AgentPluginDegradation[] = [];
  for (const agent of agents) {
    const native = agent.native["codex"] ?? {};
    if (servesAsSubagent(agent.mode) && cell?.degradations?.some((item) => item.id === AGENT_FIELD_IGNORED)) {
      const ignored = ignoredFields(native, range);
      if (ignored.length)
        result.push({
          id: AGENT_FIELD_IGNORED,
          component: "agents.native",
          name: agent.name,
          path: agent.source,
          reason: `agent ${JSON.stringify(agent.name)} sets native.codex ${ignored.join(", ")}, which the validated role route does not apply within the requested range. Child permissions follow the parent; the newer role loader applies only bounded model/instruction settings and supported capability disabling.`,
        });
    }
    if (
      agent.name === defaultAgent &&
      agent.mode === "all" &&
      cell?.degradations?.some((item) => item.id === DEFAULT_AGENT_FIELD_IGNORED)
    ) {
      const ignored = Object.keys(native).filter((key) => !DEFAULT_AGENT_KEYS.includes(key));
      if (ignored.length)
        result.push({
          id: DEFAULT_AGENT_FIELD_IGNORED,
          component: "agents.native",
          name: agent.name,
          path: agent.source,
          reason: `default agent ${JSON.stringify(agent.name)} applies only its instructions, model and model_reasoning_effort to the session; native.codex ${ignored.join(", ")} are carried only by its subagent file.`,
        });
    }
  }
  return result;
}
