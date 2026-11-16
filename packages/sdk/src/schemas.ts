import * as z from "zod/v4";

import type { CapabilityId } from "./capabilities.js";
import { ALL_CAPABILITY_IDS } from "./capabilities.js";
import type { CompatibilityPolicy, PackageMaterializer, RuntimePolicy, TargetConfig } from "./config.js";
import type { Effect } from "./effects.js";
import { EFFECT_KINDS } from "./effects.js";
import type { HookEventName } from "./events.js";
import { HOOK_EVENT_NAMES } from "./events.js";
import { ALL_EVENT_FIELD_IDS, isEventFieldId } from "./fields.js";
import type { TargetScope } from "./hook.js";
import { findNonJsonPath } from "./json.js";
import type { AppliedEffect, HandlerError, HookResult, RuntimeDiagnosticCode } from "./result.js";
import { RUNTIME_DIAGNOSTIC_CODES } from "./result.js";
import type { RequirementLevel, SupportLevel } from "./support.js";
import { SUPPORT_LEVELS } from "./support.js";
import type { ShellDialect, ToolInvocation, ToolKind, ToolMatch } from "./tools.js";
import { SHELL_DIALECTS, TOOL_KINDS } from "./tools.js";

/**
 * Runtime validation for canonical objects. Canonical schemas are strict for
 * the fields Hooknostic controls; vendor payloads are only ever carried in
 * `raw` and are never validated here (tolerant-reader rule applies at the
 * adapter decode layer, not the canonical layer).
 *
 * This module is the `@hooknostic/sdk/schemas` entry and the only SDK module
 * that imports Zod. The root entry must never import it, so hook and config
 * authors need no Zod install (ADR-0040); tests in `packages/cli` hold the root
 * runtime graph and declaration graph to that.
 */

export const hookEventNameSchema = z.enum(HOOK_EVENT_NAMES);
export const capabilityIdSchema = z.enum(ALL_CAPABILITY_IDS);
export const supportLevelSchema = z.enum(SUPPORT_LEVELS);
export const requirementLevelSchema = z.enum(["required", "optional"]);
export const toolKindSchema = z.enum(TOOL_KINDS);
export const shellDialectSchema = z.enum(SHELL_DIALECTS);
export const eventFieldIdSchema = z.enum(ALL_EVENT_FIELD_IDS as [string, ...string[]]);

/** `<adapter>:<field id>`: an adapter id as `components.accept` spells one, then a registered field. */
const fieldAcceptanceSchema = z.string().refine(
  (value) => {
    const colon = value.indexOf(":");
    return (
      colon > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slice(0, colon)) && isEventFieldId(value.slice(colon + 1))
    );
  },
  { message: "must be <adapter>:<field id>, such as opencode:turn.stop.lastMessage" },
);

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
        dialect: shellDialectSchema.optional(),
      })
      .strict()
      .optional(),
    file: z
      .object({
        paths: z.array(z.string()),
        pathKey: z.string().optional(),
        patchKey: z.string().optional(),
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
      code: "custom",
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
    accept: z.array(fieldAcceptanceSchema).optional(),
  })
  .strict();

