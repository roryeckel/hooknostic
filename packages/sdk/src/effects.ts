import type { CapabilityId } from "./capabilities.js";
import { isCapabilityId } from "./capabilities.js";
import type { HookEventName } from "./events.js";

/**
 * Effects are semantic actions a hook asks the harness to perform. Every
 * effect maps to an event-scoped capability; returning an effect whose
 * capability was not declared (or is unsupported on the executing target) is
 * a runtime contract violation (HN401).
 *
 * There is deliberately no `allow()` effect: returning no effect means
 * continue, which avoids vendor-specific nuances around permission bypass.
 */

export interface BlockEffect {
  readonly kind: "block";
  readonly reason: string;
}

export interface RequestApprovalEffect {
  readonly kind: "requestApproval";
  readonly reason?: string;
}

export interface ReplaceInputEffect {
  readonly kind: "replaceInput";
  readonly input: unknown;
}

/**
 * Deliberately has no portable counterpart the way `replaceInput` has {@link
 * UpdateShellEffect}: there is no captured cross-harness output shape to build
 * one on. Claude exposes no replacement channel at all, Codex can replace only
 * MCP tool outputs, and OpenCode string-coerces on the way out -- normalizing
 * over that three-way divergence would be a guess, and this project doesn't.
 */
export interface ReplaceOutputEffect {
  readonly kind: "replaceOutput";
  readonly output: unknown;
}

/**
 * Portable shell-command rewrite. Lowered at dispatch to a {@link
 * ReplaceInputEffect} through the target's shell codec: the command lands
 * under the native key (`command` for Claude's `Bash`, `cmd` for Codex's
 * `exec_command`) with every sibling input key preserved.
 *
 * Legal only when `event.tool.shell` is defined -- that is the signal that the
 * tool's argument shape is captured. Returning it for an uncaptured shape is
 * a runtime contract violation (HN401); use {@link ReplaceInputEffect} there.
 * Shares `tool.before.input.replace` with `replaceInput`: it is the same wire
 * channel, and per-tool shape coverage is per-invocation data no build-time
 * capability matrix can hold.
 */
export interface UpdateShellEffect {
  readonly kind: "updateShell";
  readonly command: string;
}

export interface AddContextEffect {
  readonly kind: "addContext";
  readonly context: string;
}

export interface PreventStopEffect {
  readonly kind: "preventStop";
  readonly reason?: string;
}

export interface BlockContinuationEffect {
  readonly kind: "blockContinuation";
  readonly reason: string;
}

/**
 * Surface a message to the *user*, changing no control flow. Deliberately not
 * `addContext`: that is model-facing and this is not, and on the stop events the
 * two are separate native channels.
 *
 * Non-terminal, so notifications accumulate and later handlers still run. Note a
 * handler returns a single effect, so one hook cannot both notify and prevent a
 * stop; that needs two hooks, and the notifying one must be declared first or the
 * terminal effect will cut it off.
 */
export interface NotifyEffect {
  readonly kind: "notify";
  readonly message: string;
}

export type Effect =
  | BlockEffect
  | RequestApprovalEffect
  | ReplaceInputEffect
  | ReplaceOutputEffect
  | UpdateShellEffect
  | AddContextEffect
  | PreventStopEffect
  | BlockContinuationEffect
  | NotifyEffect;

export type EffectKind = Effect["kind"];

/** Effect helpers. */

export function block(reason: string): BlockEffect {
  return { kind: "block", reason };
}

export function requestApproval(reason?: string): RequestApprovalEffect {
  return reason === undefined ? { kind: "requestApproval" } : { kind: "requestApproval", reason };
}

/**
 * Replace the tool input. `input` must be a canonical JSON value (see
 * `JsonValue` / `isJsonValue`); anything else is rejected at dispatch as
 * HN401 because the native wire formats are JSON. The parameter stays
 * `unknown` so interface-typed inputs remain assignable.
 */
export function replaceInput(input: unknown): ReplaceInputEffect {
  return { kind: "replaceInput", input };
}

/** Replace the tool output. Same JSON-value rule as {@link replaceInput}. */
export function replaceOutput(output: unknown): ReplaceOutputEffect {
  return { kind: "replaceOutput", output };
}

