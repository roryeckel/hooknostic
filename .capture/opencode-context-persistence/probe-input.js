// Dumps the full experimental.chat.system.transform envelope (input + output
// before/after) so title and build requests can be compared field by field.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = join(process.env.PROBE_DIR ?? process.cwd(), "captured");
try { mkdirSync(CAP, { recursive: true }); } catch {}
const safe = (v) => {
  const seen = new WeakSet();
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === "function") return "[fn]";
    if (x && typeof x === "object") { if (seen.has(x)) return "[circ]"; seen.add(x); }
    return x;
  });
};
export const ProbePlugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    try {
      appendFileSync(join(CAP, "envelope.jsonl"), safe({ input, systemLen: output.system.length, systemHeads: output.system.map((s) => String(s).slice(0, 60)) }) + "\n");
    } catch {}
  },
});
