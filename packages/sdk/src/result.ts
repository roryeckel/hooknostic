import { z } from "zod";
import type { Effect } from "./effects.js";
import { EFFECT_KINDS } from "./effects.js";
import { effectSchema } from "./schemas.js";
import type { HookEventName } from "./events.js";
import { hookEventNameSchema } from "./schemas.js";

/** One effect as applied during composition, attributed to its hook. */
export interface AppliedEffect {
  hookId: string;
  effect: Effect;
  /**
   * Set when this entry is the dispatch's lowering of a portable effect
   * recorded immediately before it (e.g. `updateShell` lowered to a
   * `replaceInput` carrying the encoded native input). Keeps the synthesized
   * entry from reading as something the hook itself returned, while letting
   * adapters consume the lowered form with no knowledge of the portable one.
   */
  loweredFrom?: Effect["kind"];
}

/**
 * The diagnostic codes the runtime can raise.
 *
 * A subset of `DIAGNOSTIC_CODES` in `@hooknostic/core`, duplicated here rather
 * than imported: the SDK cannot depend on core (circular, and core carries
 * esbuild), and a shim must never value-import core or the bundler ends up in
 * every artifact. `packages/core/src/diagnostics.ts` asserts the two agree, so
 * the duplication cannot drift silently.
 */
export const RUNTIME_DIAGNOSTIC_CODES = ["HN103", "HN401"] as const;
export type RuntimeDiagnosticCode = (typeof RUNTIME_DIAGNOSTIC_CODES)[number];

export interface HandlerError {
  hookId: string;
  kind: "error" | "timeout" | "unsupported-effect" | "budget-exceeded";
  /**
   * Diagnostic code, where one applies. Present so a consumer can branch on the
   * failure rather than parse prose -- the code used to be a prefix inside
   * `message`, which made HN401 and HN103 indistinguishable programmatically.
   */
  code?: RuntimeDiagnosticCode;
  message: string;
}

/**
 * The composed outcome of dispatching one native lifecycle event through all
 * matching portable handlers (ADR-0003). Adapters translate this into the
 * native control output; they never re-compose.
 */
export interface HookResult {
  schemaVersion: 1;
  event: HookEventName;
  /** Applied effects in application order; a terminal effect is always last. */
  effects: AppliedEffect[];
  /** Hook that terminated dispatch, when a terminal effect was returned. */
  terminatedBy?: string;
  /** Handler failures, reported per the configured hook-error policy. */
  errors: HandlerError[];
}

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
