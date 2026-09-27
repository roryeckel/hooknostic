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
      const payload = harness === "pi" ? JSON.stringify(JSON.parse(line).payload) : line;
      writeFileSync(join(dst, `${file.replace(".jsonl", "")}-${index}.json`), payload, "utf8");
      count += 1;
    }
  }
  return { dst, count };
}
