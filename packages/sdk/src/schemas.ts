import { z } from "zod";

import { ALL_CAPABILITY_IDS } from "./capabilities.js";
import type { PackageMaterializer } from "./config.js";
import { HOOK_EVENT_NAMES } from "./events.js";
import { findNonJsonPath } from "./json.js";
import { SUPPORT_LEVELS } from "./support.js";
import { TOOL_KINDS } from "./tools.js";

/**
 * Runtime validation for canonical objects. Canonical schemas are strict for
 * the fields Hooknostic controls; vendor payloads are only ever carried in
 * `raw` and are never validated here (tolerant-reader rule applies at the
 * adapter decode layer, not the canonical layer).
 */

export const hookEventNameSchema = z.enum(HOOK_EVENT_NAMES);
export const capabilityIdSchema = z.enum(ALL_CAPABILITY_IDS);
export const supportLevelSchema = z.enum(SUPPORT_LEVELS);
export const requirementLevelSchema = z.enum(["required", "optional"]);
export const toolKindSchema = z.enum(TOOL_KINDS);

// Node clamps longer delays to 1 ms, causing hooks to time out immediately.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const packageMaterializerSchema = z.custom<PackageMaterializer>(
  (value) => {
    if (typeof value !== "object" || value === null) return false;
    const materializer = value as Partial<PackageMaterializer>;
    return (
      typeof materializer.id === "string" &&
      materializer.id.length > 0 &&
      typeof materializer.plan === "function" &&
      (materializer.validate === undefined || typeof materializer.validate === "function") &&
      (materializer.postprocess === undefined || typeof materializer.postprocess === "function")
    );
  },
  { message: "must be a PackageMaterializer with a non-empty id and plan function" },
);

export const toolInvocationSchema = z
  .object({
    kind: toolKindSchema,
    nativeName: z.string(),
    input: z.unknown(),
    mcp: z.object({ server: z.string().optional(), tool: z.string().optional() }).strict().optional(),
    shell: z
      .object({
        command: z.string(),
        cwd: z.string().optional(),
        commandKey: z.string(),
        cwdKey: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const baseHookEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    event: hookEventNameSchema,
    harness: z
      .object({
        id: z.string().min(1),
        version: z.string().optional(),
        nativeEvent: z.string().min(1),
      })
      .strict(),
    session: z
      .object({
        id: z.string().optional(),
        cwd: z.string(),
      })
      .strict(),
    correlation: z
      .object({
        turnId: z.string().optional(),
        toolCallId: z.string().optional(),
        agentId: z.string().optional(),
        parentAgentId: z.string().optional(),
      })
      .strict(),
    raw: z.unknown(),
  })
  // Event-specific payload fields (tool, prompt, output, …) extend the
  // envelope; the envelope schema validates only what it owns.
  .passthrough();

/**
 * Replacement payloads cross the native wire boundary as JSON, so they must be
 * canonical JSON values: `undefined`, functions, `bigint`, non-finite numbers,
 * cycles and non-plain objects (Date, Map, class instances) are rejected here
 * rather than being dropped, thrown on, or transformed during serialization.
 */
export const jsonValueSchema = z.unknown().superRefine((value, ctx) => {
  const path = findNonJsonPath(value);
  if (path !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `payload is not a JSON value (at ${path}): only null, booleans, finite numbers, strings, arrays and plain objects are allowed.`,
    });
  }
});

export const effectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("requestApproval"), reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal("replaceInput"), input: jsonValueSchema }).strict(),
  z.object({ kind: z.literal("replaceOutput"), output: jsonValueSchema }).strict(),
  // Plain string payload: no jsonValueSchema needed, and no hostile-proxy
  // surface -- the lowered native input is built by the codec from wire data.
  z.object({ kind: z.literal("updateShell"), command: z.string() }).strict(),
  z.object({ kind: z.literal("addContext"), context: z.string() }).strict(),
  z.object({ kind: z.literal("preventStop"), reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal("blockContinuation"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("notify"), message: z.string().min(1) }).strict(),
]);

export const compatibilityPolicySchema = z
  .object({
    minimum: supportLevelSchema.optional(),
    onBelowMinimum: z.enum(["error", "warn"]).optional(),
    optionalUnavailable: z.enum(["info", "warn", "silent"]).optional(),
  })
  .strict();

