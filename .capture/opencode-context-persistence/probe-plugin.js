// Vanilla @opencode-ai/plugin probe. No repo imports.
// Pushes a marker into output.system on the FIRST system.transform call seen
// for a session id and never again. "Seen" is persisted to a file so a second
// `opencode run --session` process behaves as though plugin state survived;
// the only thing under test is whether the harness itself keeps the string.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CAP = join(process.env.PROBE_DIR ?? process.cwd(), "captured");
try { mkdirSync(CAP, { recursive: true }); } catch {}
const SEEN = join(CAP, "seen.txt");
const seenSet = () => { try { return new Set(readFileSync(SEEN, "utf8").split("\n").filter(Boolean)); } catch { return new Set(); } };

export const ProbePlugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    const sid = input?.sessionID ?? "none";
    const first = !seenSet().has(sid);
    if (first) {
      appendFileSync(SEEN, sid + "\n");
      output.system.push("HOOKNOSTIC_PROBE_ONCE_ONLY");
    }
    try {
      appendFileSync(join(CAP, "system-transform.jsonl"), JSON.stringify({ sid, injected: first, systemLenAfter: output.system.length }) + "\n");
    } catch {}
  },
});
