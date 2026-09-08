import semver from "semver";
import { hookAppliesToTarget } from "@hooknostic/sdk";
import type { RuntimePolicy } from "@hooknostic/sdk";
import type { HookIR } from "./ir.js";

/**
 * Group a plugin's hooks by the native event that will dispatch them.
 *
 * Both command-hook generators need this twice — once to decide which native
 * events to emit, once to size each one's timeout — and computing it here keeps
 * one copy of the reachability rule instead of one per adapter. Events the
 * target has no name for are dropped, so a returned entry always has at least
 * one hook: "no reaching hooks" stops being a case a caller has to defend
 * against.
 */
export function hooksByNativeEvent(
  hooks: HookIR[],
  targetId: string,
  nativeEventOf: (event: HookIR["event"]) => string | undefined,
): Map<string, HookIR[]> {
  const grouped = new Map<string, HookIR[]>();
  for (const hook of hooks) {
    if (!hookAppliesToTarget(hook, targetId)) continue;
    const nativeEvent = nativeEventOf(hook.event);
    if (nativeEvent === undefined) continue;
    const existing = grouped.get(nativeEvent);
    if (existing) existing.push(hook);
    else grouped.set(nativeEvent, [hook]);
  }
  return grouped;
}

/**
 * The native per-event timeout a command-hook harness should be given.
 *
 * The harness's timeout bounds the whole dispatcher process, but the dispatcher
 * runs *every* matching hook, sequentially, each under its own budget. Sizing
 * the native value from a single hook's budget under-counts as soon as an event
 * has more than one hook: the dispatcher believes it has N budgets and the
 * harness kills the process after one. The result is not a partial response —
 * it is no response at all, and which hooks ran depends on declaration order.
 *
 * So sum the budgets of the hooks that reach this event. Deliberately
 * conservative: `ToolMatch` disjointness means two hooks on one event often
 * cannot both fire, so the true worst case is usually smaller. Over-estimating
 * costs a longer ceiling on a path that already has per-handler timeouts.
 *
 * The `+ 1` second absorbs process start, stdin read, decode and stdout flush,
 * none of which sit inside a handler budget.
 *
 * Note what this deliberately does *not* do: clamp the result up to
 * `runtime.timeoutMs`. That looks like a harmless zero-guard and is in fact a
 * floor that silently discards every budget smaller than the global — a guard
 * declaring 50ms under a 900s default would still emit a 901s ceiling, making
 * per-hook budgets inert in the lowering direction, which is the direction they
 * exist for. The schema keeps budgets positive, so no clamp is needed.
 */
export function nativeTimeoutSeconds(
  reaching: HookIR[],
  runtime: Required<RuntimePolicy>,
): number {
  const totalMs = reaching.reduce(
    (sum, hook) => sum + (hook.timeoutMs ?? runtime.timeoutMs),
    0,
  );
  return Math.ceil(totalMs / 1000) + 1;
}

/**
 * Fail a build whose budgets exceed what the harness will actually grant.
 *
 * Some native events carry a hard cap the harness enforces regardless of the
 * configured timeout — Codex clamps `SessionEnd` to 3 seconds, Claude to 60 —
 * and a dispatcher that believes it has longer is killed mid-dispatch, which
 * produces no response at all rather than a partial one. That is the same
 * failure `nativeTimeoutSeconds` exists to prevent, arriving from the other
 * direction, so it gets the same treatment: refuse at build time rather than
 * emit an artifact that cannot work.
 *
 * Clamping instead would be the silent option. The budget the dispatcher uses
 * lives in the bundle, not in the manifest, so lowering only the manifest value
 * leaves the mismatch in place and hides it.
 */
export function assertNativeTimeoutFits(
  nativeEvent: string,
  seconds: number,
  ceilings: Record<string, number | undefined>,
  targetLabel: string,
): void {
  const ceiling = ceilings[nativeEvent];
  if (ceiling === undefined || seconds <= ceiling) return;
  throw new Error(
    `hooks on "${nativeEvent}" need ${seconds}s but ${targetLabel} grants at most ${ceiling}s ` +
      `for that event, so the dispatch would be killed before it answers. ` +
      `Lower the hooks' timeoutMs (or runtime.timeoutMs) so the total fits, or move the work ` +
      `to an event without that cap.`,
  );
}

/**
 * Whether every version a target could resolve to is inside `supported`.
 *
 * `semver.intersects` is the wrong test for declining an unestablished shape: a
 * target range that merely OVERLAPS the supported one still admits versions
 * outside it, and the build would then emit an artifact for a version nobody has
 * watched work. Subset is the honest question.
 */
export function rangeWithin(target: string, supported: string): boolean {
  return semver.validRange(target) !== null && semver.subset(target, supported);
}
