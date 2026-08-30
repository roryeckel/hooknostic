import type { HookResult } from "@hooknostic/sdk";
import type { InvocationContext, NativeHookResult } from "@hooknostic/core";

/**
 * Description of the native-side application of a HookResult in OpenCode's
 * callback model: throw to block, mutate the live `output` object otherwise.
 * The in-process shim applies this; `apply()` returns it as data so fixtures
 * and contract tests can assert the exact native behavior.
 */
export interface OpenCodeApplication {
  /** When set, the callback throws Error(message) — blocks the action. */
  throwMessage?: string;
  /** Mutations applied to the callback's `output` object. */
  mutations?: {
    /** tool.execute.before: replaces output.args. */
    args?: unknown;
    /** tool.execute.after: replaces output.output (string-coerced). */
    output?: string;
    /** permission.ask: sets output.status. */
    status?: "deny";
    /** experimental.session.compacting: appended to output.context. */
    context?: string[];
  };
  /**
   * Messages the shim posts back into the session with
   * `client.session.promptAsync`, in application order.
   *
   * `reply: true` omits `noReply` and so makes the agent take another turn —
   * OpenCode's only stop-prevention channel. `reply: false` sets `noReply` and
   * posts the text without one. Invariant, guaranteed by construction below: at
   * most one entry has `reply: true`, and it is last, so the agent reads every
   * notice before the instruction that keeps it working.
   */
  prompts?: { text: string; reply: boolean }[];
}

const UNREPRESENTABLE_OUTPUT = "[hooknostic: unrepresentable output]";

/** OpenCode requires tool output replacements to be strings. */
export function serializeOpenCodeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    const json = JSON.stringify(output);
    if (json !== undefined) return json;
  } catch {
    // Fall through to the total string conversion below.
  }
  try {
    return String(output);
  } catch {
    return UNREPRESENTABLE_OUTPUT;
  }
}

export function planOpenCodeApplication(result: HookResult): OpenCodeApplication {
  const application: OpenCodeApplication = {};
  const mutations: NonNullable<OpenCodeApplication["mutations"]> = {};

  const terminal =
    result.terminatedBy !== undefined
      ? result.effects[result.effects.length - 1]?.effect
      : undefined;

  if (terminal?.kind === "block") {
    if (result.event === "permission.request") {
      mutations.status = "deny";
    } else {
      application.throwMessage = terminal.reason;
    }
  }

  const replacedInput = [...result.effects]
    .reverse()
    .find((e) => e.effect.kind === "replaceInput")?.effect as
    | { input: unknown }
    | undefined;
  if (replacedInput !== undefined && application.throwMessage === undefined) {
    mutations.args = replacedInput.input;
  }

  const replacedOutput = [...result.effects]
    .reverse()
    .find((e) => e.effect.kind === "replaceOutput")?.effect as
    | { output: unknown }
    | undefined;
  if (replacedOutput !== undefined) {
    mutations.output = serializeOpenCodeOutput(replacedOutput.output);
  }

  const context = result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
  if (context.length > 0 && result.event === "context.compact.before") {
    mutations.context = context;
  }

  // OpenCode has no notification or stop-prevention callback; both are reached
  // by posting into the session, which only makes sense on turn.stop.
  if (result.event === "turn.stop") {
    const prompts: NonNullable<OpenCodeApplication["prompts"]> = result.effects
      .filter((e) => e.effect.kind === "notify")
      .map((e) => ({ text: (e.effect as { message: string }).message, reply: false }));
    if (terminal?.kind === "preventStop") {
      prompts.push({
        text: terminal.reason ?? "hooknostic: continue working",
        reply: true,
      });
    }
    if (prompts.length > 0) application.prompts = prompts;
  }

  if (Object.keys(mutations).length > 0) application.mutations = mutations;
  return application;
}

export function applyOpenCode(
  result: HookResult,
  _nativeEvent: unknown,
  _invocation: InvocationContext,
): Promise<NativeHookResult> {
  return Promise.resolve({ body: planOpenCodeApplication(result) });
}
