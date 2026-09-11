import type {
  CapabilityId,
  HooknosticConfig,
  RequirementLevel,
  SupportLevel,
} from "@hooknostic/sdk";
import { isCapabilityId, meetsMinimum, observeCapability } from "@hooknostic/sdk";
import type { AdapterRegistry, CapabilityMatrix } from "./adapter.js";
import { targetSpecFromConfig } from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";
import { hasFatal } from "./diagnostics.js";
import type { PluginIR } from "./ir.js";
import { hookAppliesToTarget } from "./ir.js";
import { effectiveCompatibility } from "./policy.js";

export interface CapabilityResolution {
  hookId: string;
  capability: CapabilityId;
  /** "observe" marks the implicit event-observation requirement. */
  requested: RequirementLevel | "observe";
  support: SupportLevel;
  rationale?: string;
}

export interface TargetAnalysis {
  target: string;
  /** No fatal diagnostics for this target. */
  ok: boolean;
  adapter: string;
  requestedVersion: string;
  resolutions: CapabilityResolution[];
  counts: Record<SupportLevel, number>;
  diagnostics: Diagnostic[];
}

export interface AnalysisResult {
  targets: Record<string, TargetAnalysis>;
  /** All diagnostics, including global (non-target-scoped) ones. */
  diagnostics: Diagnostic[];
  ok: boolean;
}

/**
 * Three call sites, three different fixes. They shared one string until a real
 * consumer hit the observe case and was told to do four things, none of which
 * work there.
 */
const REMEDIATION_UNSUPPORTED =
  "make the capability optional, add a target-specific fallback, exclude the target from this hook, or narrow the build target.";

/**
 * The implicit `<event>.observe` capability, below the fidelity floor.
 *
 * `DeclarableCapability` excludes `.observe` by construction, so the author
 * never declared it and *cannot* make it optional -- the analyzer synthesized
 * the requirement. The only fixes are to accept the lower fidelity or to stop
 * targeting this harness, and the first is the one people want: an OpenCode
 * `turn.stop` hook trips this under the default floor, which made "give up on
 * OpenCode" the advice for the most likely second hook anyone writes.
 */
function remediationObserveBelowMinimum(observed: SupportLevel, targetId: string): string {
  return (
    `accept the lower fidelity with \`targets.${targetId}.compatibility: ` +
    `{ minimum: "${observed}" }\`, downgrade the failure with ` +
    '`onBelowMinimum: "warn"`, or exclude this target from the hook.'
  );
}

/**
 * A declared capability that exists but is below the floor.
 *
 * "Make it optional" is deliberately phrased as a two-step: an optional
 * capability below the minimum is *also* reported unavailable, so declaring it
 * optional only helps if the hook then branches on `ctx.capabilities.has()`.
 * Naming the declaration without the branch is what makes it read like a fix on
 * its own, which it is not.
 */
function remediationBelowMinimum(observed: SupportLevel, targetId: string): string {
  return (
    `accept the lower fidelity with \`targets.${targetId}.compatibility: ` +
    `{ minimum: "${observed}" }\`, downgrade the failure with ` +
    '`onBelowMinimum: "warn"`, declare the capability optional and branch on ' +
    "`ctx.capabilities.has()`, or exclude this target from the hook."
  );
}

/**
 * Capability analysis (design §7.7). Pure semantic analysis — requires no
 * adapter emission, so fake adapters can prove the model.
 */