export const runtimePolicySchema = z
  .object({
    onHookError: z.enum(["continue", "block"]).optional(),
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
    processAllowanceMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).optional(),
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

const PROTOTYPE_KEY_MESSAGE = `"__proto__" cannot be used as a name: JavaScript treats it as an object's prototype, not an ordinary key`;
// Judgement call: say what happened without assuming how (Object.create({...})
// replaces a prototype too), and do not suggest a computed `__proto__` key,
// which is rejected here as well.
const REPLACED_PROTOTYPE_MESSAGE = `${PROTOTYPE_KEY_MESSAGE}; this record's prototype was replaced (for example by an object literal entry written as __proto__: {...}), and a computed ["__proto__"] key is not accepted either, so use a plain object and choose another name`;

/**
 * A record keyed by user-chosen names. Zod 4 skips an own `__proto__` key
 * before its key schema runs, so neither a key refinement nor a refinement of
 * the parsed record ever sees it, and the entry silently vanishes. Parse the
 * record, keep its issues as Zod reported them, then inspect the raw input.
 *
 * `reject` (the default) refuses the name, because these names become keys of
 * plain objects downstream. `preserve` validates the entry and keeps it as an
 * own data property instead.
 */
function namedRecord<K extends z.core.$ZodRecordKey, V extends z.ZodType>(
  key: K,
  value: V,
  prototypeKey: "reject" | "preserve" = "reject",
) {
  const record = z.record(key, value);
  type Output = z.output<typeof record>;

  if (prototypeKey === "preserve") {
    // Unchanged from the mcpEnvironment schema this replaced, including when it
    // reads `__proto__`: only after the record itself has parsed.
    return z.unknown().transform((input, context): Output => {
      const parsed = record.safeParse(input);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) context.addIssue({ ...issue });
        return z.NEVER;
      }
      const entries: [PropertyKey, unknown][] = Object.entries(parsed.data);
      // Parse the own `__proto__` entry explicitly, then rebuild with
      // Object.fromEntries so the name survives without invoking
      // Object.prototype's inherited setter.
      if (
        typeof input === "object" &&
        input !== null &&
        Object.prototype.propertyIsEnumerable.call(input, "__proto__")
      ) {
        const prototypeEntry = value.safeParse((input as Record<string, unknown>)["__proto__"]);
        if (!prototypeEntry.success) {
          for (const issue of prototypeEntry.error.issues)
            context.addIssue({ ...issue, path: ["__proto__", ...issue.path] });
          return z.NEVER;
        }
        entries.push(["__proto__", prototypeEntry.data]);
      }
      return Object.fromEntries(entries) as Output;
    });
  }

  return z.unknown().transform((input, context): Output => {
    // Run the record on raw issues rather than through safeParse. safeParse
    // finalizes its issues, which drops their `continue` flag, so re-adding
    // them aborted the enclosing object's refinements (the config-level
    // cross-field checks), and per-call parse options never reached them.
    // The enclosing parse prefixes and finalizes these issues as it would a
    // plain z.record's.
    //
    // `_zod.run` is an internal Zod API (`@internal` in zod/v4/core), relied on
    // across the SDK's `zod` peer range ^4.6.7 because no public API gives
    // master's result: re-adding finalized issues with `continue: true` runs
    // the config-level checks after an invalid_type where master stops, and
    // an intersection drops a one-sided invalid_key. The tests that pin
    // config-level issues beside, and stopped by, a record issue guard it.
    // This context lacks the caller's per-call options, which only Zod's own
    // nested key-issue explanations would have used.
    const run = record._zod.run({ value: input, issues: [] }, { async: false });
    // No record value schema here is asynchronous. A plain Error, because a
    // value reference into z.core would bundle Zod's whole core namespace.
    if (run instanceof Promise) throw new Error("namedRecord does not support asynchronous value schemas");
    const rejectedAsRecord = run.issues.some((issue) => (issue.path ?? []).length === 0);
    context.issues.push(...run.issues);

    // The name issue does not abort either, so config-level checks still run
    // on the remaining entries, as they did when the entry was dropped.
    const problem = prototypeKeyProblem(input, rejectedAsRecord);
    if (problem !== undefined)
      context.addIssue({ code: "custom", path: ["__proto__"], message: problem, continue: true });
    return run.value as Output;
  });
}

/**
 * The message for a `__proto__` name the raw record input carries, if any.
 * Looking runs Proxy traps Zod's own record parse never runs: getPrototypeOf,
 * and getOwnPropertyDescriptor for `__proto__`. A trap that throws counts as
 * nothing detected, so the record's own result stands, as it did before.
 */
