import type { InvocationContext, NativeHookResult } from "@hooknostic/core";
import type { HookResult } from "@hooknostic/sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(output: unknown): string {
  // The native replacement is one text field. A string is that text; anything
  // else is JSON-encoded whole, because extracting a property would silently
  // discard the rest of a portable replacement object.
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

/**
 * Encode a composed HookResult into the GitHub COPILOT CLI hook output.
 *
 * The camelCase hook format reads ONE JSON object from stdout. Fields are
 * shared across events (permissionDecision, modifiedArgs, additionalContext,
 * decision/reason, modifiedResult, behavior/message); an event simply ignores
 * the ones it does not consume. The command hook's exit code is only used for
 * failure: exit 2 denies a preToolUse/permissionRequest call, and any other
 * non-zero exit also denies a preToolUse call (the harness is fail-closed
 * there), so every intentional deny is encoded as JSON on exit 0, which keeps
 * one well-formed answer and avoids the exit-2 ambiguity.
 */
export function applyCopilot(
  result: HookResult,
  nativeEvent: unknown,
  _invocation: InvocationContext,
): Promise<NativeHookResult> {
  const terminal = result.terminatedBy !== undefined ? result.effects[result.effects.length - 1]?.effect : undefined;
  const replacedInput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceInput")?.effect as
    { input: unknown } | undefined;
  const replacedOutput = [...result.effects].reverse().find((e) => e.effect.kind === "replaceOutput")?.effect as
    { output: unknown } | undefined;
  const context = result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);

  const body: Record<string, unknown> = {};
  const addContext = () => {
    if (context.length > 0) body["additionalContext"] = context.join("\n\n");
  };

  switch (result.event) {
    case "tool.before": {
      if (terminal?.kind === "block") {
        // Denial precedence: a rewrite or context recorded earlier in the same
        // dispatch must not ride along on a deny. The harness short-circuits on
        // a deny and runs no further hook.
        return Promise.resolve({
          exitCode: 0,
          body: {
            permissionDecision: "deny",
            permissionDecisionReason: terminal.reason,
          },
        });
      }
      if (terminal?.kind === "requestApproval") {
        body["permissionDecision"] = "ask";
        if (terminal.reason !== undefined) body["permissionDecisionReason"] = terminal.reason;
      }
      if (replacedInput !== undefined) body["modifiedArgs"] = replacedInput.input;
      addContext();
      break;
    }
    case "permission.request": {
      if (terminal?.kind === "block") {
        return Promise.resolve({
          exitCode: 0,
          body: { behavior: "deny", message: terminal.reason },
        });
      }
      // permissionRequest's output carries only behavior/message; there is no
      // captured context channel on it.
      break;
    }
    case "prompt.before": {
      // A decision block on exit 0 keeps the prompt from the model (captured:
      // no user message or model turn followed, and the reason was shown).
      if (terminal?.kind === "block") {
        return Promise.resolve({ exitCode: 0, body: { decision: "block", reason: terminal.reason } });
      }
      // additionalContext is dropped here, but modifiedPrompt reaches the model
      // while the timeline keeps the typed prompt (captured on 1.0.101), so the
      // context rides on the prompt text. Without the native prompt there is
      // nothing safe to replace, and the answer stays empty.
      const prompt = isRecord(nativeEvent) ? nativeEvent["prompt"] : undefined;
      if (context.length > 0 && typeof prompt === "string") {
        body["modifiedPrompt"] = [prompt, ...context].join("\n\n");
      }
      break;
    }
    case "tool.after": {
      if (terminal?.kind === "blockContinuation") {
        // A decision block replaces the result the model sees with "Tool result
        // blocked: <reason>" and drops an additionalContext beside it (both
        // captured), so context recorded earlier in the dispatch joins the
        // reason instead of vanishing.
        return Promise.resolve({
          exitCode: 0,
          body: { decision: "block", reason: [terminal.reason, ...context].join("\n\n") },
        });
      }
      if (replacedOutput !== undefined) {
        body["modifiedResult"] = { resultType: "success", textResultForLlm: textResult(replacedOutput.output) };
      }
      addContext();
      break;
    }
    case "tool.error": {
      addContext();
      break;
    }
    case "session.start": {
      addContext();
      break;
    }
    case "agent.stop":
    case "turn.stop": {
      if (terminal?.kind === "preventStop") {
        body["decision"] = "block";
        body["reason"] = terminal.reason ?? "hooknostic: continue working";
      }
      // There is no captured user-facing message channel on these events.
      break;
    }
    default:
      // Events with no output channel (session.end, context.compact.before:
      // a captured block and additionalContext were both ignored): their
      // capabilities do not include effects that would need one. Fail open
      // with an empty answer.
      break;
  }

  if (Object.keys(body).length === 0) return Promise.resolve({ exitCode: 0 });
  return Promise.resolve({ exitCode: 0, body });
}
