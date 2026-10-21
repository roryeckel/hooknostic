// Teeing hook command for the GitHub Copilot CLI capture project.
//
// usage: node tee.mjs <captureDir> <label> [outputJson] [exitCode]
//
// Appends the exact stdin payload to <captureDir>/<label>.jsonl, then prints
// `outputJson` (when given) and exits with `exitCode` (default 0). Both are
// static per hook entry: the driver writes them into the session's hook file,
// so a probe can verify an output channel by its effect.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [captureDir, label, outputJson, exitCode] = process.argv.slice(2);
const input = readFileSync(0, "utf8");
mkdirSync(captureDir, { recursive: true });
appendFileSync(
  join(captureDir, `${label}.jsonl`),
  `${JSON.stringify({ at: new Date().toISOString(), input: input.trim() })}\n`,
);
if (outputJson !== undefined && outputJson !== "") process.stdout.write(`${outputJson}\n`);
process.exit(Number(exitCode ?? "0"));
