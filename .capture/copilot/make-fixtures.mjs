// Curate the GitHub Copilot CLI capture sessions into input fixtures.
//
// usage: node .capture/copilot/make-fixtures.mjs
//
// Reads the raw tees under .capture/copilot/captured/, redacts the capturing
// account name to `user`, and writes fixtures/copilot/1.0/*.input.json plus the
// per-fixture camelCase event hints and declined.json. Canonical files are
// generated from these inputs by the adapter's generate-canonical test.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CAPTURED = join(HERE, "captured");
const FIXTURES = join(ROOT, "fixtures", "copilot", "1.0");

/** The account segment to redact, and nothing else about a path. */
const ACCOUNT = process.env.HOOKNOSTIC_CAPTURE_ACCOUNT ?? userInfo().username;

function redact(value) {
  if (typeof value === "string") return value.replaceAll(ACCOUNT, "user");
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redact(entry)]));
  }
  return value;
}

function line(probe, file, index) {
  const path = join(CAPTURED, probe, `${file}.jsonl`);
  if (!existsSync(path)) throw new Error(`missing capture ${path}`);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const entry = lines.at(index);
  if (entry === undefined) throw new Error(`${path} has no line ${index}`);
  return redact(JSON.parse(JSON.parse(entry).input));
}

function named(probe, file, predicate) {
  const path = join(CAPTURED, probe, `${file}.jsonl`);
  if (!existsSync(path)) throw new Error(`missing capture ${path}`);
  for (const raw of readFileSync(path, "utf8").trim().split("\n")) {
    const payload = redact(JSON.parse(JSON.parse(raw).input));
    if (predicate(payload)) return payload;
  }
  throw new Error(`${path} has no matching line`);
}

const FIXTURES_TO_WRITE = {
  "session-start": line("camel-lifecycle", "sessionStart", 0),
  "session-start-pascal": line("pascal-lifecycle", "pascal-SessionStart", 0),
  "session-end": line("camel-lifecycle", "sessionEnd", 0),
  "prompt-before": line("camel-lifecycle", "userPromptSubmitted", 0),
  "tool-before": line("camel-lifecycle", "preToolUse", 0),
  "tool-before-bash": line("host-linux", "preToolUse", 0),
  "tool-before-create": named("tool-shapes", "preToolUse", (payload) => payload.toolName === "create"),
  "tool-before-edit": named("tool-shapes", "preToolUse", (payload) => payload.toolName === "edit"),
  "tool-before-pascal": named("pascal-tool-shapes", "PreToolUse", (payload) => payload.tool_name === "Write"),
  "tool-before-pascal-bash": line("pascal-lifecycle", "pascal-PreToolUse", 0),
  "tool-before-pascal-read": named("pascal-tool-shapes", "PreToolUse", (payload) => payload.tool_name === "Read"),
  "tool-before-pascal-edit": named("pascal-tool-shapes", "PreToolUse", (payload) => payload.tool_name === "Edit"),
  "tool-before-subagent": named(
    "shell-interpreter-bash",
    "preToolUse",
    (payload) => payload.agentId !== undefined && payload.toolName === "powershell",
  ),
  "tool-before-mcp": line("mcp-stdio", "preToolUse", 0),
  "tool-after": line("camel-lifecycle", "postToolUse", 0),
  "tool-after-bash": line("host-linux", "postToolUse", 0),
  "tool-after-pascal": named("pascal-tool-shapes", "PostToolUse", (payload) => payload.tool_name === "Write"),
  "tool-error": line("tool-failure", "postToolUseFailure", 0),
  "permission-request": line("camel-lifecycle", "permissionRequest", 0),
  "permission-request-mcp": line("mcp-permission", "permissionRequest", 0),
  "agent-start": line("subagent", "subagentStart", 0),
  "agent-start-pascal": called("pascal-subagent", "SubagentStart", 0),
  "agent-stop": line("subagent", "subagentStop", 0),
  "turn-stop": line("camel-lifecycle", "agentStop", 0),
  "turn-stop-subagent": line("subagent", "agentStop", 0),
  "turn-stop-pascal": named("pascal-subagent", "Stop", (payload) => payload.agent_id !== undefined),
  "pre-compact": line("interactive-compact", "preCompact", 0),
};

