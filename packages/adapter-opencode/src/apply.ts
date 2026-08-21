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