export const runtimePolicySchema = z
  .object({
    onHookError: z.enum(["continue", "block"]).optional(),
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
    contextCharLimit: z.number().int().positive().optional(),
    notifyCharLimit: z.number().int().positive().optional(),
  })
  .strict();

export const targetConfigSchema = z
  .object({
    adapter: z.string().min(1).optional(),
    version: z.string().min(1),
    delivery: z.enum(["package", "project"]),
    output: z.string().min(1),
    npmName: z.string().min(1).optional(),
    skillNames: z.enum(["qualified", "authored"]).optional(),
    compatibility: compatibilityPolicySchema.optional(),
  })
  .strict();

const projectMcpServerOverrideSchema = z
  .object({
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    startupTimeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
  })
  .strict();

const projectMcpTargetOverrideSchema = z
  .object({
    startupTimeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
    servers: z.record(z.string().min(1), projectMcpServerOverrideSchema).optional(),
  })
  .strict();

const mcpEnvironmentRecordSchema = z.record(z.string().min(1), z.array(z.string().min(1)));

const mcpEnvironmentSchema = z.unknown().transform((value, context): Record<string, string[]> => {
  const parsed = mcpEnvironmentRecordSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue(issue);
    return z.NEVER;
  }

  const entries = Object.entries(parsed.data);
  // Zod 3 validates an enumerable own `__proto__` record entry, then
  // deliberately omits it while merging into a plain output object. Rebuild
  // with Object.fromEntries so the server name remains an own data property
  // without invoking Object.prototype's inherited setter.
  if (typeof value === "object" && value !== null && Object.prototype.propertyIsEnumerable.call(value, "__proto__")) {
    entries.push(["__proto__", (value as Record<string, string[]>)["__proto__"]!]);
  }
  return Object.fromEntries(entries);
});

