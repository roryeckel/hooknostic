// Capture probe: what does Claude Code actually DO with a Stop hook's output?
//
// `.capture/claude/capture.mjs` tees stdin, which answers what the harness sends.
// This answers the opposite question — which responses the harness honours — by
// emitting one candidate per run and recording what came back.
//
// Select with HOOKNOSTIC_PROBE. Each candidate carries a unique nonce per field
// so a transcript grep is unambiguous about which field produced a given line.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURED = join(dirname(fileURLToPath(import.meta.url)), "captured");
const VARIANT = process.env.HOOKNOSTIC_PROBE ?? "A-exit2";

const REASON = "HKN-R-7c4f1";
const NOTICE = "HKN-S-3ba90";
const CONTEXT = "HKN-C-11def";

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

// Loop guard. Claude re-runs Stop hooks after a block, with stop_hook_active set;
// a candidate that always blocks would otherwise run until the block cap trips.
if (received.stop_hook_active === true) emit({ exitCode: 0, stdout: "{}" });

const CANDIDATES = {
  // Control: the encoding the Claude adapter ships today.
  "A-exit2": { exitCode: 2, stderr: `${REASON} keep working` },

  // Does exit-0 JSON prevent a stop? The load-bearing question: if yes,
  // preventStop can move off exit 2 and compose with a user-visible notice.
  "B-json-block": {
    exitCode: 0,
    stdout: JSON.stringify({ decision: "block", reason: `${REASON} keep working` }),
  },

  // baseline-2026-08-20.md:76-77 claims "allow"|"deny". The binary's enum is
  // ["approve","block"], so this should be REJECTED, not honoured.
  "C-json-deny": {
    exitCode: 0,
    stdout: JSON.stringify({ decision: "deny", reason: REASON }),
  },

  // notify, alone. Expect: visible to the user, absent from model content.
  "D-notify": { exitCode: 0, stdout: JSON.stringify({ systemMessage: NOTICE }) },

  // notify + prevent in one body — the composition the whole change depends on.
  "E-compose": {
    exitCode: 0,
    stdout: JSON.stringify({
      decision: "block",
      reason: `${REASON} keep working`,
      systemMessage: NOTICE,
    }),
  },

  // Claude has a StopHookSpecificOutput variant whose own description says the
  // conversation continues so the model can act on the context. Unregistered as
  // a hooknostic capability; worth knowing whether it is real.
  "F-hso": {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: CONTEXT },
    }),
  },

  // Plain stdout on exit 0. Context on UserPromptSubmit/SessionStart; unknown here.
  "G-stdout": { exitCode: 0, stdout: `${NOTICE} plain stdout` },
};

emit(CANDIDATES[VARIANT] ?? { exitCode: 0 });
