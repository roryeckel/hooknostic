import type { CapabilityId, EventFieldId, HooknosticConfig, RequirementLevel, SupportLevel } from "@hooknostic/sdk";
import { ALL_EVENT_FIELD_IDS, isCapabilityId, meetsMinimum, observeCapability } from "@hooknostic/sdk";

import type { AdapterRegistry, CapabilityMatrix, FieldMatrix, HarnessAdapter } from "./adapter.js";
import { resolveTargetAdapter, targetSpecFromConfig } from "./adapter.js";
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

/**
 * A declared event field a target produces below exact (ADR-0027). Recorded
 * whatever its severity, so the build report shows every accepted shortfall
 * as well as every fatal one.
 */
export interface FieldShortfall {
  /** Qualified as `<adapter>:<field id>`, the spelling `compatibility.accept` takes. */
  id: string;
  hookId: string;
  field: EventFieldId;
  support: SupportLevel;
  accepted: boolean;
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
  /** Declared fields below exact, in hook order (ADR-0027). */
  fields: FieldShortfall[];
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
 * Every field id some profile of `adapter` rates below exact, across all of
 * its version ranges and families: an acceptance may belong to a range the
 * build does not cover yet (ADR-0022), so the whole adapter counts.
 */
function fieldsBelowExact(adapter: HarnessAdapter): Set<string> {
  const below = new Set<string>();
  for (const version of adapter.supportedHarnessVersions()) {
    const resolved = adapter.capabilities({ id: adapter.id, version, delivery: "project", output: "." });
    for (const profile of resolved.profilesUsed) {
      for (const id of ALL_EVENT_FIELD_IDS) {
        if (profile.fields?.[id]?.level !== "exact") below.add(id);
      }
    }
  }
  return below;
}

/**
 * HN108 for one declared field on one target. Severity follows ADR-0027: a
 * field the target never produces fails, a lower-fidelity one follows the
 * capability floor, and an accepted one is information either way.
 */
function fieldDiagnostic(
  shortfall: FieldShortfall,
  event: Diagnostic["event"],
  targetId: string,
  policy: ReturnType<typeof effectiveCompatibility>,
): Diagnostic {
  const { support, field, accepted } = shortfall;
  const meets = support !== "unsupported" && meetsMinimum(support, policy.minimum);
  const severity = accepted || meets ? "info" : support === "unsupported" ? "error" : policy.onBelowMinimum;
  const state =
    support === "unsupported"
      ? `is never produced on "${targetId}"`
      : `is ${support} on "${targetId}"${meets ? "" : `, below the configured minimum fidelity "${policy.minimum}"`}`;
  return {
    code: "HN108",
    severity,
    hookId: shortfall.hookId,
    ...(event !== undefined ? { event } : {}),
    field,
    target: targetId,
    support,
    ...(shortfall.rationale !== undefined ? { rationale: shortfall.rationale } : {}),
    message: `hook "${shortfall.hookId}" reads "${field}", which ${state}${accepted ? `; accepted as ${shortfall.id}` : ""}.`,
    ...(severity === "info"
      ? {}
      : {
          remediation:
            `handle its absence and accept it with \`compatibility.accept: [${JSON.stringify(shortfall.id)}]\`, ` +
            "exclude this target from the hook, or stop reading the field.",
        }),
  };
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
    const targetConfig = Object.hasOwn(config.targets, targetId) ? config.targets[targetId] : undefined;
    if (!targetConfig) continue;

    let adapter = Object.hasOwn(adapters, targetConfig.adapter ?? targetId)
      ? adapters[targetConfig.adapter ?? targetId]
      : undefined;
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
    const selected = resolveTargetAdapter(adapter, spec);
    targetDiagnostics.push(...selected.diagnostics);
    if (selected.adapter !== undefined) adapter = selected.adapter;
    if (!adapter.supportedDeliveries().includes(spec.delivery)) {
      targetDiagnostics.push({
        code: "HN204",
        severity: "error",
        target: targetId,
        message: `target "${targetId}" delivery "${spec.delivery}" is unsupported by adapter "${adapter.id}".`,
        remediation: `use one of the supported deliveries: ${adapter.supportedDeliveries().join(", ")}.`,
      });
    }
    // Two questions about an npm coordinate, because effect alone answered the
    // wrong one. Whether it reached the manifest npm will read is necessary
    // but not sufficient: adapters that never read `npmName` still emit a root
    // `package.json` -- Codex copied the source project's until it stopped,
    // Claude builds one from `components.runtimePackage` -- and a name matching
    // by coincidence passed a guard that exists precisely to catch a setting
    // doing nothing. So the adapter must first declare that its package
    // delivery publishes under the coordinate at all. That question needs only
    // the config and the adapter, so it is answered here, before anything is
    // bundled; the build confirms the emitted manifest afterwards.
    if (spec.npmName !== undefined && adapter.publishesNpmPackage !== true) {
      targetDiagnostics.push({
        code: "HN501",
        severity: "error",
        target: targetId,
        message:
          `target ${JSON.stringify(targetId)} declares npmName ${JSON.stringify(spec.npmName)}, but ` +
          `${adapter.id} package delivery does not emit an npm package to publish under it`,
        remediation: "remove npmName, or target a harness whose package delivery emits an npm manifest.",
      });
    }
    // The same fail-closed rule as npmName: a projector that does not rename
    // skills would ignore the setting, so the author hears about it instead.
    if (spec.skillNames !== undefined && adapter.agentPluginProjector?.qualifiesSkillNames !== true) {
      targetDiagnostics.push({
        code: "HN501",
        severity: "error",
        target: targetId,
        message:
          `target ${JSON.stringify(targetId)} declares skillNames ${JSON.stringify(spec.skillNames)}, but ` +
          `${adapter.id} package delivery keeps every skill's authored name already`,
        remediation: "remove skillNames; it applies only to a harness whose skill names are not qualified by plugin.",
      });
    }
    const resolved = selected.adapter
      ? adapter.capabilities(spec)
      : { matrix: undefined, fields: undefined, profilesUsed: [], diagnostics: [] };
    targetDiagnostics.push(...resolved.diagnostics);

    const matrix: CapabilityMatrix = resolved.matrix ?? {};
    const fieldMatrix: FieldMatrix = resolved.fields ?? {};
    const fields: FieldShortfall[] = [];

    // An acceptance must name this target's adapter and a field some profile of
    // it rates below exact; anything else accepts nothing, silently.
    const targetAccept = targetConfig.compatibility?.accept ?? [];
    if (targetAccept.length > 0 && selected.adapter) {
      const below = fieldsBelowExact(adapter);
      for (const accepted of targetAccept) {
        const colon = accepted.indexOf(":");
        if (accepted.slice(0, colon) === adapter.id && below.has(accepted.slice(colon + 1))) continue;
        targetDiagnostics.push({
          code: "HN501",
          severity: "error",
          target: targetId,
          message: `targets.${targetId}.compatibility.accept names ${JSON.stringify(accepted)}, which adapter "${adapter.id}" does not rate below exact.`,
          remediation: "use a qualified id as an HN108 diagnostic or the build report prints it, or remove the entry.",
        });
      }
    }

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
          return entry?.rationale !== undefined ? { support, rationale: entry.rationale } : { support };
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
            remediation: "exclude this target from the hook, or drop the target from the build.",
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

        // 2. Declared event fields (ADR-0027), only where the event is observable:
        // HN202 already fails the hook there, and a field report would be noise.
        if (observed.support !== "unsupported") {
          for (const field of hook.fields ?? []) {
            const entry = fieldMatrix[field];
            const support: SupportLevel = entry?.level ?? "unsupported";
            if (support === "exact") continue;
            const id = `${adapter.id}:${field}`;
            const shortfall: FieldShortfall = {
              id,
              hookId: hook.id,
              field,
              support,
              accepted: (policy.accept as readonly string[]).includes(id),
              ...(entry?.rationale !== undefined ? { rationale: entry.rationale } : {}),
            };
            fields.push(shortfall);
            targetDiagnostics.push(fieldDiagnostic(shortfall, hook.event, targetId, policy));
          }
        }

        // 3. Declared capabilities.
        for (const [capabilityKey, requested] of Object.entries(hook.capabilities) as [string, RequirementLevel][]) {
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
      fields,
      diagnostics: targetDiagnostics,
    };
    diagnostics.push(...targetDiagnostics);
  }

