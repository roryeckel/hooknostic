// Pi tee-capture extension.
//
// Registers every event the adapter would observe, teeing each invocation's
// event payload to `captured/<event>.jsonl`. Also serves as the effect-probe
// extension: `HKN_PI_PROBE` selects a mutation experiment so one file covers
// both passive capture and effect verification (harness-capture skill:
// verify effects by effect, never by harness output).
//
// Deliberately zero repo imports: a capture probe must not depend on the
// library it is capturing evidence about (same discipline as
// .capture/opencode-capture/hooknostic-capture.js).
//
// Provenance class: captured (live in-process objects, serialized at capture
// time). pi hands extensions live event objects; the tee serializes a
// degraded CLONE (safeStringify -> toSerializeable) and never mutates what
// it was handed in tee mode. Probe modes DO mutate -- that is the experiment
// -- but only in the probe-selected event, never in the tee.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAPTURE_DIR = process.env["HKN_CAPTURE_DIR"] ?? join(import.meta.dirname, "captured");
const PROBE = process.env["HKN_PI_PROBE"] ?? "tee";
const MARKER = process.env["HKN_PI_MARKER"] ?? "hooknostic-marker";

mkdirSync(CAPTURE_DIR, { recursive: true });

function toSerializeable(value, seen = new Map()) {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return `[bigint:${String(value)}]`;
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    clone[key] = toSerializeable(child, seen);
  }
  return clone;
}

function safeStringify(value) {
  try {
    return JSON.stringify(toSerializeable(value));
  } catch (error) {
    return JSON.stringify({ serializeError: String(error) });
  }
}

function tee(name, payload) {
  const line =
    JSON.stringify({
      event: name,
      payload: JSON.parse(safeStringify(payload)),
    }) + "\n";
  appendFileSync(join(CAPTURE_DIR, `${name}.jsonl`), line, "utf8");
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  const handlers = [
    "session_start",
    "session_info_changed",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
    "session_shutdown",
    "session_before_tree",
    "session_tree",
    "context",
    "before_provider_request",
    "before_agent_start",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "model_select",
    "thinking_level_select",
    "user_bash",
    "input",
    "tool_call",
    "tool_result",
  ];
  for (const name of handlers) {
    pi.on(name, async (event, ctx) => {
      // Serialize BEFORE any probe mutation so the tee records what pi sent.
      const snapshot = JSON.parse(safeStringify(event));
      const ctxInfo = { cwd: ctx?.cwd, mode: ctx?.mode };
      tee(name, { event: snapshot, ctx: ctxInfo });

      // Effect probes. Each returns the handler result pi should see.
      if (PROBE === "block-bash" && name === "tool_call" && event.toolName === "bash") {
        return { block: true, reason: `blocked by probe: ${MARKER}` };
      }
      if (PROBE === "mutate-input" && name === "tool_call" && event.toolName === "bash") {
        // In-place mutation per the doc comment on ToolCallEvent.
        event.input.command = `echo mutated-by-probe ${MARKER}`;
      }
      if (PROBE === "replace-output" && name === "tool_result" && event.toolName === "bash") {
        return { content: [{ type: "text", text: `replaced-by-probe ${MARKER}` }] };
      }
      if (PROBE === "inject-before-agent" && name === "before_agent_start") {
        return {
          message: { customType: "hooknostic-probe", content: `injected-by-probe ${MARKER}`, display: false },
          systemPrompt: event.systemPrompt + `\nInjected-by-probe marker: ${MARKER}`,
        };
      }
      if (PROBE === "compact-cancel" && name === "agent_end") {
        ctx.compact();
      }
      if (PROBE === "compact-run" && name === "agent_end") {
        ctx.compact();
      }
      if (PROBE === "compact-cancel" && name === "session_before_compact") {
        return { cancel: true };
      }
      if (PROBE === "input-handled" && name === "input" && event.text.includes("SUPPRESS-ME")) {
        return { action: "handled" };
      }
      if (PROBE === "input-handled-first" && name === "input") {
        if (!globalThis.__hknHandledFirst) {
          globalThis.__hknHandledFirst = true;
          return { action: "handled" };
        }
      }
      if (PROBE === "context-inject" && name === "context") {
        // Verify the return-replacement path: append a marker message.
        return {
          messages: [
            ...event.messages,
            { role: "user", content: [{ type: "text", text: `context-injected ${MARKER}` }] },
          ],
        };
      }
      if (PROBE === "notify-ui" && name === "agent_settled") {
        if (!globalThis.__hknNotifyFired) {
          globalThis.__hknNotifyFired = true;
          ctx.ui.notify(`notify-ui-marker ${MARKER}`, "info");
        }
      }
      if (PROBE === "prevent-stop" && name === "agent_settled") {
        // Only inject once; the injected turn settles again and would loop.
        if (!globalThis.__hknPreventStopFired) {
          globalThis.__hknPreventStopFired = true;
          pi.sendMessage(
            { customType: "hooknostic-probe", content: `prevent-stop-injected ${MARKER}`, display: false },
            { triggerTurn: true },
          );
        }
      }
      return undefined;
    });
  }
}