/**
 * Rewrite the shell command portably. Guard with
 * `ctx.capabilities.has("tool.before.input.replace")` and
 * `event.tool.shell !== undefined` -- see {@link UpdateShellEffect}. Takes a
 * patch object so a working-directory field can be added later without a
 * signature break.
 */
export function updateShell(patch: { command: string }): UpdateShellEffect {
  return { kind: "updateShell", command: patch.command };
}

export function addContext(context: string): AddContextEffect {
  return { kind: "addContext", context };
}

export function preventStop(reason?: string): PreventStopEffect {
  return reason === undefined ? { kind: "preventStop" } : { kind: "preventStop", reason };
}

export function blockContinuation(reason: string): BlockContinuationEffect {
  return { kind: "blockContinuation", reason };
}

/** Show `message` to the user without affecting what the agent does next. */
export function notify(message: string): NotifyEffect {
  return { kind: "notify", message };
}

/**
 * The capability suffix each effect kind maps to. Combined with the event an
 * effect is returned from, this yields the event-scoped capability the hook
 * must have declared.
 */
const EFFECT_CAPABILITY_SUFFIX: Record<EffectKind, string> = {
  block: "block",
  requestApproval: "requestApproval",
  replaceInput: "input.replace",
  replaceOutput: "output.replace",
  updateShell: "input.replace",
  addContext: "context.add",
  preventStop: "prevent",
  blockContinuation: "blockContinuation",
  notify: "notify",
};

/**
 * Resolve the capability an effect requires when returned from `event`.
 * Returns `undefined` when the effect has no registered capability at that
 * event (i.e. the effect is structurally impossible there).
 */
export function capabilityForEffect(event: HookEventName, kind: EffectKind): CapabilityId | undefined {
  const id = `${event}.${EFFECT_CAPABILITY_SUFFIX[kind]}`;
  return isCapabilityId(id) ? id : undefined;
}

/**
 * Type-level mapping from a capability ID to the effect it licenses. Suffix
 * checks are ordered so that longer suffixes are not shadowed by shorter ones.
 * `.notify` shares no suffix with any other registered id, so its position is
 * free; it sits by length to keep the longest-first rule honest.
 */
export type EffectForCapability<Id extends CapabilityId> = Id extends `${string}.input.replace`
  ? ReplaceInputEffect | UpdateShellEffect
  : Id extends `${string}.output.replace`
    ? ReplaceOutputEffect
    : Id extends `${string}.context.add`
      ? AddContextEffect
      : Id extends `${string}.requestApproval`
        ? RequestApprovalEffect
        : Id extends `${string}.blockContinuation`
          ? BlockContinuationEffect
          : Id extends `${string}.prevent`
            ? PreventStopEffect
            : Id extends `${string}.notify`
              ? NotifyEffect
              : Id extends `${string}.block`
                ? BlockEffect
                : never;

/**
 * Which effects end a dispatch (ADR-0005, superseding ADR-0003 rules 4-6).
 *
 * A total record rather than a condition chain: adding an effect kind cannot
 * compile until "does this end the dispatch?" has been answered, which is the
 * one classification mistake this file could otherwise make silently.
 */
const TERMINAL_EFFECT: Record<EffectKind, boolean> = {
  block: true,
  requestApproval: true,
  preventStop: true,
  blockContinuation: true,
  replaceInput: false,
  replaceOutput: false,
  updateShell: false,
  addContext: false,
  notify: false,
};

/**
 * Every effect kind, derived from the total record above so it cannot fall
 * out of date when a kind is added. Tuple-typed for zod's `z.enum`.
 */
export const EFFECT_KINDS = Object.keys(TERMINAL_EFFECT) as [EffectKind, ...EffectKind[]];

/** Terminal effects stop remaining handlers for a dispatch (ADR-0005). */
export function isTerminalEffect(effect: Effect): boolean {
  // `=== true`, not the bare lookup: this is public API reachable with an
  // unvalidated object, and a `kind` of "toString" would otherwise return a
  // truthy function off the prototype chain.
  return TERMINAL_EFFECT[effect.kind] === true;
}
