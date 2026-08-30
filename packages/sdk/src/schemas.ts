import { z } from "zod";
import { ALL_CAPABILITY_IDS } from "./capabilities.js";
import { findNonJsonPath } from "./json.js";
import { HOOK_EVENT_NAMES } from "./events.js";
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

export const toolInvocationSchema = z
  .object({
    kind: toolKindSchema,
    nativeName: z.string(),
    input: z.unknown(),
    mcp: z
      .object({ server: z.string().optional(), tool: z.string().optional() })
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
    version: z.string().min(1),
    mode: z.enum(["plugin", "local"]),
    output: z.string().min(1),
    compatibility: compatibilityPolicySchema.optional(),
  })
  .strict();

export const hooknosticConfigSchema = z
  .object({
    entry: z.string().min(1),
    compatibility: compatibilityPolicySchema.optional(),
    runtime: runtimePolicySchema.optional(),
    targets: z.record(z.string().min(1), targetConfigSchema),
    agentPlugin: z.object({ root: z.string().min(1) }).strict().optional(),
  })
  .strict();

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