export const hooknosticConfigSchema = z
  .object({
    project: z
      .object({ root: z.string().min(1) })
      .strict()
      .optional(),
    entry: z.string().min(1).optional(),
    compatibility: compatibilityPolicySchema.optional(),
    runtime: runtimePolicySchema.optional(),
    targets: z.record(z.string().min(1), targetConfigSchema),
    components: z
      .object({
        root: z.string().min(1).optional(),
        skills: z.array(z.string().min(1)).optional(),
        mcp: z.string().min(1).optional(),
        mcpOverrides: z.record(z.string().min(1), projectMcpTargetOverrideSchema).optional(),
        targets: z.array(z.string().min(1)).min(1).optional(),
        exclude: z.array(z.string().min(1)).optional(),
        executableFiles: z.array(z.string().min(1)).optional(),
        mcpEnvironment: mcpEnvironmentSchema.optional(),
        runtimePackage: z
          .object({
            manifest: z.string().min(1),
            lockfile: z.string().min(1),
            allowInstallScripts: z.array(z.string().min(1)).optional(),
          })
          .strict()
          .optional(),
        materialize: z
          .array(
            z
              .object({
                provider: packageMaterializerSchema,
                inputs: z.record(z.string(), z.string().min(1)),
                into: z.string().min(1),
              })
              .strict(),
          )
          .min(1)
          .optional(),
        onUnsupported: z.enum(["error", "warn"]).optional(),
        onInvalid: z.enum(["error", "warn"]).optional(),
        onDeviation: z.enum(["error", "warn"]).optional(),
        onDegraded: z.enum(["error", "warn"]).optional(),
        accept: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.entry === undefined && config.components === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one of entry or components is required",
      });
    }
    const projectAdapters = new Set<string>();
    for (const [name, target] of Object.entries(config.targets)) {
      if (config.project === undefined || target.delivery !== "project") continue;
      const adapter = target.adapter ?? name;
      if (projectAdapters.has(adapter))
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate project delivery for adapter ${adapter}` });
      projectAdapters.add(adapter);
    }
    for (const [name, target] of Object.entries(config.targets)) {
      // Project delivery writes into a live repository; there is no package for
      // a coordinate to name, so the setting could only read as a promise.
      if (target.npmName !== undefined && target.delivery !== "package") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", name, "npmName"],
          message: `npmName requires package delivery`,
        });
      }
      // Project delivery copies skills into the project's own directory under
      // their authored names on every harness; there is nothing to choose.
      if (target.skillNames !== undefined && target.delivery !== "package") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", name, "skillNames"],
          message: `skillNames requires package delivery`,
        });
      }
    }
    const componentTargets = new Set(config.components?.targets ?? Object.keys(config.targets));
    if (
      config.components &&
      !config.project &&
      Object.entries(config.targets).some(
        ([name, target]) => componentTargets.has(name) && target.delivery === "project",
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "project component delivery requires project.root" });
    }
    if (config.components) {
      if (
        config.components.root !== undefined &&
        (config.components.skills !== undefined || config.components.mcp !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "components.root is mutually exclusive with direct skills/mcp sources",
        });
      }
      if (config.components.root !== undefined && config.components.mcpOverrides !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "components.mcpOverrides is only valid with a direct MCP source",
        });
      }
      // A direct MCP source is one file the loader reads and rewrites; it owns
      // no tree to mark. Skills do, so they accept the declaration -- ADR-0013
      // ignores host permission bits on both routes, which left a copied
      // helper script with no way to arrive executable.
      if (
        config.components.root === undefined &&
        config.components.skills === undefined &&
        config.components.executableFiles !== undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", "executableFiles"],
          message: "components.executableFiles requires components.root or components.skills",
        });
      }
      if (config.components.mcp === undefined && config.components.mcpOverrides !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "components.mcpOverrides requires components.mcp" });
      }
      // Packages only. A direct MCP source already resolves `${NAME}` from the
      // launch environment, so it says what it needs in the declaration itself;
      // a package may not, which is the whole reason this exists (ADR-0018).
      if (config.components.root === undefined && config.components.mcpEnvironment !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", "mcpEnvironment"],
          message: "components.mcpEnvironment requires components.root",
        });
      }
      if (
        config.components.root === undefined &&
        config.components.skills === undefined &&
        config.components.mcp === undefined
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "components requires root, skills, or mcp" });
      }
      const configured = new Set(Object.keys(config.targets));
      const seen = new Set<string>();
      for (const target of config.components.targets ?? Object.keys(config.targets)) {
        if (seen.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "targets"],
            message: `duplicate Agent Plugin projection target ${JSON.stringify(target)}`,
          });
        }
        seen.add(target);
        if (!configured.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "targets"],
            message: `Agent Plugin projection target ${JSON.stringify(target)} is not configured`,
          });
        }
      }
      for (const target of Object.keys(config.components.mcpOverrides ?? {})) {
        if (!configured.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} is not configured`,
          });
        } else if (!seen.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} does not receive components`,
          });
        } else if (config.targets[target]?.delivery !== "project") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} must use project delivery`,
          });
        }
      }
      if (config.components.materialize !== undefined && config.components.root === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", "materialize"],
          message: "components.materialize requires components.root",
        });
      }
      if (
        config.components.materialize !== undefined &&
        ![...componentTargets].some((target) => config.targets[target]?.delivery === "package")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", "materialize"],
          message: "components.materialize requires at least one package-delivery component target",
        });
      }
      if (config.entry === undefined) {
        const projected = new Set(config.components.targets ?? Object.keys(config.targets));
        for (const target of configured) {
          if (!projected.has(target)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["components", "targets"],
              message: `hookless builds must project configured target ${JSON.stringify(target)}`,
            });
          }
        }
      }
    }
  });

export const targetScopeSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const toolMatchSchema = z
  .object({
    kind: z.union([toolKindSchema, z.array(toolKindSchema)]).optional(),
    nativeName: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

/** Structural (non-callable) validation of an authored hook definition. */
export const hookDefinitionSchema = z
  .object({
    event: hookEventNameSchema,
    id: z.string().min(1),
    match: toolMatchSchema.optional(),
    targets: targetScopeSchema.optional(),
    // Same bound as runtimePolicySchema.timeoutMs, and for the same reason:
    // Node clamps a longer delay to 1 ms, so an out-of-range budget makes the
    // hook time out on every dispatch instead of never. `positive` also keeps
    // 0 out, which would not fall back through `hook.timeoutMs ?? policy...`
    // and would time the hook out permanently.
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
    capabilities: z.record(capabilityIdSchema, requirementLevelSchema),
    run: z.custom<(...args: never[]) => unknown>((v) => typeof v === "function", {
      message: "run must be a function",
    }),
  })
  .strict();

export const pluginSpecSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    hooks: z.array(hookDefinitionSchema),
  })
  .strict();
