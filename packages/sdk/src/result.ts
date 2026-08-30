import { z } from "zod";
import type { Effect } from "./effects.js";
import { effectSchema } from "./schemas.js";
import type { HookEventName } from "./events.js";
import { hookEventNameSchema } from "./schemas.js";

/** One effect as applied during composition, attributed to its hook. */
export interface AppliedEffect {
  hookId: string;
  effect: Effect;
}

export interface HandlerError {
  hookId: string;
  kind: "error" | "timeout" | "unsupported-effect" | "budget-exceeded";
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

export const handlerErrorSchema = z
  .object({
    hookId: z.string(),
    kind: z.enum(["error", "timeout", "unsupported-effect", "budget-exceeded"]),
    message: z.string(),
  })
  .strict();

export const hookResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    event: hookEventNameSchema,
    effects: z.array(
      z.object({ hookId: z.string(), effect: effectSchema }).strict(),
    ),
    terminatedBy: z.string().optional(),
    errors: z.array(handlerErrorSchema),
  })
  .strict();
