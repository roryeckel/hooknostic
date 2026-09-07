import semver from "semver";
import {
  AGENT_PLUGIN_COMPONENT_IDS,
  type AgentPluginComponentId,
  type AgentPluginComponentSupport,
  type AgentPluginIssue,
  type AgentPluginPackage,
  type AgentPluginProjectionProfile,
  type AgentPluginProjector,
  type AgentPluginRuntimePackage,
} from "@hooknostic/agent-plugin";
import { leastCapable } from "@hooknostic/sdk";
import type { HarnessAdapter, TargetSpec } from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";
import { isRangeFullyCovered } from "./matrix.js";

export interface AgentPluginProjectionResolution {
  matrix?: Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>>;
  profilesUsed: AgentPluginProjectionProfile[];
  diagnostics: Diagnostic[];
}

export interface AgentPluginIssueDiagnosticOptions {
  target?: string;
  /**
   * Severity for load-time issues the loader recovers from by skipping a
   * component. The loader stays lenient for library consumers; a build treats
   * a skipped component as an authoring error unless demoted to `"warn"`.
   */
  onInvalid?: "error" | "warn";
}

export function diagnosticsFromAgentPluginIssues(
  issues: readonly AgentPluginIssue[],
  options: string | AgentPluginIssueDiagnosticOptions = {},
): Diagnostic[] {
  const { target, onInvalid } = typeof options === "string" ? { target: options } : options;
  return issues.map((problem) => ({
    code: problem.scope === "projection" && problem.component !== undefined ? "HN205" : "HN503",
    severity: problem.severity === "warn" && onInvalid !== undefined ? onInvalid : problem.severity,
    ...(target === undefined ? {} : { target }),
    ...(problem.component === undefined ? {} : { component: problem.component }),
    ...(problem.path === undefined ? {} : { location: { file: problem.path } }),
    message: problem.message,
  }));
}

export function resolveAgentPluginProjection(
  target: TargetSpec,
  projector: AgentPluginProjector<TargetSpec>,
): AgentPluginProjectionResolution {
  const diagnostics: Diagnostic[] = [];
  if (!semver.validRange(target.version)) {
    diagnostics.push({
      code: "HN203",
      severity: "error",
      target: target.id,
      message: `${JSON.stringify(target.version)} is not a valid semver range.`,
    });
    return { profilesUsed: [], diagnostics };
  }
  const used = projector.profiles.filter((profile) => semver.intersects(profile.range, target.version));
  if (
    used.length === 0 ||
    !isRangeFullyCovered(target.version, used.map((profile) => profile.range))
  ) {
    diagnostics.push({
      code: "HN203",
      severity: "error",
      target: target.id,
      message: `requested version range ${JSON.stringify(target.version)} is not fully covered by Agent Plugin projection data (${projector.profiles.map((profile) => profile.range).join(", ") || "none"}).`,
      remediation: "narrow the target version to a validated projection range.",
    });
    return { profilesUsed: [...used], diagnostics };
  }
  const matrix: Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>> = {};
  for (const id of AGENT_PLUGIN_COMPONENT_IDS) {
    let chosen: AgentPluginComponentSupport | undefined;
    for (const profile of used) {
      const candidate = profile.components[id] ?? { level: "unsupported" as const };
      if (chosen === undefined || leastCapable(chosen.level, candidate.level) === candidate.level) {
        chosen = candidate;
      }
    }
    if (chosen !== undefined) matrix[id] = chosen;
  }
  return { matrix, profilesUsed: [...used], diagnostics };
}

function discoveredComponents(
  source: AgentPluginPackage,
  namespace: string,
  runtimePackage?: AgentPluginRuntimePackage,
): AgentPluginComponentId[] {
  const ids = new Set<AgentPluginComponentId>(["agent-plugin.manifest"]);
  if (source.skills.length > 0) ids.add("agent-plugin.skills");
  for (const server of Object.values(source.mcp?.mcpServers ?? {})) {
    ids.add(`agent-plugin.mcp.${server.type}` as AgentPluginComponentId);
  }
  if (
    namespace !== "" &&
    (source.files.some((file) => file.path.startsWith(`${namespace}/`)) ||
      source.manifest.extensions?.[namespace] !== undefined)
  ) {
    ids.add("agent-plugin.client-extension.files");
  }
  if (runtimePackage !== undefined) ids.add("agent-plugin.runtime-package");
  return [...ids];
}

export function analyzeAgentPluginProjection(
  source: AgentPluginPackage,
  adapter: HarnessAdapter,
  target: TargetSpec,
  onUnsupported: "error" | "warn",
  runtimePackage?: AgentPluginRuntimePackage,
): AgentPluginProjectionResolution {
  const projector = adapter.agentPluginProjector;
  if (projector === undefined) {
    // `onUnsupported` degrades individual unrepresentable components. A target
    // with no projector at all cannot receive the package, so listing it under
    // agentPlugin.targets is a configuration error: a "warn" here would commit
    // an empty (or hook-only) output while reporting the target as built.
    return {
      profilesUsed: [],
      diagnostics: [
        {
          code: "HN205",
          severity: "error",
          target: target.id,
          message: `target ${JSON.stringify(target.id)} (adapter ${JSON.stringify(adapter.id)}) has no Agent Plugin projector; components ${discoveredComponents(source, "", runtimePackage).map((component) => JSON.stringify(component)).join(", ")} cannot be projected.`,
          remediation: "remove the target from agentPlugin.targets or use an adapter with package projection support.",
        },
      ],
    };
  }
  const resolved = resolveAgentPluginProjection(target, projector);
  if (!resolved.matrix) return resolved;
  for (const component of discoveredComponents(source, projector.namespace, runtimePackage)) {
    const support = resolved.matrix[component] ?? { level: "unsupported" as const };
    if (support.level === "unsupported") {
      resolved.diagnostics.push({
        code: "HN205",
        severity: onUnsupported,
        target: target.id,
        component,
        support: "unsupported",
        ...(support.rationale === undefined ? {} : { rationale: support.rationale }),
        message: `Agent Plugin component ${JSON.stringify(component)} is unsupported on ${JSON.stringify(target.id)}.`,
      });
    }
  }
  return resolved;
}
