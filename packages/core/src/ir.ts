import type {
  CapabilityId,
  HookDefinition,
  PluginSpec,
  RequirementLevel,
  TargetScope,
  ToolMatch,
} from "@hooknostic/sdk";
import { isToolScopedEvent, pluginSpecSchema } from "@hooknostic/sdk";
import type { Diagnostic } from "./diagnostics.js";

/**
 * Normalized, serializable plugin representation. The IR carries hook
 * *metadata* for capability analysis and artifact generation; handler
 * functions stay in the source module, which is bundled separately for the
 * runtime.
 */
export interface HookIR {
  /** Declaration order; composition executes in this order (ADR-0003). */
  index: number;
  event: HookDefinition["event"];
  id: string;
  match?: ToolMatch;
  targets?: TargetScope;
  /**
   * Declared capabilities. The implicit `<event>.observe` requirement is
   * added during capability analysis, not stored here.
   */
  capabilities: Partial<Record<CapabilityId, RequirementLevel>>;
}

export interface PluginIR {
  name: string;
  version?: string;
  description?: string;
  hooks: HookIR[];
}

export interface BuildIRResult {
  ir?: PluginIR;
  diagnostics: Diagnostic[];
}

/**
 * Re-exported from the SDK, which owns the predicate so adapter shims can
 * reach it without importing the compiler (and with it esbuild).
 */
export { hookAppliesToTarget } from "@hooknostic/sdk";

/**
 * Validate an evaluated plugin spec and build the deterministic IR.
 * Source-model problems are HN501 diagnostics, never thrown.
 */
export function buildPluginIR(spec: unknown): BuildIRResult {
  const diagnostics: Diagnostic[] = [];

  const parsed = pluginSpecSchema.safeParse(spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        message: `invalid plugin source: ${issue.path.join(".") || "<root>"}: ${issue.message}`,
        remediation:
          "export default definePlugin({...}) built from hook() calls in the entry module.",
      });
    }
    return { diagnostics };
  }

  // safeParse strips functions' typing; use the original spec for structure
  // (schema already proved shape) so `run` and exact objects are preserved.
  const plugin = spec as PluginSpec;

  const seen = new Set<string>();
  const hooks: HookIR[] = [];
  plugin.hooks.forEach((h, index) => {
    if (seen.has(h.id)) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        hookId: h.id,
        event: h.event,
        message: `duplicate hook id "${h.id}" — hook ids must be unique within a plugin.`,
        remediation: "rename one of the hooks; ids appear in diagnostics and build reports.",
      });
      return;
    }
    seen.add(h.id);

    if (h.match !== undefined && !isToolScopedEvent(h.event)) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        hookId: h.id,
        event: h.event,
        message: `hook "${h.id}" declares a tool matcher on non-tool event "${h.event}".`,
        remediation: "remove the matcher or move the hook to a tool-scoped event.",
      });
      return;
    }

    for (const capability of Object.keys(h.capabilities)) {
      if (!capability.startsWith(`${h.event}.`)) {
        diagnostics.push({
          code: "HN501",
          severity: "error",
          hookId: h.id,
          event: h.event,
          capability: capability as CapabilityId,
          message: `hook "${h.id}" declares capability "${capability}" which is not scoped to its event "${h.event}".`,
          remediation: "declare only capabilities scoped to the hook's own event.",
        });
      }
    }

    const ir: HookIR = {
      index,
      event: h.event,
      id: h.id,
      capabilities: { ...h.capabilities },
    };
    if (h.match !== undefined) ir.match = h.match;
    if (h.targets !== undefined) ir.targets = h.targets;
    hooks.push(ir);
  });

  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }

  const ir: PluginIR = { name: plugin.name, hooks };
  if (plugin.version !== undefined) ir.version = plugin.version;
  if (plugin.description !== undefined) ir.description = plugin.description;
  return { ir, diagnostics };
}
