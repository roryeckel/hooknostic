import semver from "semver";

import {
  type AgentPluginComponentSupport,
  type AgentPluginDegradation,
  type AgentPluginDegradationDeclaration,
  type AgentPluginDeviation,
  type AgentPluginDeviationDeclaration,
  type AgentPluginIssue,
  type AgentPluginPackage,
  type AgentPluginProjectionProfile,
  type AgentPluginProjector,
  type AgentPluginRuntimePackage,
  COMPONENT_IDS,
  type ComponentId,
  discoverComponents,
  type SubagentDefinition,
} from "@hooknostic/agent-plugin";
import { type CompatibilityPolicy, leastCapable, meetsMinimum } from "@hooknostic/sdk";

import type { HarnessAdapter, TargetSpec } from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";
import { isRangeFullyCovered } from "./matrix.js";

export interface AgentPluginProjectionResolution {
  matrix?: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
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
  projector: Pick<AgentPluginProjector<TargetSpec>, "profiles" | "supportFor">,
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
    !isRangeFullyCovered(
      target.version,
      used.map((profile) => profile.range),
    )
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
  const matrix: Partial<Record<ComponentId, AgentPluginComponentSupport>> = {};
  for (const id of COMPONENT_IDS) {
    let chosen: AgentPluginComponentSupport | undefined;
    // Every profile's, not the chosen one's: a build must not claim more than
    // the worst version in its range delivers, and a deviation any version in
    // the range has is one the build can ship into.
    const deviations = new Map<string, AgentPluginDeviationDeclaration>();
    const degradations = new Map<string, AgentPluginDegradationDeclaration>();
    for (const profile of used) {
      const candidate = profile.components[id] ?? { level: "unsupported" as const };
      if (chosen === undefined || leastCapable(chosen.level, candidate.level) === candidate.level) {
        chosen = candidate;
      }
      for (const deviation of candidate.deviations ?? []) {
        if (!deviations.has(deviation.id)) deviations.set(deviation.id, deviation);
      }
      for (const degradation of candidate.degradations ?? []) {
        if (!degradations.has(degradation.id)) degradations.set(degradation.id, degradation);
      }
    }
    if (chosen !== undefined) {
      matrix[id] = {
        level: chosen.level,
        ...(chosen.rationale === undefined ? {} : { rationale: chosen.rationale }),
        ...(deviations.size === 0 ? {} : { deviations: [...deviations.values()] }),
        ...(degradations.size === 0 ? {} : { degradations: [...degradations.values()] }),
      };
    }
  }
  return { matrix: projector.supportFor?.(target, matrix) ?? matrix, profilesUsed: [...used], diagnostics };
}

export interface AgentPluginDeviationDiagnosticOptions {
  target: string;
  /** Adapter id, which qualifies each deviation id. */
  adapter: string;
  onDeviation: "error" | "warn";
  /** The resolved matrix the projector was given; every reported id must be declared in it. */
  support: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
  /** Qualified ids from `components.accept`, reported as information whatever the policy. */
  accept?: readonly string[];
}

export interface AgentPluginDegradationDiagnosticOptions {
  target: string;
  /** Adapter id, which qualifies each degradation id. */
  adapter: string;
  onDegraded: "error" | "warn";
  /** The resolved matrix the projector was given; every reported id must be declared in it. */
  support: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
  /** Qualified ids from `components.accept`, reported as information whatever the policy. */
  accept?: readonly string[];
}

interface ShortfallKind {
  noun: "deviation" | "degradation";
  code: "HN106" | "HN101";
  policy: "onDeviation" | "onDegraded";
  declarations: (
    cell: AgentPluginComponentSupport | undefined,
  ) => readonly AgentPluginDeviationDeclaration[] | undefined;
}

const DEVIATION: ShortfallKind = {
  noun: "deviation",
  code: "HN106",
  policy: "onDeviation",
  declarations: (cell) => cell?.deviations,
};

const DEGRADATION: ShortfallKind = {
  noun: "degradation",
  code: "HN101",
  policy: "onDegraded",
  declarations: (cell) => cell?.degradations,
};

/**
 * One diagnostic per reported instance, at the class's configured severity.
 *
 * Also the check that keeps the report honest: a projector may only report an
 * id the resolved matrix declares for that component. Anything else is a
 * projector defect, or a declaration missing from the profile, and it fails the
 * target as HN301 instead of reaching users as an unexplained warning.
 *
 * An id listed in `components.accept` is still reported, as information: the
 * author has seen it and chosen to ship it, which is different from nobody
 * having looked.
 */
