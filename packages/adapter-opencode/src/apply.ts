import type { InvocationContext, NativeHookResult } from "@hooknostic/core";
import type { HookResult } from "@hooknostic/sdk";

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
    /** permission.ask (callback surface): sets output.status. */
    status?: "deny";
    /** experimental.session.compacting: appended to output.context. */
    context?: string[];
    /** experimental.chat.system.transform: pushed into output.system. */
    system?: string[];
  };
  /**
   * Deny a permission request through the client reply API
   * (postSessionIdPermissionsPermissionId, response "reject"). This is the
   * only working deny channel on 1.18.x: the `permission.ask` callback whose
   * output this would mutate never fires (captured live on 1.18.25,
   * .capture/opencode-permission; upstream anomalyco/opencode #9229). The
   * permission and session ids live only on the native bus event — the shim
   * reads them from `raw` and completes the reply.
   */
  permissionReply?: {
    /** Fixed: a permission.request block denies. */
    response: "reject";
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

  const terminal = result.terminatedBy !== undefined ? result.effects[result.effects.length - 1]?.effect : undefined;

  if (terminal?.kind === "block") {
    if (result.event === "permission.request") {
      // The reply API is the live deny channel (see permissionReply above).
      // The legacy output.status mutation is kept for the callback surface,
      // which never fires on 1.18.x but costs nothing to keep correct.
      mutations.status = "deny";
    } else {
      application.throwMessage = terminal.reason;
    }
  }

  const replacedInput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceInput")?.effect as
    { input: unknown } | undefined;
  if (replacedInput !== undefined && application.throwMessage === undefined) {
    mutations.args = replacedInput.input;
  }

  const replacedOutput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceOutput")?.effect as
    { output: unknown } | undefined;
  if (replacedOutput !== undefined) {
    mutations.output = serializeOpenCodeOutput(replacedOutput.output);
  }

  const context = result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
  if (context.length > 0 && result.event === "context.compact.before") {
    mutations.context = context;
  }
  // Same strings, a different output key: model.request.before reaches the model
  // through output.system on experimental.chat.system.transform, where each entry
  // becomes its own role:"system" message.
  if (context.length > 0 && result.event === "model.request.before") {
    mutations.system = context;
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

  if (result.event === "permission.request" && terminal?.kind === "block") {
    // The permission id and session come from the native bus event, not from
    // the portable HookResult — the shim wires them in (like postPrompts).
    application.permissionReply = { response: "reject" };
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