function prototypeKeyProblem(input: unknown, rejectedAsRecord: boolean): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  try {
    if (Object.prototype.propertyIsEnumerable.call(input, "__proto__")) return PROTOTYPE_KEY_MESSAGE;
    // An object literal's `__proto__: {...}` entry sets the prototype instead
    // of adding a key, so the record parses as if the entry were absent.
    // Records made by Object.create(null), Object.fromEntries or JSON.parse
    // keep a null or Object.prototype prototype; arrays, Maps and class
    // instances already fail as "expected record" and keep only that issue.
    if (rejectedAsRecord) return undefined;
    // Compare structurally rather than with this realm's Object.prototype: a
    // record from another realm (vm, an iframe) has that realm's, and every
    // realm's Object.prototype has a null prototype of its own.
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return REPLACED_PROTOTYPE_MESSAGE;
  } catch {
    return undefined;
  }
  return undefined;
}

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
    // Rejected for now: a `__proto__` server would lose its startupTimeoutMs
    // in the build's per-server map (#200). Relax this once that is fixed.
    servers: namedRecord(z.string().min(1), projectMcpServerOverrideSchema).optional(),
  })
  .strict();

// MCP environment entries named `__proto__` were already validated and kept as
// own data properties, and that support is documented, so they stay preserved.
const mcpEnvironmentSchema = namedRecord(z.string().min(1), z.array(z.string().min(1)), "preserve");