function called(probe, file, index) {
  return line(probe, file, index);
}

/** Native events the camelCase payload format does not state. */
const HINTS = {
  "session-start": "sessionStart",
  "session-end": "sessionEnd",
  "prompt-before": "userPromptSubmitted",
  "tool-before": "preToolUse",
  "tool-before-bash": "preToolUse",
  "tool-before-create": "preToolUse",
  "tool-before-edit": "preToolUse",
  "tool-before-subagent": "preToolUse",
  "tool-before-mcp": "preToolUse",
  "tool-after": "postToolUse",
  "tool-after-bash": "postToolUse",
  "tool-error": "postToolUseFailure",
  "permission-request": "permissionRequest",
  "permission-request-mcp": "permissionRequest",
  "agent-start": "subagentStart",
  "agent-start-pascal": "SubagentStart",
  "agent-stop": "subagentStop",
  "turn-stop": "agentStop",
  "turn-stop-subagent": "agentStop",
  "pre-compact": "preCompact",
};

const DECLINED = {
  "user-prompt-transformed": {
    payload: line("camel-lifecycle", "userPromptTransformed", 0),
    hint: "userPromptTransformed",
    reason: "Copilot transforms a submitted prompt into model-facing content; no portable event names that moment.",
  },
  "error-occurred": {
    payload: line("error-model", "errorOccurred", 0),
    hint: "errorOccurred",
    reason: "Copilot's error event has no portable counterpart, and tool.error needs a tool invocation it does not carry.",
  },
  // Captured on Linux (1.0.101): a background shell finishing while the agent
  // was busy, and a background subagent going idle.
  "notification-shell-completed": {
    payload: line("notification-shell-while-busy", "notification", 0),
    hint: "notification",
    reason:
      "Copilot's notification reports asynchronous status (a background shell completed, an agent went idle, a permission prompt); no portable event names it, and it is fire-and-forget.",
  },
  "notification-agent-idle": {
    payload: line("notification-background-agent", "notification", 0),
    hint: "notification",
    reason:
      "Copilot's notification reports asynchronous status (a background shell completed, an agent went idle, a permission prompt); no portable event names it, and it is fire-and-forget.",
  },
};

mkdirSync(FIXTURES, { recursive: true });
// Keep the provenance README: it is authored, not generated by this script.
for (const file of readdirSync(FIXTURES)) {
  if (file.endsWith(".input.json") || file.endsWith(".canonical.json") || file.endsWith(".enrichment.json") || file === "declined.json") {
    rmSync(join(FIXTURES, file));
  }
}

for (const [stem, payload] of Object.entries(FIXTURES_TO_WRITE)) {
  writeFileSync(join(FIXTURES, `${stem}.input.json`), `${JSON.stringify(payload, null, 2)}\n`);
  const hint = HINTS[stem];
  if (hint !== undefined) {
    writeFileSync(join(FIXTURES, `${stem}.enrichment.json`), `${JSON.stringify({ nativeEvent: hint }, null, 2)}\n`);
  }
}
for (const [stem, entry] of Object.entries(DECLINED)) {
  writeFileSync(join(FIXTURES, `${stem}.input.json`), `${JSON.stringify(entry.payload, null, 2)}\n`);
  writeFileSync(join(FIXTURES, `${stem}.enrichment.json`), `${JSON.stringify({ nativeEvent: entry.hint }, null, 2)}\n`);
}
writeFileSync(
  join(FIXTURES, "declined.json"),
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(DECLINED).map(([stem, entry]) => [
        stem,
        { reason: entry.reason, error: `unmapped native event "${entry.hint}"` },
      ]),
    ),
    null,
    2,
  )}\n`,
);

console.log(`wrote ${Object.keys(FIXTURES_TO_WRITE).length} fixtures and ${Object.keys(DECLINED).length} declined inputs`);
