// Promote probe-sessions.mjs captures into the reference fixture directory,
// with account redaction. Each fixture is one captured native invocation
// `{event, ctx}`, exactly as the tee recorded it. Run from the repository root:
//   node --experimental-strip-types .capture/pi/promote-sessions.mjs
// then regenerate canonicals with make-canonical.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtures = fileURLToPath(new URL(`../../fixtures/pi/${piHarness.fixtureDir}/`, import.meta.url));
const base = join(here, "captured-sessions", "win32");
const metadata = JSON.parse(readFileSync(join(base, "metadata.json"), "utf8"));
if (metadata.version !== piHarness.referenceVersion) throw new Error(`Unexpected harness build: ${metadata.version}`);
const redaction = createRedaction(metadata.account);
redaction.recordCapture(metadata);

/** [fixture, session, native event, pick] -- pick selects one captured invocation. */
const first = (rows) => rows[0];
const CASES = [
  ["session-start", "basic", "session_start", first],
  ["before-agent-start-isolated", "basic", "before_agent_start", first],
  ["context", "basic", "context", first],
  ["tool-call-bash", "basic", "tool_call", first],
  ["tool-result-bash", "basic", "tool_result", first],
  ["agent-settled", "basic", "agent_settled", first],
  ["session-shutdown", "basic", "session_shutdown", first],
  ["tool-call-powershell", "powershell", "tool_call", first],
  ["tool-result-powershell", "powershell", "tool_result", first],
  ["before-agent-start", "populated", "before_agent_start", first],
  ["tool-result-error", "populated", "tool_result", first],
  ["session-before-compact", "compact-run", "session_before_compact", first],
  ["session-compact", "compact-run", "session_compact", first],
  ["session-compact-failed", "compact-cancel", "session_compact_failed", first],
  [
    "before-agent-start-custom",
    "continuation",
    "before_agent_start",
    (rows) => rows.find((row) => row.event.messageType === "custom"),
  ],
];

for (const [fixture, session, event, pick] of CASES) {
  const dir = join(base, session);
  const observation = JSON.parse(readFileSync(join(dir, "observation.json"), "utf8"));
  redaction.recordCapture(observation);
  if (observation.exitCode !== 0) throw new Error(`Unsuccessful capture: ${session}`);
  if (observation.version !== piHarness.referenceVersion) throw new Error(`Unexpected harness build: ${session}`);
  const path = join(dir, "events", `${event}.jsonl`);
  if (!existsSync(path)) throw new Error(`${session}: no ${event} captured`);
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).payload);
  const payload = pick(rows);
  if (payload === undefined) throw new Error(`${fixture}: no matching ${event} in ${session}`);
  const text = JSON.stringify(redaction.redact(payload), null, 2) + "\n";
  writeFileSync(join(fixtures, `${fixture}.input.json`), redaction.published(text));
  console.log(`wrote ${fixture}.input.json`);
}