export const hooknosticConfigSchema = z
  .object({
    project: z
      .object({ root: z.string().min(1) })
      .strict()
      .optional(),
    entry: z.string().min(1).optional(),
    compatibility: compatibilityPolicySchema.optional(),
    runtime: runtimePolicySchema.optional(),
    targets: namedRecord(z.string().min(1), targetConfigSchema),
    components: z
      .object({
        root: z.string().min(1).optional(),
        skills: z.array(z.string().min(1)).optional(),
        mcp: z.string().min(1).optional(),
        mcpOverrides: namedRecord(z.string().min(1), projectMcpTargetOverrideSchema).optional(),
        targets: z.array(z.string().min(1)).min(1).optional(),
        exclude: z.array(z.string().min(1)).optional(),
        excludeFor: namedRecord(z.string().min(1), z.array(z.string().min(1))).optional(),
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
                inputs: namedRecord(z.string(), z.string().min(1)),
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
        code: "custom",
        message: "at least one of entry or components is required",
      });
    }
    const projectAdapters = new Set<string>();
    for (const [name, target] of Object.entries(config.targets)) {
      if (config.project === undefined || target.delivery !== "project") continue;
      const adapter = target.adapter ?? name;
      if (projectAdapters.has(adapter))
        context.addIssue({ code: "custom", message: `duplicate project delivery for adapter ${adapter}` });
      projectAdapters.add(adapter);
    }
    for (const [name, target] of Object.entries(config.targets)) {
      // Project delivery writes into a live repository; there is no package for
      // a coordinate to name, so the setting could only read as a promise.
      if (target.npmName !== undefined && target.delivery !== "package") {
        context.addIssue({
          code: "custom",
          path: ["targets", name, "npmName"],
          message: `npmName requires package delivery`,
        });
      }
      // Project delivery copies skills into the project's own directory under
      // their authored names on every harness; there is nothing to choose.
      if (target.skillNames !== undefined && target.delivery !== "package") {
        context.addIssue({
          code: "custom",
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
      context.addIssue({ code: "custom", message: "project component delivery requires project.root" });
    }
    if (config.components) {
      if (
        config.components.root !== undefined &&
        (config.components.skills !== undefined || config.components.mcp !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "components.root is mutually exclusive with direct skills/mcp sources",
        });
      }
      if (config.components.root !== undefined && config.components.mcpOverrides !== undefined) {
        context.addIssue({
          code: "custom",
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
          code: "custom",
          path: ["components", "executableFiles"],
          message: "components.executableFiles requires components.root or components.skills",
        });
      }
      if (config.components.mcp === undefined && config.components.mcpOverrides !== undefined) {
        context.addIssue({ code: "custom", message: "components.mcpOverrides requires components.mcp" });
      }
      // Packages only. A direct MCP source already resolves `${NAME}` from the
      // launch environment, so it says what it needs in the declaration itself;
      // a package may not, which is the whole reason this exists (ADR-0018).
      if (config.components.root === undefined && config.components.mcpEnvironment !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["components", "mcpEnvironment"],
          message: "components.mcpEnvironment requires components.root",
        });
      }
      if (
        config.components.root === undefined &&
        config.components.skills === undefined &&
        config.components.mcp === undefined
      ) {
        context.addIssue({ code: "custom", message: "components requires root, skills, or mcp" });
      }
      const configured = new Set(Object.keys(config.targets));
      const seen = new Set<string>();
      for (const target of config.components.targets ?? Object.keys(config.targets)) {
        if (seen.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["components", "targets"],
            message: `duplicate Agent Plugin projection target ${JSON.stringify(target)}`,
          });
        }
        seen.add(target);
        if (!configured.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["components", "targets"],
            message: `Agent Plugin projection target ${JSON.stringify(target)} is not configured`,
          });
        }
      }
      for (const target of Object.keys(config.components.excludeFor ?? {})) {
        if (!configured.has(target) || !seen.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["components", "excludeFor", target],
            message: `exclusion target ${JSON.stringify(target)} must be configured and receive components`,
          });
        }
      }
      for (const target of Object.keys(config.components.mcpOverrides ?? {})) {
        if (!configured.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} is not configured`,
          });
        } else if (!seen.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} does not receive components`,
          });
        } else if (config.targets[target]?.delivery !== "project") {
          context.addIssue({
            code: "custom",
            path: ["components", "mcpOverrides", target],
            message: `MCP override target ${JSON.stringify(target)} must use project delivery`,
          });
        }
      }
      if (config.components.materialize !== undefined && config.components.root === undefined) {
        context.addIssue({
          code: "custom",
          path: ["components", "materialize"],
          message: "components.materialize requires components.root",
        });
      }
      if (
        config.components.materialize !== undefined &&
        ![...componentTargets].some((target) => config.targets[target]?.delivery === "package")
      ) {
        context.addIssue({
          code: "custom",
          path: ["components", "materialize"],
          message: "components.materialize requires at least one package-delivery component target",
        });
      }
      if (config.entry === undefined) {
        const projected = new Set(config.components.targets ?? Object.keys(config.targets));
        for (const target of configured) {
          if (!projected.has(target)) {
            context.addIssue({
              code: "custom",
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
    // Validate string keys before the enum: V4's enum-record error formatter
    // cannot render an unexpected symbol key. The pipe keeps capability typing.
    capabilities: z.partialRecord(z.string().pipe(capabilityIdSchema), requirementLevelSchema),
    fields: z.array(eventFieldIdSchema).optional(),
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

export const runtimeDiagnosticCodeSchema = z.enum(RUNTIME_DIAGNOSTIC_CODES);

export const handlerErrorSchema = z
  .object({
    hookId: z.string(),
    kind: z.enum(["error", "timeout", "unsupported-effect", "budget-exceeded"]),
    code: runtimeDiagnosticCodeSchema.optional(),
    message: z.string(),
  })
  .strict();

export const hookResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    event: hookEventNameSchema,
    effects: z.array(
      z
        .object({
          hookId: z.string(),
          effect: effectSchema,
          loweredFrom: z.enum(EFFECT_KINDS).optional(),
        })
        .strict(),
    ),
    terminatedBy: z.string().optional(),
    errors: z.array(handlerErrorSchema),
  })
  .strict();

/*
 * The root entry declares its types in plain TypeScript so that resolving them
 * never needs Zod. These compile-time checks hold each schema's inferred output
 * equal to the root type it validates, so the two cannot drift apart silently.
 *
 * Zod 4 infers an `.optional()` key as `key?: T | undefined`, where the root
 * types, written under `exactOptionalPropertyTypes`, say `key?: T`. `Exact`
 * removes that one systematic difference, recursively, before comparing. Its
 * key remapping keeps every other modifier, so a `readonly` on one side only
 * still fails.
 *
 * Five schemas are checked against their root type with a documented
 * difference applied: `effectSchema` and `hookResultSchema` output plain
 * objects where every `Effect` field is readonly; `compatibilityPolicySchema`
 * and `targetConfigSchema` accept any `accept` string and refine it at
 * runtime, where `FieldAcceptance` is a template literal; and
 * `toolMatchSchema` outputs mutable arrays where `ToolMatch` also accepts
 * readonly ones.
 *
 * Schemas without a check here differ from their root type by design: the
 * schema is deliberately looser or stricter than the type, and identity would
 * mean changing a public type. `eventFieldIdSchema` infers `string`;
 * `jsonValueSchema` infers `unknown` and refines it at runtime, and comparing
 * it with the recursive `JsonValue` exceeds the compiler's instantiation depth
 * (TS2589); `baseHookEventSchema` passes event-specific fields through; and
 * the config, hook and plugin schemas validate structure around functions and
 * unions the root types spell more precisely.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type OptionalKeys<T> = { [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? never : K }[keyof T];
type Flatten<T> = { [K in keyof T]: T[K] };
// `as` remapping over `keyof T` stays homomorphic, so `readonly` and `?` carry over.
type Exact<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [I in keyof T]: Exact<T[I]> }
    : T extends object
      ? Flatten<
          { [K in keyof T as K extends OptionalKeys<T> ? never : K]: Exact<T[K]> } & {
            [K in keyof T as K extends OptionalKeys<T> ? K : never]: Exact<Exclude<T[K], undefined>>;
          }
        >
      : T;
type Matches<S extends z.ZodType, T> = Equals<Exact<z.output<S>>, Exact<T>>;

/** Each union member with its fields' `readonly` removed: what a non-readonly schema outputs. */
type Writable<T> = T extends unknown ? { -readonly [K in keyof T]: T[K] } : never;
type SchemaHookResult = Omit<HookResult, "effects"> & {
  effects: (Omit<AppliedEffect, "effect"> & { effect: Writable<Effect> })[];
};
/** The schema's `accept`: any string, refined at runtime. */
type SchemaCompatibilityPolicy = Omit<CompatibilityPolicy, "accept"> & { accept?: string[] };
type SchemaTargetConfig = Omit<TargetConfig, "compatibility"> & { compatibility?: SchemaCompatibilityPolicy };
/** Each readonly array in a property's type, as the mutable array a schema outputs. */
type MutableArrays<T> = {
  [K in keyof T]: T[K] extends infer V ? (V extends readonly (infer E)[] ? E[] : V) : never;
};

// Module-private: a compile error here is the whole point, and nothing exports it.
type _SchemasMatchRootTypes = [
  Assert<Matches<typeof hookEventNameSchema, HookEventName>>,
  Assert<Matches<typeof capabilityIdSchema, CapabilityId>>,
  Assert<Matches<typeof supportLevelSchema, SupportLevel>>,
  Assert<Matches<typeof requirementLevelSchema, RequirementLevel>>,
  Assert<Matches<typeof toolKindSchema, ToolKind>>,
  Assert<Matches<typeof shellDialectSchema, ShellDialect>>,
  Assert<Matches<typeof toolInvocationSchema, ToolInvocation>>,
  Assert<Matches<typeof effectSchema, Writable<Effect>>>,
  Assert<Matches<typeof runtimePolicySchema, RuntimePolicy>>,
  Assert<Matches<typeof targetScopeSchema, TargetScope>>,
  Assert<Matches<typeof runtimeDiagnosticCodeSchema, RuntimeDiagnosticCode>>,
  Assert<Matches<typeof handlerErrorSchema, HandlerError>>,
  Assert<Matches<typeof hookResultSchema, SchemaHookResult>>,
  Assert<Matches<typeof compatibilityPolicySchema, SchemaCompatibilityPolicy>>,
  Assert<Matches<typeof targetConfigSchema, SchemaTargetConfig>>,
  Assert<Matches<typeof toolMatchSchema, MutableArrays<ToolMatch>>>,
];