function shortfallDiagnostics(
  kind: ShortfallKind,
  instances: readonly AgentPluginDeviation[],
  options: {
    target: string;
    adapter: string;
    severity: "error" | "warn";
    support: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
    accept?: readonly string[];
  },
): Diagnostic[] {
  const accepted = new Set(options.accept ?? []);
  return instances.map((instance) => {
    const declaration = kind.declarations(options.support[instance.component])?.find((item) => item.id === instance.id);
    const qualified = `${options.adapter}:${instance.id}`;
    const location = instance.path === undefined ? {} : { location: { file: instance.path } };
    if (declaration === undefined) {
      return {
        code: "HN301",
        severity: "error",
        target: options.target,
        component: instance.component,
        ...location,
        message: `Agent Plugin projection for ${JSON.stringify(options.target)} reported ${kind.noun} ${JSON.stringify(qualified)}, which its resolved profile does not declare for ${instance.component}.`,
        remediation: `declare the ${kind.noun} on the profile with its evidence, or report the projector defect.`,
      };
    }
    const isAccepted = accepted.has(qualified);
    const severity = isAccepted ? "info" : options.severity;
    return {
      code: kind.code,
      severity,
      target: options.target,
      component: instance.component,
      [kind.noun]: qualified,
      ...location,
      message: instance.reason,
      rationale: `${declaration.summary} (${declaration.evidence})`,
      remediation: isAccepted
        ? `accepted by components.accept; remove ${JSON.stringify(qualified)} from it to apply components.${kind.policy} again.`
        : severity === "error"
          ? `change the package so it does not trigger this ${kind.noun}, add ${JSON.stringify(qualified)} to components.accept to ship it, or set components.${kind.policy} to "warn".`
          : `set components.${kind.policy} to "error" to fail builds that ship a ${kind.noun}, or add ${JSON.stringify(qualified)} to components.accept to acknowledge this one.`,
    };
  });
}

/** HN106 for each reported deviation (ADR-0019). */
export function diagnosticsFromAgentPluginDeviations(
  deviations: readonly AgentPluginDeviation[],
  options: AgentPluginDeviationDiagnosticOptions,
): Diagnostic[] {
  return shortfallDiagnostics(DEVIATION, deviations, { ...options, severity: options.onDeviation });
}

/** HN101 for each reported degradation (ADR-0021). */
export function diagnosticsFromAgentPluginDegradations(
  degradations: readonly AgentPluginDegradation[],
  options: AgentPluginDegradationDiagnosticOptions,
): Diagnostic[] {
  return shortfallDiagnostics(DEGRADATION, degradations, { ...options, severity: options.onDegraded });
}

function discoveredComponents(
  source: AgentPluginPackage,
  namespace: string,
  runtimePackage?: AgentPluginRuntimePackage,
  subagents?: readonly SubagentDefinition[],
  harness?: string,
): ComponentId[] {
  return [
    ...discoverComponents(source, {
      namespace,
      hasRuntimePackage: runtimePackage !== undefined,
      ...(subagents === undefined ? {} : { subagents }),
      ...(harness === undefined ? {} : { harness }),
    }).keys(),
  ];
}

export function analyzeAgentPluginProjection(
  source: AgentPluginPackage,
  adapter: HarnessAdapter,
  target: TargetSpec,
  onUnsupported: "error" | "warn",
  runtimePackage?: AgentPluginRuntimePackage,
  /**
   * The target's effective compatibility policy. A discovered component below
   * `minimum` is reported at `onBelowMinimum`, as project delivery already
   * does; without it, package delivery accepted any supported level.
   */
  compatibility?: Pick<Required<CompatibilityPolicy>, "minimum" | "onBelowMinimum">,
  /** `components.subagents` definitions, delivered inside the package (ADR-0027). */
  subagents?: readonly SubagentDefinition[],
): AgentPluginProjectionResolution {
  const projector = adapter.agentPluginProjector;
  if (projector === undefined) {
    // `onUnsupported` degrades individual unrepresentable components. A target
    // with no projector at all cannot receive the package, so listing it under
    // components.targets is a configuration error: a "warn" here would commit
    // an empty (or hook-only) output while reporting the target as built.
    return {
      profilesUsed: [],
      diagnostics: [
        {
          code: "HN205",
          severity: "error",
          target: target.id,
          message: `target ${JSON.stringify(target.id)} (adapter ${JSON.stringify(adapter.id)}) has no Agent Plugin projector; components ${discoveredComponents(
            source,
            "",
            runtimePackage,
            subagents,
            adapter.id,
          )
            .map((component) => JSON.stringify(component))
            .join(", ")} cannot be projected.`,
          remediation: "remove the target from components.targets or use an adapter with package projection support.",
        },
      ],
    };
  }
  const resolved = resolveAgentPluginProjection(target, projector);
  if (!resolved.matrix) return resolved;
  for (const component of discoveredComponents(source, projector.namespace, runtimePackage, subagents, adapter.id)) {
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
    } else if (compatibility !== undefined && !meetsMinimum(support.level, compatibility.minimum)) {
      // Emitted, not omitted, so not HN205, which marks a component skipped.
      resolved.diagnostics.push({
        code: "HN206",
        severity: compatibility.onBelowMinimum,
        target: target.id,
        component,
        support: support.level,
        ...(support.rationale === undefined ? {} : { rationale: support.rationale }),
        message: `${component} package projection support ${support.level} is below ${compatibility.minimum}`,
        remediation: `lower compatibility.minimum for ${JSON.stringify(target.id)}, or remove the component from the package.`,
      });
    }
  }
  return resolved;
}
