import type { ComponentId } from "@hooknostic/agent-plugin";
import type { CapabilityId, EventFieldId, HookEventName, RequirementLevel, SupportLevel } from "@hooknostic/sdk";
import { RUNTIME_DIAGNOSTIC_CODES } from "@hooknostic/sdk";

/**
 * Stable diagnostic codes.
 *
 * HN1xx degradation/informational compatibility
 * HN2xx required capability/event/version incompatibilities
 * HN3xx adapter generation or artifact validation failures
 * HN4xx runtime contract violations
 * HN5xx configuration or source-model errors
 */
export const DIAGNOSTIC_CODES = {
  HN101: "degraded capability",
  HN102: "optional capability unavailable",
  HN103: "effect truncated or dropped by a runtime budget",
  HN104: "declared executable mode not applicable to a source discovered in place",
  HN105: "declared MCP environment cannot be forwarded",
  HN106: "Agent Plugin behavior deviates from the specification",
  HN107: "project wiring is read from the root checkout, not this linked worktree",
  HN108: "event field not produced exactly",
  HN201: "required capability unsupported",
  HN202: "event unavailable",
  HN203: "target version outside adapter data",
  HN204: "artifact mode unsupported",
  HN205: "Agent Plugin component unsupported",
  HN206: "Agent Plugin component below minimum fidelity",
  HN301: "adapter generation failure",
  HN302: "output commit failure",
  HN401: "unsupported effect returned at runtime",
  HN501: "invalid configuration",
  HN502: "bundled CLI entry point",
  HN503: "invalid Agent Plugin package",
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/**
 * The runtime declares its own copy of the codes it can raise, because the SDK
 * cannot depend on this package. This line is what stops the two drifting: a
 * code the runtime raises that is not registered here is a compile error.
 */
const _runtimeCodesAreRegistered: readonly DiagnosticCode[] = RUNTIME_DIAGNOSTIC_CODES;
void _runtimeCodesAreRegistered;

export type DiagnosticSeverity = "error" | "warn" | "info";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Human-readable, single-sentence statement of the problem. */
  message: string;

  hookId?: string;
  event?: HookEventName;
  capability?: CapabilityId;
  /** A declared optional event field, for an HN108 (ADR-0027). */
  field?: EventFieldId;
  component?: ComponentId;
  target?: string;
  /** The hook's declared requirement for the capability. */
  requested?: RequirementLevel;
  /** The adapter's support level for the capability on the target range. */
  support?: SupportLevel;
  /** Adapter-provided rationale for a non-exact mapping. */
  rationale?: string;
  /** Qualified deviation id, `<adapter>:<id>`, for an HN106 (ADR-0019). */
  deviation?: string;
  /** Qualified degradation id, `<adapter>:<id>`, for an HN101 from a projection (ADR-0021). */
  degradation?: string;
  remediation?: string;
  location?: { file: string; line?: number };
}

export function hasFatal(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Compiler-style human rendering of one diagnostic. */
export function formatDiagnostic(d: Diagnostic): string {
  const lines: string[] = [];
  lines.push(`${d.code} ${DIAGNOSTIC_CODES[d.code]} [${d.severity}]`);
  lines.push("");
  if (d.location) {
    lines.push(`  ${d.location.file}${d.location.line !== undefined ? `:${d.location.line}` : ""}`);
  }
  if (d.hookId) lines.push(`  hook "${d.hookId}"`);
  if (d.location || d.hookId) lines.push("");
  if (d.capability) lines.push(`  requires: ${d.capability}${d.requested ? ` (${d.requested})` : ""}`);
  if (d.field) lines.push(`  reads:    ${d.field}`);
  if (d.component) lines.push(`  component: ${d.component}`);
  if (d.target) lines.push(`  target:   ${d.target}`);
  if (d.support) lines.push(`  support:  ${d.support}`);
  if (d.deviation) lines.push(`  deviation: ${d.deviation}`);
  if (d.capability || d.field || d.component || d.target || d.support || d.deviation) lines.push("");
  lines.push(`  ${d.message}`);
  if (d.rationale) {
    lines.push("");
    lines.push(`  Adapter rationale: ${d.rationale}`);
  }
  if (d.remediation) {
    lines.push("");
    lines.push(`  Remediation: ${d.remediation}`);
  }
  return lines.join("\n");
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n\n");
}
