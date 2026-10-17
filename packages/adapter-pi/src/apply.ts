import type { InvocationContext, NativeHookResult } from "@hooknostic/core";
import type { HookResult } from "@hooknostic/sdk";

/**
 * Description of the native-side application of a HookResult in pi's
 * extension model: return a result object from the handler, mutate the live
 * event in place, or call back into the ExtensionAPI. The in-process shim
 * applies this; `apply()` returns it as data so fixtures and contract tests
 * can assert the exact native behavior.
 */
export interface PiApplication {
  /** tool_call: return {block: true, reason} — blocks execution. */
  block?: { reason: string };
  /**
   * tool_call: in-place replacement of the live `event.input` object's
   * properties (pi executes the mutated input without re-validation —
   * verified by effect on 0.84.4).
   */
  inputReplacement?: unknown;
  /**
   * tool_result: return {content, details, isError} — replaces the output
   * the model sees (verified by effect on 0.84.4). Content is lowered to
   * pi's (TextContent | ImageContent)[] as text parts.
   */
  resultReplacement?: {
    content: { type: "text"; text: string }[];
  };
  /**
   * before_agent_start: return {message} — injects a custom message into the
   * turn (verified by effect on 0.84.4).
   */
  injectedMessage?: { customType: string; content: string; display: false };
  /**
   * before_agent_start: return {systemPrompt} — replaces the system prompt
   * for this turn (verified by effect on 0.84.4). Extensions chain, and a
   * later handler's replacement wins, so the shim sends the full prompt.
   */
  systemPrompt?: string;
  /**
   * context: the handler result `{messages}` replaces the array pi hands the
   * handler a deep copy and honors the RETURN value (verified by effect on
   * 0.84.4), so the shim returns the original messages plus the context
   * strings appended as user messages. Unset when the event carried no
   * messages array.
   */
  contextMessages?: unknown[];
  /** session_before_compact: return {cancel: true} — suppresses compaction. */
  compactCancel?: true;
  /**
   * agent_settled: at most one sendMessage call, with triggerTurn, to resume
   * the agent after preventStop. A custom session message without triggerTurn
   * is model-visible and cannot implement a user-facing notify effect.
   */
  sendMessage?: { content: string; triggerTurn: true }[];
}

const UNREPRESENTABLE = "[hooknostic: unrepresentable output]";

/** pi tool_result content parts are strings; coerce anything else. */
export function serializePiOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    const json = JSON.stringify(output);
    if (json !== undefined) return json;
  } catch {
    // Fall through to the total conversion below.
  }
  try {
    return String(output);
  } catch {
    return UNREPRESENTABLE;
  }
}

export function planPiApplication(result: HookResult): PiApplication {
  const application: PiApplication = {};

  const terminal = result.terminatedBy !== undefined ? result.effects[result.effects.length - 1]?.effect : undefined;

  if (terminal?.kind === "block") {
    if (result.event === "tool.before") {
      application.block = { reason: terminal.reason };
    } else if (result.event === "context.compact.before") {
      application.compactCancel = true;
    }
    // prompt.before block and permission.request block have no reliable pi
    // channel (profile cells unrated) — dispatch already rejects the effect
    // as an undeclared capability before apply sees it.
  }

  const replacedInput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceInput")?.effect as
    { input: unknown } | undefined;
  if (replacedInput !== undefined && application.block === undefined && result.event === "tool.before") {
    application.inputReplacement = replacedInput.input;
  }

  const replacedOutput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceOutput")?.effect as
    { output: unknown } | undefined;
  if (replacedOutput !== undefined && result.event === "tool.after") {
    application.resultReplacement = {
      content: [{ type: "text", text: serializePiOutput(replacedOutput.output) }],
    };
  }

  const context = result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
  if (context.length > 0 && result.event === "prompt.before") {
    application.injectedMessage = {
      customType: "hooknostic",
      content: context.join("\n"),
      display: false,
    };
  }
  if (context.length > 0 && result.event === "model.request.before") {
    // The context event replaces the whole message array; the shim appends
    // the context strings as user messages to the array pi handed it.
    application.contextMessages = context;
  }
  // tool.before.context.add: pi's tool_call has no context channel —
  // the capability is unrated and dispatch rejects the effect first.

  if (result.event === "turn.stop" && terminal?.kind === "preventStop") {
    application.sendMessage = [{ content: terminal.reason ?? "hooknostic: continue working", triggerTurn: true }];
  }

  return application;
}

export function applyPi(
  result: HookResult,
  _nativeEvent: unknown,
  _invocation: InvocationContext,
): Promise<NativeHookResult> {
  return Promise.resolve({ body: planPiApplication(result) });
}
