import type {
  AgentDefinition,
  AgentPluginComponentSupport,
  AgentPluginDegradation,
  AgentPluginIssue,
} from "@hooknostic/agent-plugin";
import { isJsonObject } from "@hooknostic/agent-plugin";

import { primaryModelDegradations } from "../project.js";

/** Captured on both project and package routes in .capture/agents/native-v2.mjs. */
export const AGENT_REQUEST_IGNORED = "agent-request-ignored";

// Reference schemas: ConfigAgent.Info, ConfigModel.Selection, ConfigProvider.Request,
// Permission.Rule. The package probe verifies the corresponding runtime translation.
const KEYS = new Set(["model", "request", "hidden", "color", "steps", "disabled", "permissions"]);
const modelPattern = /^[^/#]+\/[^#]+(?:#[^#]+)?$/;
const ownKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function modelReference(value: unknown): Record<string, string> | undefined {
  if (typeof value === "string") {
    if (!modelPattern.test(value)) return undefined;
    const slash = value.indexOf("/");
    const [id, variant] = value.slice(slash + 1).split("#");
    return { providerID: value.slice(0, slash), id: id!, ...(variant === undefined ? {} : { variant }) };
  }
  if (!isJsonObject(value) || !ownKeys(value, ["providerID", "model", "variant"])) return undefined;
  const { providerID, model, variant } = value;
  if (
    typeof providerID !== "string" ||
    !/^[^/#]+$/.test(providerID) ||
    typeof model !== "string" ||
    !/^[^#]+$/.test(model)
  )
    return undefined;
  if (variant !== undefined && (typeof variant !== "string" || !/^[^#]+$/.test(variant))) return undefined;
  return { providerID, id: model, ...(variant === undefined ? {} : { variant }) };
}

function json(value: unknown, parents = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value)) return false;
  parents.add(value);
  const valid =
    (Array.isArray(value) || isJsonObject(value)) && Object.values(value).every((child) => json(child, parents));
  parents.delete(value);
  return valid;
}

/** Validate native configuration and lower its model selection to Agent.Info's reference. */
export function packageAgentNative(agent: AgentDefinition): { agent: AgentDefinition; issues: AgentPluginIssue[] } {
  const native = agent.native["opencode"];
  if (native === undefined) return { agent, issues: [] };
  const fields: Record<string, unknown> = {};
  const issues: AgentPluginIssue[] = [];
  const invalid = (key: string, expected: string) =>
    issues.push({
      severity: "error",
      scope: "agent",
      component: "agents.native",
      path: agent.source,
      message: `agent ${JSON.stringify(agent.name)}: native.opencode.${key} ${expected}`,
    });
  for (const [key, value] of Object.entries(native)) {
    if (!KEYS.has(key)) {
      invalid(key, "is not a supported OpenCode v2 agent configuration field");
      continue;
    }
    if (key === "model") {
      const model = modelReference(value);
      if (model === undefined) invalid(key, "must be provider/model[#variant] or { providerID, model, variant? }");
      else fields[key] = model;
      continue;
    }
    let valid = false;
    if (key === "hidden" || key === "disabled") valid = typeof value === "boolean";
    if (key === "color") valid = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
    if (key === "steps") valid = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (key === "request")
      valid =
        isJsonObject(value) &&
        ownKeys(value, ["headers", "body"]) &&
        (value["headers"] === undefined ||
          (isJsonObject(value["headers"]) &&
            Object.values(value["headers"]).every((header) => typeof header === "string"))) &&
        (value["body"] === undefined || (isJsonObject(value["body"]) && json(value["body"])));
    if (key === "permissions")
      valid =
        Array.isArray(value) &&
        value.every(
          (rule) =>
            isJsonObject(rule) &&
            ownKeys(rule, ["action", "resource", "effect"]) &&
            typeof rule["action"] === "string" &&
            typeof rule["resource"] === "string" &&
            typeof rule["effect"] === "string" &&
            ["allow", "ask", "deny"].includes(rule["effect"]),
        );
    if (valid) fields[key] = value;
    else invalid(key, `has an invalid value for the OpenCode v2 ${key} field`);
  }
  return { agent: { ...agent, native: { ...agent.native, opencode: fields } }, issues };
}

export function nativeAgentDegradations(
  agents: readonly AgentDefinition[],
  cell: AgentPluginComponentSupport | undefined,
): AgentPluginDegradation[] {
  const active = agents.filter((agent) => agent.native["opencode"]?.["disabled"] !== true);
  const result = primaryModelDegradations(active, cell);
  if (!cell?.degradations?.some((item) => item.id === AGENT_REQUEST_IGNORED)) return result;
  for (const agent of active) {
    const request = agent.native["opencode"]?.["request"];
    if (
      !isJsonObject(request) ||
      ![request["headers"], request["body"]].some((map) => isJsonObject(map) && Object.keys(map).length > 0)
    )
      continue;
    result.push({
      id: AGENT_REQUEST_IGNORED,
      component: "agents.native",
      name: agent.name,
      path: agent.source,
      reason: `agent ${JSON.stringify(agent.name)} sets native.opencode.request, which OpenCode preserves on the agent but does not send in model requests on the validated build; use provider or model request configuration instead.`,
    });
  }
  return result;
}

/** Runtime half: preserve host defaults, append rules, and expand home on the consuming host. */
export const packageAgentTranslation = `const agentRule = (rule) => {
  if (!["external_directory", "read", "edit"].includes(rule.action)) return rule;
  const home = homedir();
  const resource = rule.resource;
  const relative = resource.startsWith("~/") ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\\\") ? resource.slice(6) : undefined;
  return { ...rule, resource: resource === "~" || resource === "$HOME" ? home
    : relative === undefined ? resource : (posix.isAbsolute(home) ? posix : win32).join(home, relative) };
};
const registerAgent = (editor, definition) => {
  const { native, ...core } = definition;
  if (native.disabled === true) { editor.remove(core.id); return; }
  editor.update(core.id, agent => {
    Object.assign(agent, core);
    for (const key of ["model", "hidden", "color", "steps"]) if (native[key] !== undefined) agent[key] = native[key];
    if (native.request !== undefined) {
      Object.assign(agent.request.headers, native.request.headers ?? {});
      Object.assign(agent.request.body, native.request.body ?? {});
    }
    if (native.permissions !== undefined) agent.permissions.push(...native.permissions.map(agentRule));
  });
};`;
