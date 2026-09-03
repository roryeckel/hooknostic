// OpenCode tee-capture plugin.
//
// Registers every hook the adapter observes (packages/adapter-opencode/src/
// shim.ts: createOpenCodeHooks) plus the never-fires `permission.ask`
// negative-evidence channel, teeing each invocation's native envelope to
// `captured/<hook>.jsonl`. The envelope matches the fixtures' invocation
// shape (fixtures/opencode/1.18/README.md):
//
//   { hook, directory, worktree?, input, output }
//
// Deliberately a vanilla @opencode-ai/plugin module with zero repo imports:
// the drift driver copies this project into a scratch dir outside the repo,
// where @hooknostic/* does not resolve, and a capture probe must not depend
// on the library it is capturing evidence about.
//
// Serialization caveat (the reason for the clone): plugins receive live
// in-process objects the harness keeps using after the callback. They can
// contain cycles (client handles), BigInt-ish values, or getters; a plain
// JSON.stringify can throw mid-write and lose the capture. safeStringify
// builds a degraded CLONE — it never mutates what it was handed.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** @type {string} */
const CAPTURE_DIR = process.env["HKN_CAPTURE_DIR"] ?? join(import.meta.dirname, "captured");

mkdirSync(CAPTURE_DIR, { recursive: true });

/**
 * JSON with per-value degradation: seen-object slots render as
 * "[circular]", unknowns as "[unserializable: <typeof>]", and a top-level
 * failure still yields a line (with the error) rather than nothing.
 * Undefined-valued keys are DROPPED (not stringified): real payloads omit
 * them, and keeping "[undefined]" strings would manufacture shape drift
 * against fixtures whose hosts omitted the key.
 *
 * Serializes a CLONE, never the live callback objects themselves: `input`/
 * `output` are handed to us in-process and the harness keeps using them after
 * the callback returns (harness-capture guidance: behavioral facts live on
 * live objects — mutation from a capture probe could alter tool args the
 * harness then executes).
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(toSerializeable(value));
  } catch (error) {
    return JSON.stringify({ serializeError: String(error) });
  }
}

/**
 * Non-mutating deep clone for serialization: plain objects/arrays are
 * rebuilt with their undefined-valued keys dropped and bigint/function
 * values stringified; cycles render as "[circular]" in the clone. Anything
 * not JSON-representable degrades to a placeholder or `undefined` (dropped).
 * @param {unknown} value
 * @param {Map<object, unknown>} [seen] — in-progress objects → their clone
 * @returns {unknown}
 */
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

/**
 * @param {string} hook
 * @param {unknown} input
 * @param {unknown} [output]
 */
function tee(hook, input, output) {
  const line =
    JSON.stringify({
      hook,
      directory: process.env["HKN_CAPTURE_CWD"] ?? process.cwd(),
      input: JSON.parse(safeStringify(input)),
      ...(output === undefined ? {} : { output: JSON.parse(safeStringify(output)) }),
    }) + "\n";
  appendFileSync(join(CAPTURE_DIR, `${hook}.jsonl`), line, "utf8");
}

/**
 * @param {import("@opencode-ai/plugin").PluginInput} ctx
 * @returns {import("@opencode-ai/plugin").Hooks}
 */
export const HooknosticCapture = async (ctx) => {
  tee("plugin-load", { directory: ctx.directory, worktree: ctx.worktree });
  /** @type {import("@opencode-ai/plugin").Hooks} */
  const hooks = {
    "tool.execute.before": async (input, output) => {
      tee("tool.execute.before", input, output);
    },
    "tool.execute.after": async (input, output) => {
      tee("tool.execute.after", input, output);
    },
    "chat.message": async (input, output) => {
      tee("chat.message", input, output);
    },
    "experimental.session.compacting": async (input, output) => {
      tee("experimental.session.compacting", input, output);
    },
    // Negative-evidence channel: the documented permission.ask hook never
    // fires on 1.18.x (captured: .capture/opencode-permission, upstream
    // anomalyco/opencode #9229). If this file ever appears, the defect is
    // fixed and the capture record must be updated.
    "permission.ask": async (input, output) => {
      tee("permission.ask", input, output);
    },
    event: async (input) => {
      // The generic event hook receives { event: Event }, not the bus event
      // directly; tee the whole input so the envelope matches the fixtures'
      // invocation shape ({ hook, directory, input: { event } }). The
      // comparator filters to the adapter-mapped event types; everything
      // else is diagnostics.
      tee("event", input);
    },
  };
  return hooks;
};

export default HooknosticCapture;