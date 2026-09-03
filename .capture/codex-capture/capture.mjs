// Tee capture: append the hook's stdin JSON to a per-event file.
//
// Path-independent by design: the tee lives next to this script, wherever the
// template was instantiated (`.capture/codex-capture/` in the repo, or a
// scratch copy made by a drift driver / the harness-watch LLM lane). Codex
// hooks.json command strings carry no ${CLAUDE_PROJECT_DIR}-style variable, so
// the instantiating step bakes the install directory into the generated
// hooks.json — see hooks.json.template.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const event = process.argv[2] ?? "unknown";
const dir = join(import.meta.dirname, "captured");
mkdirSync(dir, { recursive: true });

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
appendFileSync(join(dir, `${event}.jsonl`), input.trim() + "\n", "utf8");
process.exit(0);