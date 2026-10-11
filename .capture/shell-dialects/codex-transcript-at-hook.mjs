// Codex probe hook: at PreToolUse, read the session transcript the payload names
// and record only what it says about the shell -- the pending call's own
// arguments and any shell the harness stated to the model. Evidence about the
// transcript file at hook time, not about the hook payload.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "captured");
mkdirSync(dir, { recursive: true });

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const record = { tool_use_id: payload.tool_use_id, transcriptExists: false };
const path = payload.transcript_path;
if (typeof path === "string" && existsSync(path)) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter(Boolean);
  record.transcriptExists = true;
  record.lines = lines.length;
  record.statedShells = [...text.matchAll(/<shell>([^<]*)<\/shell>/g)].map((match) => match[1]);
  record.calls = [];
  record.shellKeys = [];
  const visit = (value, trail) => {
    if (value === null || typeof value !== "object") return;
    if (value.call_id === payload.tool_use_id) {
      record.calls.push({ at: trail, type: value.type, name: value.name, arguments: value.arguments });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "shell" && typeof child === "string") record.shellKeys.push({ at: trail + "." + key, value: child });
      visit(child, trail + "." + key);
    }
  };
  lines.forEach((line, index) => {
    try {
      visit(JSON.parse(line), "line" + index);
    } catch {
      record.unparsed = (record.unparsed ?? 0) + 1;
    }
  });
}
appendFileSync(join(dir, "transcript-at-PreToolUse.jsonl"), JSON.stringify(record) + "\n", "utf8");
process.exit(0);
