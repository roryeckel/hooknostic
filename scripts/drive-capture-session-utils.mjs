// Small, runtime-independent helpers for the drift capture driver. Keeping
// these separate lets their filesystem and entrypoint behavior be tested
// without loading the driver's TypeScript playback dependencies.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SYNTHETIC_CAPTURE_FILES = {
  // The OpenCode tee records its own module initialization as a diagnostic.
  // It is not a native hook callback and has no fixture counterpart.
  opencode: new Set(["plugin-load.jsonl"]),
};

/** True only when Node invoked this module as the CLI entrypoint. */
export { isMainModule as isEntrypoint } from "./is-main-module.mjs";

/** List raw tee output files, including diagnostics preserved for artifacts. */
export function listCaptured(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
}

/**
 * Whether a Copilot capture exercised the tool exchange: at least one
 * `preToolUse`-shaped payload and one `postToolUse`-shaped payload, both from
 * the same drive. The comparison's expected-variant accounting cannot state
 * this because Copilot's variant includes the platform's runtime tool name
 * (`bash` or `powershell`); a missing half is otherwise a clean verdict.
 */
export function hasCopilotToolExchange(payloads) {
  let before = false;
  let after = false;
  for (const payload of payloads) {
    if (typeof payload?.toolName !== "string") continue;
    if (payload.hookName === "permissionRequest") continue;
    if (payload.toolResult !== undefined) after = true;
    else if (payload.error === undefined) before = true;
  }
  return before && after;
}

/**
 * Convert raw per-event JSONL tee output to one payload per JSON file for the
 * comparator. Synthetic tee diagnostics remain in the raw-capture artifact
 * but never become comparator input.
 */
export function flattenCaptured(dir, harness) {
  const dst = `${dir}-json`;
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const ignored = SYNTHETIC_CAPTURE_FILES[harness] ?? new Set();
  let count = 0;
  for (const file of listCaptured(dir)) {
    if (ignored.has(file)) continue;
    const lines = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    for (const [index, line] of lines.entries()) {
      // Pi tees {event: <channel>, payload: {event, ctx}}; its fixtures
      // contain the invocation envelope, not the tee's recording wrapper.
      // Copilot's tee records {at, input} where input is the native payload as
      // a JSON string; the comparator expects that payload itself.
      const payload =
        harness === "pi"
          ? JSON.stringify(JSON.parse(line).payload)
          : harness === "copilot"
            ? JSON.stringify(JSON.parse(JSON.parse(line).input))
            : line;
      writeFileSync(join(dst, `${file.replace(".jsonl", "")}-${index}.json`), payload, "utf8");
      count += 1;
    }
  }
  return { dst, count };
}
