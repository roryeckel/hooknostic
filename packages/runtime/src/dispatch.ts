import type {
  CapabilityId,
  CapabilitySet,
  Effect,
  FileCodec,
  HandlerError,
  HookContext,
  HookDefinition,
  HookEvent,
  HookResult,
  PluginContext,
  RuntimePolicy,
  ShellCodec,
  SupportLevel,
  ToolInvocation,
} from "@hooknostic/sdk";
import {
  canonicalCapability,
  capabilityForEffect,
  DEFAULT_RUNTIME,
  effectSchema,
  hookAppliesToTarget,
  isTerminalEffect,
  matchesTool,
  meetsMinimum,
} from "@hooknostic/sdk";

/** Support levels for the executing target, as data (capability → level). */
export type CapabilityLevels = Partial<Record<CapabilityId, SupportLevel>>;

export function createCapabilitySet(levels: CapabilityLevels): CapabilitySet {
  // Own-property lookup: an id like "constructor" (reachable from untyped
  // callers) must not resolve an Object.prototype member as a support level.
  const levelOf = (id: CapabilityId): SupportLevel =>
    (Object.hasOwn(levels, id) ? levels[id] : undefined) ?? "unsupported";
  return {
    has: (id) => levelOf(id) !== "unsupported",
    level: levelOf,
  };
}

export interface DispatchOptions {
  /** The executing target's id, for intentional hook target scoping. */
  targetId: string;
  harness: { id: string; version?: string };
  capabilities: CapabilityLevels;
  /** Compatibility floor applied to optional capabilities for this target. */
  minimumCapabilityLevel?: SupportLevel;
  policy?: RuntimePolicy;
  /**
   * This target's two-way knowledge of shell tool argument shapes, supplied by
   * the adapter's shim. Without it, `updateShell` is rejected everywhere and a
   * raw `replaceInput` drops `tool.shell` (absent, never stale).
   */
  shellCodec?: ShellCodec;
  /**
   * Target-specific application check after portable validation and shell
   * lowering, before an effect changes the canonical event. A returned reason
   * is an HN401 failure governed by onHookError. updateShell reaches this
   * check as its lowered replaceInput effect.
   */
  validateEffect?: (effect: Effect, event: HookEvent) => string | undefined;
  /**
   * This target's file-view codec (ADR-0026). Without it an input rewrite
   * drops `tool.file` rather than leaving it stale.
   */
  fileCodec?: FileCodec;
  /** The executing artifact's Agent Plugin package, surfaced as `ctx.plugin` (ADR-0020). */
  plugin?: PluginContext;
}

function toolOf(event: HookEvent): ToolInvocation | undefined {
  return "tool" in event ? event.tool : undefined;
}

/**
 * Replace a tool invocation's input and re-derive the normalized views (shell
 * and file) from it. `tool.shell` is documented as derived from `input`; leaving the
 * pre-rewrite value in place would let a rewrite smuggle a command past a
 * later guard hook reading `event.tool.shell.command`. When the new input no
 * longer classifies (or no codec was supplied), the view is deleted -- absence
 * tells a hook to fall back to `input`, where a stale value tells it a lie.
 */
function setToolInput(tool: ToolInvocation, input: unknown, options: DispatchOptions): void {
  tool.input = input;
  const shell = options.shellCodec?.classify(tool.nativeName, input);
  if (shell !== undefined) tool.shell = shell;
  else delete tool.shell;
  // The same rule for the file view: a rewrite must not leave a later guard
  // reading the paths of an input that no longer exists.
  const file = options.fileCodec?.classify(tool.nativeName, input);
  if (file !== undefined) tool.file = file;
  else delete tool.file;
}

/**
 * Clamp user-visible notification text to `limit` UTF-16 code units without
 * splitting a surrogate pair — a lone surrogate would render as a replacement
 * character in the middle of a message a person is meant to read.
 */
