// Capture probe: does Codex honour — and actually render — a Stop hook's output?
//
// The `stop.command.output` wire schema accepts `systemMessage`, but accepting a
// field and displaying it are different things, and the 0.148.0 binary contains
// no rendering path for it (the string appears only in serde field tables). This
// probe settles whether Codex `notify` is supportable or merely well-formed.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURED = join(dirname(fileURLToPath(import.meta.url)), "captured");
const VARIANT = process.env.HOOKNOSTIC_PROBE ?? "A-exit2";

const REASON = "HKN-R-7c4f1";
const NOTICE = "HKN-S-3ba90";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let received = {};
try {
  received = raw ? JSON.parse(raw) : {};
} catch {
  received = { parseError: raw.slice(0, 400) };
}

function emit(chosen) {
  mkdirSync(CAPTURED, { recursive: true });
  appendFileSync(
    join(CAPTURED, `${received.hook_event_name ?? "unknown"}.jsonl`),
    `${JSON.stringify({ variant: VARIANT, received, emitted: chosen })}\n`,
    "utf8",
  );
  if (chosen.stderr) process.stderr.write(chosen.stderr);
  if (chosen.stdout) process.stdout.write(chosen.stdout);
  process.exit(chosen.exitCode ?? 0);
}

// Codex sets stop_hook_active after a block, same as Claude. Without this guard a
// blocking candidate runs until the turn budget is gone.
if (received.stop_hook_active === true) emit({ exitCode: 0, stdout: "{}" });

const CANDIDATES = {
  // Codex rejects a bare exit 2 on Stop: "exited with code 2 but did not write a
  // continuation prompt to stderr". stderr is mandatory here.
  "A-exit2": { exitCode: 2, stderr: `${REASON} keep working` },

  "B-json-block": {
    exitCode: 0,
    stdout: JSON.stringify({ decision: "block", reason: `${REASON} keep working` }),
  },

  "D-notify": { exitCode: 0, stdout: JSON.stringify({ systemMessage: NOTICE }) },

  "E-compose": {
    exitCode: 0,
    stdout: JSON.stringify({
      decision: "block",
      reason: `${REASON} keep working`,
      systemMessage: NOTICE,
    }),
  },
};

emit(CANDIDATES[VARIANT] ?? { exitCode: 0 });