  // A global acceptance must name some configured target's adapter and a field
  // that adapter rates below exact somewhere.
  const globalAccept = config.compatibility?.accept ?? [];
  if (globalAccept.length > 0) {
    const configuredAdapters = new Map<string, HarnessAdapter>();
    for (const [id, target] of Object.entries(config.targets)) {
      const adapterId = target.adapter ?? id;
      const adapter = Object.hasOwn(adapters, adapterId) ? adapters[adapterId] : undefined;
      if (adapter !== undefined) configuredAdapters.set(adapter.id, adapter);
    }
    const below = new Map<string, Set<string>>();
    for (const accepted of globalAccept) {
      const colon = accepted.indexOf(":");
      const adapter = configuredAdapters.get(accepted.slice(0, colon));
      if (adapter !== undefined) {
        if (!below.has(adapter.id)) below.set(adapter.id, fieldsBelowExact(adapter));
        if (below.get(adapter.id)!.has(accepted.slice(colon + 1))) continue;
      }
      diagnostics.push({
        code: "HN501",
        severity: "error",
        message: `compatibility.accept names ${JSON.stringify(accepted)}, which no configured target's adapter rates below exact.`,
        remediation: "use a qualified id as an HN108 diagnostic or the build report prints it, or remove the entry.",
      });
    }
  }

  return { targets, diagnostics, ok: !hasFatal(diagnostics) };
}