function truncateNotification(message: string, limit: number): string {
  if (message.length <= limit) return message;
  const code = message.charCodeAt(limit - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff; // high surrogate at the cut
  return message.slice(0, splitsPair ? limit - 1 : limit);
}

/** Convert an arbitrary thrown value without letting hostile proxies escape dispatch. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === "string" ? error.message : "Error";
    }
  } catch {
    // `instanceof` and property reads can both invoke hostile proxy traps.
  }

  try {
    return String(error);
  } catch {
    return "uninspectable thrown value";
  }
}

/**
 * Dispatch one decoded native event through all matching portable handlers
 * (ADR-0003): sequential declaration order, immediate mutation visibility,
 * first terminal effect wins, fail-open by default. Effects whose capability
 * is undeclared or unavailable on this target are HN401 runtime contract
 * violations handled per the hook-error policy — never silently applied.
 */
export async function dispatch(
  hooks: readonly HookDefinition[],
  event: HookEvent,
  options: DispatchOptions,
): Promise<HookResult> {
  const policy = { ...DEFAULT_RUNTIME, ...options.policy };
  const targetCapabilities = createCapabilitySet(options.capabilities);

  const result: HookResult = {
    schemaVersion: 1,
    event: event.event,
    effects: [],
    errors: [],
  };

  // Coalesced, not just spread: `{...DEFAULT_RUNTIME, ...options.policy}` lets a
  // caller passing an explicit `undefined` clobber the default, after which
  // `budget -= n` is NaN and the cap is silently off for the rest of the
  // dispatch. Guarding only the new field would read as if the other were
  // deliberately unguarded.
  let contextBudget = policy.contextCharLimit ?? DEFAULT_RUNTIME.contextCharLimit;
  // RuntimePolicy is public and dispatch() can be called without config-schema
  // validation. NaN would otherwise produce an empty notification after slice(),
  // while Infinity would disable the cap entirely.
  let notifyBudget =
    typeof policy.notifyCharLimit === "number" && Number.isFinite(policy.notifyCharLimit) && policy.notifyCharLimit > 0
      ? policy.notifyCharLimit
      : DEFAULT_RUNTIME.notifyCharLimit;

  const matching = hooks.filter((hook) => {
    if (hook.event !== event.event) return false;
    if (!hookAppliesToTarget(hook, options.targetId)) return false;
    const tool = toolOf(event);
    if (hook.match && tool && !matchesTool(hook.match, tool)) return false;
    return true;
  });

  const failDispatch = (hookId: string, error: HandlerError, capabilities: CapabilitySet): boolean => {
    result.errors.push(error);
    if (policy.onHookError === "block") {
      const blockCapability = capabilityForEffect(event.event, "block");
      if (blockCapability && capabilities.has(blockCapability)) {
        result.effects.push({
          hookId,
          effect: { kind: "block", reason: `hook "${hookId}" failed: ${error.message}` },
        });
        result.terminatedBy = hookId;
        return true; // terminal
      }
    }
    return false; // fail-open: continue with remaining handlers
  };

  /**
   * Validate one value a handler returned as an effect. A throw during
   * validation (zod can trip a hostile proxy's traps before jsonValueSchema
   * rejects it) is itself an HN401: validation is part of the handler boundary
   * and must not break the fail-open contract.
   */
  const parseReturned = (hookId: string, value: unknown): { effect: Effect } | { error: HandlerError } => {
    let parsed: ReturnType<typeof effectSchema.safeParse>;
    try {
      parsed = effectSchema.safeParse(value);
    } catch (error) {
      return {
        error: {
          hookId,
          kind: "unsupported-effect",
          code: "HN401",
          message: `hook "${hookId}" returned a value that could not be validated as an effect: ${errorMessage(error)}`,
        },
      };
    }
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message;
      return {
        error: {
          hookId,
          kind: "unsupported-effect",
          code: "HN401",
          message: `hook "${hookId}" returned a value that is not a valid effect${detail !== undefined ? `: ${detail}` : "."}`,
        },
      };
    }
    return { effect: parsed.data as Effect };
  };

  /**
   * Check one validated effect against the event, the hook's declaration and
   * the target, then apply it (mutations become visible to later effects and
   * handlers). Type information can be bypassed, so every rung is enforced
   * here regardless of the compile-time story. Returns true when the dispatch
   * ends here: a terminal effect, or a failure the error policy made terminal.
   */
  const applyEffect = (hook: HookDefinition, capabilities: CapabilitySet, effect: Effect): boolean => {
    const capability = capabilityForEffect(event.event, effect.kind);
    if (capability === undefined) {
      return failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: "unsupported-effect",
          code: "HN401",
          message: `effect "${effect.kind}" is not defined for event "${event.event}".`,
        },
        capabilities,
      );
    }
    if (hook.capabilities[capability] === undefined) {
      return failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: "unsupported-effect",
          code: "HN401",
          message: `hook "${hook.id}" returned "${effect.kind}" without declaring capability "${capability}".`,
        },
        capabilities,
      );
    }
    if (!capabilities.has(capability)) {
      return failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: "unsupported-effect",
          code: "HN401",
          message: `capability "${capability}" is unavailable on target "${options.targetId}"; feature-detect with ctx.capabilities.has().`,
        },
        capabilities,
      );
    }

    // Lower a portable shell rewrite before the apply switch, so its failure
    // path shares the ladder's semantics above (record the error, then move on
    // or stop, per the error policy). encode() declines exactly
    // when classify() does, so this failing implies event.tool.shell was
    // undefined -- the documented feature-detect signal.
    let loweredShellInput: unknown;
    if (effect.kind === "updateShell") {
      const tool = toolOf(event);
      loweredShellInput =
        tool !== undefined
          ? options.shellCodec?.encode(tool.nativeName, tool.input, { command: effect.command })
          : undefined;
      if (loweredShellInput === undefined) {
        return failDispatch(
          hook.id,
          {
            hookId: hook.id,
            kind: "unsupported-effect",
            code: "HN401",
            message:
              `hook "${hook.id}" returned "updateShell" for tool ` +
              `"${toolOf(event)?.nativeName ?? "<none>"}", whose argument shape this target has ` +
              `not captured; guard with event.tool.shell !== undefined, and use ` +
              `replaceInput for uncaptured shapes.`,
          },
          capabilities,
        );
      }
    }

    if (options.validateEffect !== undefined) {
      const nativeEffect: Effect =
        effect.kind === "updateShell" ? { kind: "replaceInput", input: loweredShellInput } : effect;
      let rejection: string | undefined;
      try {
        rejection = options.validateEffect(nativeEffect, event);
      } catch (error) {
        rejection = `target validation failed: ${errorMessage(error)}`;
      }
      if (rejection !== undefined) {
        return failDispatch(
          hook.id,
          {
            hookId: hook.id,
            kind: "unsupported-effect",
            code: "HN401",
            message: `hook "${hook.id}" returned "${effect.kind}" that target "${options.targetId}" cannot apply: ${rejection}`,
          },
          capabilities,
        );
      }
    }

    // Apply the effect (mutations become visible to subsequent handlers).
    switch (effect.kind) {
      case "replaceInput": {
        const tool = toolOf(event);
        if (tool) setToolInput(tool, effect.input, options);
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
      case "updateShell": {
        const tool = toolOf(event);
        if (tool === undefined) break; // unreachable: lowering above required it
        setToolInput(tool, loweredShellInput, options);
        // Two entries: the portable effect as the hook returned it, then the
        // lowering the adapters actually consume. apply() implementations keep
        // resolving the last replaceInput with no knowledge of updateShell,
        // and mixed updateShell/replaceInput ordering stays one ordered list.
        result.effects.push({ hookId: hook.id, effect });
        result.effects.push({
          hookId: hook.id,
          effect: { kind: "replaceInput", input: loweredShellInput },
          loweredFrom: "updateShell",
        });
        break;
      }
      case "replaceOutput": {
        if (event.event === "tool.after") event.output = effect.output;
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
      case "addContext": {
        // Recorded, not dropped in silence. The argument the notify case below
        // makes -- a clipped message is a changed behaviour, so say so -- is
        // just as true of context: a hook whose house-rules injection was cut
        // at the cap behaves differently and nothing told anyone.
        if (contextBudget <= 0) {
          result.errors.push({
            hookId: hook.id,
            kind: "budget-exceeded",
            code: "HN103",
            message:
              `context addition dropped; no context budget remained in this ` +
              `dispatch (limit ${policy.contextCharLimit} characters).`,
          });
          break;
        }
        const context = effect.context.length > contextBudget ? effect.context.slice(0, contextBudget) : effect.context;
        if (context.length < effect.context.length) {
          result.errors.push({
            hookId: hook.id,
            kind: "budget-exceeded",
            code: "HN103",
            message:
              `context addition truncated to ${context.length} of ` +
              `${effect.context.length} characters by the context budget.`,
          });
        }
        contextBudget -= context.length;
        result.effects.push({ hookId: hook.id, effect: { kind: "addContext", context } });
        break;
      }
      case "notify": {
        // Unlike the context budget above, exhaustion is recorded as a
        // budget-exceeded HandlerError rather than dropped without a trace:
        // "the user sees this" is the entire semantic of a notification.
        // Note nothing surfaces HookResult.errors to users yet — the adapters
        // all discard it — so today the record reaches callers of dispatch()
        // and tests. That is a gap in reporting, not in the record itself.
        //
        // Floored because a fractional budget would let slice(0, 0.5) produce
        // an EMPTY message, which effectSchema rejects (message: min(1)).
        // Config values are guarded by .int().positive(); the direct dispatch()
        // API is not.
        const remaining = Math.floor(notifyBudget);
        if (remaining <= 0) {
          result.errors.push({
            hookId: hook.id,
            kind: "budget-exceeded",
            code: "HN103",
            message:
              `notification dropped; no notification budget remained in ` +
              `this dispatch (limit ${policy.notifyCharLimit} characters).`,
          });
          break;
        }
        const message = truncateNotification(effect.message, remaining);
        if (message.length < effect.message.length) {
          result.errors.push({
            hookId: hook.id,
            kind: "budget-exceeded",
            code: "HN103",
            message:
              `notification truncated to ${message.length} of ` +
              `${effect.message.length} characters by the notification budget.`,
          });
        }
        notifyBudget -= message.length;
        result.effects.push({ hookId: hook.id, effect: { kind: "notify", message } });
        break;
      }
      default: {
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
    }

    if (isTerminalEffect(effect)) {
      result.terminatedBy = hook.id;
      return true;
    }
    return false;
  };

  for (const hook of matching) {
    // Authors probe with the same keys they declared, which may be spelled
    // relative to the event ("input.replace"); resolve before either lookup.
    // Closures rather than `this`-methods, so `const { has } = ctx.capabilities`
    // works.
    const levelOf = (id: string): SupportLevel => {
      const capability = canonicalCapability(event.event, id) as CapabilityId;
      const level = targetCapabilities.level(capability);
      const minimum = options.minimumCapabilityLevel;
      if (minimum !== undefined && hook.capabilities[capability] !== "required" && !meetsMinimum(level, minimum)) {
        return "unsupported";
      }
      return level;
    };
    const capabilities: CapabilitySet<string> = {
      has: (id) => levelOf(id) !== "unsupported",
      level: levelOf,
    };
    const controller = new AbortController();
    const ctx: HookContext = {
      capabilities,
      harness: { ...options.harness },
      signal: controller.signal,
      // A copy per hook, like `harness`: a handler that mutates it must not
      // move the root under the hooks after it.
      ...(options.plugin === undefined ? {} : { plugin: { ...options.plugin } }),
    };

    let outcome: unknown;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Per hook, not per dispatch: a hook that shells out to a linter can declare
    // minutes without licensing a string matcher beside it to hang for the same.
    // The second `??` is the same guard the two char budgets above carry -- an
    // explicitly-`undefined` policy key survives the spread, and `setTimeout`
    // with `undefined` fires in about a millisecond while reporting
    // "timed out after undefinedms".
    const budgetMs = hook.timeoutMs ?? policy.timeoutMs ?? DEFAULT_RUNTIME.timeoutMs;
    try {
      outcome = await Promise.race([
        Promise.resolve(hook.run(event, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`timed out after ${budgetMs}ms`));
          }, budgetMs);
        }),
      ]);
    } catch (error) {
      const terminal = failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: timedOut ? "timeout" : "error",
          message: errorMessage(error),
        },
        capabilities,
      );
      if (terminal) break;
      continue;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (outcome === undefined) continue; // no effect means continue unchanged

    // A list is the effects consecutive handlers would have returned, applied
    // in order under this hook's id (ADR-0025). Reading it is part of the
    // handler boundary: a hostile or revoked proxy must fail open, not throw.
    let returned: unknown[];
    try {
      returned = Array.isArray(outcome) ? Array.from(outcome as readonly unknown[]) : [outcome];
    } catch (error) {
      const terminal = failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: "unsupported-effect",
          code: "HN401",
          message: `hook "${hook.id}" returned a value that could not be validated as an effect: ${errorMessage(error)}`,
        },
        capabilities,
      );
      if (terminal) break;
      continue;
    }
    const parsed = returned.filter((value) => value !== undefined).map((value) => parseReturned(hook.id, value));

    // Rejected whole, before anything applies: applying the prefix and dropping
    // the tail would hide the mistake, and applying the tail after a terminal
    // would break "the terminal effect is the last entry", which every adapter
    // relies on.
    const terminalAt = parsed.findIndex((entry) => "effect" in entry && isTerminalEffect(entry.effect));
    if (terminalAt !== -1 && terminalAt < parsed.length - 1) {
      const early = parsed[terminalAt] as { effect: Effect };
      const trailing = parsed.length - 1 - terminalAt;
      const terminal = failDispatch(
        hook.id,
        {
          hookId: hook.id,
          kind: "unsupported-effect",
          code: "HN401",
          message:
            `hook "${hook.id}" returned "${early.effect.kind}" followed by ${trailing} more ` +
            `effect${trailing === 1 ? "" : "s"}; a terminal effect ends the dispatch, so it must be last in the list.`,
        },
        capabilities,
      );
      if (terminal) break;
      continue;
    }

    let ended = false;
    for (const entry of parsed) {
      ended =
        "error" in entry
          ? failDispatch(hook.id, entry.error, capabilities)
          : applyEffect(hook, capabilities, entry.effect);
      if (ended) break;
    }
    if (ended) break;
  }

  return result;
}

