// Fixture capture: append the hook's stdin JSON to a per-event file.
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
