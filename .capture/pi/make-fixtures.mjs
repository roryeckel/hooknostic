// Curate fixtures from captured payloads (one-time; kept for reproducibility).
// Extracts event payloads from .capture/pi/captured-*/, redacts the capturing
// account name to `user` (drive letter and shape preserved per the
// harness-capture skill), and writes fixtures/pi/0.84/<case>.input.json.
//
// The input fixtures are the raw native event objects pi handed to the
// extension handler, plus the ctx fields the shim receives (cwd, mode).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixturesDir = join(repoRoot, "fixtures", "pi", "0.84");
mkdirSync(fixturesDir, { recursive: true });

// The capturing account name, never hard-coded: this script is committed, and
// a literal here would publish the very name the redaction removes. Falls
// back to a generic sentinel when the session that runs it is not the
// capturing one (re-curation on another machine must fail visibly in the
// redaction check, not silently pass).
const ACCOUNT = process.env["USERNAME"] ?? "capturing-account-unknown";

/** Redact only the account-name segment; preserve drive letters and shape. */
function redact(value) {
  if (typeof value === "string") {
    // Only in path-like strings: C--Users-<account> and C:\Users\<account>
    // (any drive-letter casing; environments dumps contain c:\Users\… too).
    const pattern = ACCOUNT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value
      .replaceAll(`C:\\\\Users\\\\${ACCOUNT}`, "C:\\\\Users\\\\user")
      .replaceAll(`C:\\Users\\${ACCOUNT}`, "C:\\Users\\user")
      .replaceAll(`C--Users-${ACCOUNT}`, "C--Users-user")
      .replaceAll(`C:/Users/${ACCOUNT}`, "C:/Users/user");
    value = value.replace(new RegExp(`([Cc]):([\\\\/])users\\2${pattern}\\2`, "gi"), "$1:$2Users$2user$2");
    // POSIX drive forms /c|C/Users/<acct> (any casing, optional trailing /)
    value = value.replace(new RegExp(`/[cC]/[uU]sers/${pattern}`, "g"), "/c/Users/user");
    // Bare \Users\<acct> (HOMEPATH) and env-var account values
    value = value.replaceAll(`\\Users\\${ACCOUNT}`, "\\Users\\user");
    value = value.replace(new RegExp(`USERNAME=${pattern}`, "g"), "USERNAME=user");
    value = value.replace(new RegExp(`USERDOMAIN=${pattern}`, "gi"), "USERDOMAIN=USER");
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

/**
 * Beyond account-name redaction: scrub credential-bearing strings. The
 * compact fixture's branchEntries embed a bash toolResult whose content is a
 * full environment dump (the bash tool inherits the capturing user's env);
 * it contained a live API token (AI_PAT=…). Environment dumps are not wire
 * shape — replace the whole string, and record it in the fixtures README.
 */
function scrubEnvDumps(value) {
  if (typeof value === "string") {
    if (value.includes("AI_PAT=") || /(\n|^)_=\/usr\/bin\/env/.test(value) || value.includes("--- .env.tmp")) {
      return "[redacted: environment dump captured in session tool output; contained live credentials]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(scrubEnvDumps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubEnvDumps(v);
    return out;
  }
  return value;
}

/** Load the first record of a captured channel. */
function first(capturedDir, channel) {
  const line = readFileSync(join(capturedDir, `${channel}.jsonl`), "utf8").trim().split("\n")[0];
  return JSON.parse(line);
}

/**
 * Fixture input shape: the invocation the shim receives = native event object
 * (live, pre-serialization) + ctx fields. Matches the tee's envelope minus
 * the tee's own wrapper: `{ event, ctx: { cwd, mode } }`.
 */
function invocation(capturedDir, channel, pick = 0) {
  const lines = readFileSync(join(capturedDir, `${channel}.jsonl`), "utf8").trim().split("\n");
  const rec = JSON.parse(lines[pick]);
  return scrubEnvDumps(redact({ event: rec.payload.event, ctx: rec.payload.ctx }));
}

/**
 * Pick a tool channel record by tool name, not position. The capture
 * directories are append-only: re-running a probe shifts every index, which
 * silently relabelled a write call as the bash fixture once already.
 */
function toolRecord(capturedDir, channel, toolName, where = () => true) {
  const lines = readFileSync(join(capturedDir, `${channel}.jsonl`), "utf8").trim().split("\n");
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.payload.event.toolName === toolName && where(rec.payload.event)) return rec;
  }
  throw new Error(`no ${toolName} record in ${capturedDir}/${channel}.jsonl`);
}

function toolEnvelope(capturedDir, channel, toolName, where = () => true) {
  const rec = toolRecord(capturedDir, channel, toolName, where);
  return scrubEnvDumps(redact({ event: rec.payload.event, ctx: rec.payload.ctx }));
}

const cases = [];

// --- tee run: session lifecycle -------------------------------------------
{
  const d = join(here, "captured-tee");
  cases.push(["session-start", invocation(d, "session_start")]);
  cases.push(["before-agent-start", invocation(d, "before_agent_start")]);
  cases.push(["context", invocation(d, "context")]);
  // The bash pair is the first bash call whose result is a success, so the
  // bash fixture decodes to tool.after rather than tool.error.
  const bashCallId = toolRecord(d, "tool_result", "bash", (rec) => rec.isError !== true).payload.event.toolCallId;
  cases.push(["tool-call-write", toolEnvelope(d, "tool_call", "write")]);
  cases.push(["tool-call-bash", toolEnvelope(d, "tool_call", "bash", (event) => event.toolCallId === bashCallId)]);
  cases.push(["tool-result-write", toolEnvelope(d, "tool_result", "write")]);
  cases.push([
    "tool-result-bash",
    toolEnvelope(d, "tool_result", "bash", (event) => event.toolCallId === bashCallId),
  ]);
  // pi's per-prompt loop events (turn_start/turn_end/agent_start/agent_end)
  // have no canonical counterpart: agent.start/agent.stop are subagent
  // events (Claude's SubagentStart/Stop), and turn.stop maps from
  // agent_settled. Deliberately not fixture'd -- the contract suite fails on
  // fixtures for unadvertised events.
  cases.push(["agent-settled", invocation(d, "agent_settled")]);
  cases.push(["session-shutdown", invocation(d, "session_shutdown")]);
}
// --- tool error run ---------------------------------------------------------
{
  const d = join(here, "captured-tool-error");
  cases.push(["tool-result-error", invocation(d, "tool_result")]);
}
// --- compact-cancel run ------------------------------------------------------
{
  const d = join(here, "captured-compact-cancel");
  cases.push(["session-before-compact", invocation(d, "session_before_compact")]);
  cases.push(["session-compact-failed", invocation(d, "session_compact_failed")]);
}
// --- compact-run run ---------------------------------------------------------
{
  const d = join(here, "captured-compact-run");
  cases.push(["session-compact", invocation(d, "session_compact")]);
}

for (const [name, value] of cases) {
  const file = join(fixturesDir, `${name}.input.json`);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`wrote ${name}.input.json`);
}