export function analyzeCapabilities(
  ir: PluginIR,
  config: HooknosticConfig,
  adapters: AdapterRegistry,
  selectedTargets?: readonly string[],
): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const targets: Record<string, TargetAnalysis> = {};

  const configuredTargets = Object.keys(config.targets);
  const selection = selectedTargets ?? configuredTargets;

  if (selectedTargets !== undefined && selectedTargets.length === 0) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: "the selected target set is empty.",
      remediation: "pass at least one configured target, or omit --target to check all targets.",
    });
  }

  // CLI narrowing may never introduce a target absent from config.
  for (const id of selection) {
    if (!configuredTargets.includes(id)) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        target: id,
        message: `target "${id}" is not declared in the configuration.`,
        remediation: `declare it under targets in hooknostic.config.ts; configured targets: ${configuredTargets.join(", ")}.`,
      });
    }
  }

  // Hook target scopes must name configured targets: a typo would otherwise
  // silently disable the hook (include) or run it where it must not (exclude).
  const configuredList = configuredTargets.join(", ") || "none";
  for (const hook of ir.hooks) {
    const scope = hook.targets;
    if (scope === undefined) continue;
    if (scope.include !== undefined && scope.include.length === 0) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        hookId: hook.id,
        event: hook.event,
        message: `hook "${hook.id}" has an empty targets.include list and can never apply to any target.`,
        remediation: `remove targets.include or list at least one configured target (${configuredList}).`,
      });
    }
    for (const [field, names] of [
      ["include", scope.include],
      ["exclude", scope.exclude],
    ] as const) {
      for (const name of new Set(names ?? [])) {
        if (configuredTargets.includes(name)) continue;
        diagnostics.push({
          code: "HN501",
          severity: "error",
          hookId: hook.id,
          event: hook.event,
          target: name,
          message:
            field === "include"
              ? `hook "${hook.id}" includes unknown target "${name}", so it would silently never run there.`
              : `hook "${hook.id}" excludes unknown target "${name}", so the exclusion has no effect.`,
          remediation: `use configured target ids only (${configuredList}); fix the typo or declare the target in hooknostic.config.ts.`,
        });
      }
    }
  }

  for (const targetId of selection) {
    const targetConfig = Object.hasOwn(config.targets, targetId)
      ? config.targets[targetId]
      : undefined;
    if (!targetConfig) continue;

    const adapter = Object.hasOwn(adapters, targetConfig.adapter ?? targetId) ? adapters[targetConfig.adapter ?? targetId] : undefined;
    if (!adapter) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        target: targetId,
        message: `no adapter is registered for target "${targetId}".`,
        remediation: `available adapters: ${Object.keys(adapters).join(", ") || "none"}.`,
      });
      continue;
    }

    const targetDiagnostics: Diagnostic[] = [];
    const resolutions: CapabilityResolution[] = [];
    const counts: Record<SupportLevel, number> = {
      exact: 0,
      emulated: 0,
      approximate: 0,
      unsupported: 0,
    };

    const policy = effectiveCompatibility(config, targetId);
    const spec = targetSpecFromConfig(targetId, targetConfig);
    if (!adapter.supportedDeliveries().includes(spec.delivery)) {
      targetDiagnostics.push({
        code: "HN204",
        severity: "error",
        target: targetId,
        message: `target "${targetId}" mode "${spec.delivery}" is unsupported by adapter "${adapter.id}".`,
        remediation: `use one of the supported modes: ${adapter.supportedDeliveries().join(", ")}.`,
      });
    }
    const resolved = adapter.capabilities(spec);
    targetDiagnostics.push(...resolved.diagnostics);

    const matrix: CapabilityMatrix = resolved.matrix ?? {};

    if (resolved.matrix) {
      for (const hook of ir.hooks) {
        if (!hookAppliesToTarget(hook, targetId)) continue;

        const record = (
          capability: CapabilityId,
          requested: RequirementLevel | "observe",
        ): { support: SupportLevel; rationale?: string } => {
          const entry = matrix[capability];
          const support: SupportLevel = entry?.level ?? "unsupported";
          const resolution: CapabilityResolution = {
            hookId: hook.id,
            capability,
            requested,
            support,
          };
          if (entry?.rationale !== undefined) resolution.rationale = entry.rationale;
          resolutions.push(resolution);
          counts[support] += 1;
          return entry?.rationale !== undefined
            ? { support, rationale: entry.rationale }
            : { support };
        };

        // 1. Implicit observation requirement for the hook's event.
        const observe = observeCapability(hook.event);
        const observed = record(observe, "observe");
        if (observed.support === "unsupported") {
          targetDiagnostics.push({
            code: "HN202",
            severity: "error",
            hookId: hook.id,
            event: hook.event,
            capability: observe,
            target: targetId,
            support: "unsupported",
            ...(observed.rationale !== undefined ? { rationale: observed.rationale } : {}),
            message: `event "${hook.event}" is unavailable on target "${targetId}" for the configured version range.`,
            remediation:
              "exclude this target from the hook, or drop the target from the build.",
          });
        } else if (!meetsMinimum(observed.support, policy.minimum)) {
          targetDiagnostics.push({
            code: "HN201",
            severity: policy.onBelowMinimum,
            hookId: hook.id,
            event: hook.event,
            capability: observe,
            target: targetId,
            requested: "required",
            support: observed.support,
            ...(observed.rationale !== undefined ? { rationale: observed.rationale } : {}),
            message: `observing "${hook.event}" on "${targetId}" is ${observed.support}, below the configured minimum fidelity "${policy.minimum}".`,
            remediation: remediationObserveBelowMinimum(observed.support, targetId),
          });
        } else if (observed.support !== "exact") {
          targetDiagnostics.push({
            code: "HN101",
            severity: "info",
            hookId: hook.id,
            event: hook.event,
            capability: observe,
            target: targetId,
            support: observed.support,
            ...(observed.rationale !== undefined ? { rationale: observed.rationale } : {}),
            message: `observing "${hook.event}" on "${targetId}" is ${observed.support}.`,
          });
        }

        // 2. Declared capabilities.
        for (const [capabilityKey, requested] of Object.entries(hook.capabilities) as [
          string,
          RequirementLevel,
        ][]) {
          if (!isCapabilityId(capabilityKey)) continue; // IR validation already rejected these
          const capability = capabilityKey;
          const { support, rationale } = record(capability, requested);
          const rationaleField = rationale !== undefined ? { rationale } : {};

          if (requested === "required") {
            if (support === "unsupported") {
              targetDiagnostics.push({
                code: "HN201",
                severity: "error",
                hookId: hook.id,
                event: hook.event,
                capability,
                target: targetId,
                requested,
                support,
                ...rationaleField,
                message: `required capability "${capability}" is unsupported on target "${targetId}" for the configured version range.`,
                remediation: REMEDIATION_UNSUPPORTED,
              });
            } else if (!meetsMinimum(support, policy.minimum)) {
              targetDiagnostics.push({
                code: "HN201",
                severity: policy.onBelowMinimum,
                hookId: hook.id,
                event: hook.event,
                capability,
                target: targetId,
                requested,
                support,
                ...rationaleField,
                message: `required capability "${capability}" is ${support} on "${targetId}", below the configured minimum fidelity "${policy.minimum}".`,
                remediation: remediationBelowMinimum(support, targetId),
              });
            } else if (support !== "exact") {
              targetDiagnostics.push({
                code: "HN101",
                severity: "info",
                hookId: hook.id,
                event: hook.event,
                capability,
                target: targetId,
                requested,
                support,
                ...rationaleField,
                message: `required capability "${capability}" is ${support} on "${targetId}".`,
              });
            }
          } else {
            // optional: never blocks the build solely for absence.
            const available = support !== "unsupported" && meetsMinimum(support, policy.minimum);
            if (!available && policy.optionalUnavailable !== "silent") {
              targetDiagnostics.push({
                code: "HN102",
                severity: policy.optionalUnavailable,
                hookId: hook.id,
                event: hook.event,
                capability,
                target: targetId,
                requested,
                support,
                ...rationaleField,
                message: `optional capability "${capability}" is ${support === "unsupported" ? "unavailable" : `${support}, below minimum fidelity "${policy.minimum}",`} on "${targetId}"; the hook must feature-detect at runtime.`,
              });
            }
          }
        }
      }
    }

    targets[targetId] = {
      target: targetId,
      ok: !hasFatal(targetDiagnostics),
      adapter: `${adapter.id}@${adapter.adapterVersion}`,
      requestedVersion: targetConfig.version,
      resolutions,
      counts,
      diagnostics: targetDiagnostics,
    };
    diagnostics.push(...targetDiagnostics);
  }

  return { targets, diagnostics, ok: !hasFatal(diagnostics) };
}