/**
 * Handler failures rendered for a human, or undefined when there are none.
 *
 * `HookResult.errors` was recorded and then discarded by every adapter, so a
 * hook that timed out, returned an effect its target cannot support, or had a
 * notification clipped produced *no output on any harness*. Fail-open is the
 * contract; fail-silent was not, and it cost the first real consumer two
 * production defects that a single line of stderr would have named.
 *
 * Adapters route this to whatever channel they own -- the structured array
 * stays the source of truth for anything programmatic.
 */
export function formatHandlerErrors(result: HookResult): string | undefined {
  if (result.errors.length === 0) return undefined;
  return result.errors.map((e) => `hooknostic ${e.code ?? e.kind} [${e.hookId}]: ${e.message}`).join("\n");
}

/** Accumulated model-visible context additions, in application order. */
export function contextAdditions(result: HookResult): string[] {
  return result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
}

/** Accumulated user-visible notifications, in application order. */
export function notifications(result: HookResult): string[] {
  return result.effects.filter((e) => e.effect.kind === "notify").map((e) => (e.effect as { message: string }).message);
}

/** The terminal effect, when dispatch was terminated. */
export function terminalEffect(result: HookResult): Effect | undefined {
  if (result.terminatedBy === undefined) return undefined;
  return result.effects[result.effects.length - 1]?.effect;
}

/** The final replaced input, when any handler replaced it. */
export function replacedInput(result: HookResult): { value: unknown } | undefined {
  const last = [...result.effects].reverse().find((e) => e.effect.kind === "replaceInput");
  return last ? { value: (last.effect as { input: unknown }).input } : undefined;
}

/** The final replaced output, when any handler replaced it. */
export function replacedOutput(result: HookResult): { value: unknown } | undefined {
  const last = [...result.effects].reverse().find((e) => e.effect.kind === "replaceOutput");
  return last ? { value: (last.effect as { output: unknown }).output } : undefined;
}
