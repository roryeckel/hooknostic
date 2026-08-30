import { hookAppliesToTarget } from "@hooknostic/sdk";
import type { RuntimePolicy } from "@hooknostic/sdk";
import type { HookIR } from "./ir.js";

/**
 * The native per-event timeout a command-hook harness should be given.
 *
 * The harness's timeout bounds the whole dispatcher process, but the dispatcher
 * runs *every* matching hook, sequentially, each under its own budget. Deriving
 * the native value from a single hook's budget therefore under-counts whenever
 * an event has more than one hook: the dispatcher believes it has N budgets and
 * the harness kills the process after one. The result is not a partial response
 * — it is no response at all, and which hooks ran depends on declaration order.
 *
 * So sum the budgets of the hooks that can reach this native event. This is
 * deliberately conservative: `ToolMatch` disjointness means two hooks on the
 * same event often cannot both fire, so the real worst case is usually smaller.
 * Over-estimating costs a longer ceiling on a path that already has its own
 * per-handler timeouts; under-estimating silently truncates a dispatch.
 *
 * The `+ 1` second absorbs process start, stdin read, decode and stdout flush,
 * none of which are inside a handler budget.
 */
export function nativeTimeoutSeconds(
  hooks: HookIR[],
  targetId: string,
  nativeEventOf: (event: HookIR["event"]) => string | undefined,
  nativeEvent: string,
  runtime: Required<RuntimePolicy>,
): number {
  const reaching = hooks.filter(
    (hook) =>
      hookAppliesToTarget(hook, targetId) && nativeEventOf(hook.event) === nativeEvent,
  );
  const totalMs = reaching.reduce(
    (sum, hook) => sum + (hook.timeoutMs ?? runtime.timeoutMs),
    0,
  );
  // An event with no reachable hooks is not emitted, but never return 0 or 1:
  // a native timeout at or below the dispatcher's own is the bug this exists
  // to prevent.
  return Math.ceil(Math.max(totalMs, runtime.timeoutMs) / 1000) + 1;
}
