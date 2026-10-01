#!/usr/bin/env node
// Promote reviewed subagent captures (drive.mjs output) to fixtures: hook
// payloads recorded INSIDE a delegated subagent, and the subagent lifecycle
// events, one verbatim payload per case with the account name redacted, plus
// the canonical event today's decoder produces from it.
//
//   node --experimental-strip-types .capture/agents/promote.mjs
//
// Reads captured/{claude,codex-home,opencode-v2}/direct/tee/ and
// captured/claude/primary-flag/tee/, so run those
// drive cases first (see README.md).
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capturingHomes, redactHomes, unredactedHomes } from "../../scripts/redact-capture.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { decodeClaude } = await import("../../packages/adapter-claude/src/decode.ts");
const { claudeHarness } = await import("../../packages/adapter-claude/src/harness.ts");
const { decodeCodex } = await import("../../packages/adapter-codex/src/decode.ts");
const { codexHarness } = await import("../../packages/adapter-codex/src/harness.ts");
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");

const CAPTURED = join(REPO, ".capture/agents/captured");
const homes = capturingHomes({ home: homedir(), temp: tmpdir(), realpath: realpathSync.native });
const username = userInfo().username;

/** The same fail-closed redaction as .capture/file-tools/promote.mjs. */
function redact(text, stem) {
  const { text: redacted, nearMisses } = redactHomes(text, homes);
  if (nearMisses.length > 0) throw new Error(`${stem}: ambiguous home paths, review by hand: ${nearMisses.join(", ")}`);
  const out = redacted.replaceAll(`-Users-${username}-`, "-Users-user-");
  if (unredactedHomes(out, homes).length > 0 || out.includes(username)) {
    throw new Error(`${stem}: the capturing account survived redaction`);
  }
  return out;
}

function rows(file) {
  if (!existsSync(file)) throw new Error(`missing capture ${file}`);
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function one(file, predicate, what) {
  const found = rows(file).filter(predicate);
  if (found.length !== 1) throw new Error(`${file}: expected one ${what}, found ${found.length}`);
  return found[0];
}

function write(dir, stem, input, decode, keepVersion = false) {
  const text = redact(JSON.stringify(input, null, 2), stem) + "\n";
  const redacted = JSON.parse(text);
  writeFileSync(join(REPO, "fixtures", dir, `${stem}.input.json`), text, "utf8");
  const { raw, ...canonical } = decode(redacted);
  void raw;
  if (!keepVersion) delete canonical.harness.version;
  writeFileSync(join(REPO, "fixtures", dir, `${stem}.canonical.json`), JSON.stringify(canonical, null, 2) + "\n", "utf8");
  console.log(`fixtures/${dir}/${stem}`);
}

// Claude: the child's own tool events carry the agent's identity; the
// parent's carry none, which is what makes the child's attributable.
const claude = (row) => decodeClaude(row, { targetId: "claude", harnessVersion: claudeHarness.referenceVersion });
const claudeTee = join(CAPTURED, "claude", "direct", "tee");
for (const [event, stem] of [
  ["PreToolUse", "pre-tool-read-subagent"],
  ["PostToolUse", "post-tool-read-subagent"],
]) {
  // The child reads seed.txt three times; the first read is representative.
  const row = rows(join(claudeTee, `${event}.jsonl`)).find((r) => r.tool_name === "Read" && r.agent_type === "hn-probe");
  if (row === undefined) throw new Error(`${claudeTee}: no ${event} for Read inside the subagent`);
  write("claude/2.1", stem, row, claude);
}

// Claude, a session started as the agent (`--agent`, the primary-flag case):
// every event names the agent, and none carries agent_id, which only a
// subagent's events do.
const primaryTee = join(CAPTURED, "claude", "primary-flag", "tee");
const primaryRead = rows(join(primaryTee, "PreToolUse.jsonl")).find(
  (r) => r.tool_name === "Read" && r.agent_type === "hn-probe",
);
if (primaryRead === undefined) throw new Error(`${primaryTee}: no Read by the session running as the agent`);
write("claude/2.1", "pre-tool-read-primary-agent", primaryRead, claude);
write(
  "claude/2.1",
  "session-start-primary-agent",
  one(join(primaryTee, "SessionStart.jsonl"), () => true, "SessionStart"),
  claude,
);

// Codex: from the isolated-home lane, where the child's hooks demonstrably ran.
const codex = (row) => decodeCodex(row, { targetId: "codex", harnessVersion: codexHarness.referenceVersion });
const codexTee = join(CAPTURED, "codex-home", "direct", "tee");
write("codex/0.148", "subagent-start-live", one(join(codexTee, "SubagentStart.jsonl"), () => true, "SubagentStart"), codex);
write("codex/0.148", "subagent-stop-live", one(join(codexTee, "SubagentStop.jsonl"), () => true, "SubagentStop"), codex);
write(
  "codex/0.148",
  "pre-tool-bash-subagent",
  one(join(codexTee, "PreToolUse.jsonl"), (r) => r.tool_name === "Bash" && r.agent_type === "hn-probe", "child Bash"),
  codex,
);
write(
  "codex/0.148",
  "post-tool-bash-subagent",
  one(join(codexTee, "PostToolUse.jsonl"), (r) => r.tool_name === "Bash" && r.agent_type === "hn-probe", "child Bash"),
  codex,
);
write(
  "codex/0.148",
  "pre-tool-wait-agent",
  one(join(codexTee, "PreToolUse.jsonl"), (r) => r.tool_name === "multi_agent_v1wait_agent", "wait_agent"),
  codex,
);

// OpenCode v2: the child's tool events name the running agent; the parent's
// name the primary agent (`build`).
const v2 = (row) => decodeOpenCodeV2(row, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
const v2Events = join(CAPTURED, "opencode-v2", "direct", "tee", "events.jsonl");
for (const phase of ["before", "after"]) {
  const row = rows(v2Events).find(
    (r) => r.hook === `execute.${phase}` && r.event.tool === "read" && r.event.agent === "hn-probe",
  );
  if (row === undefined) throw new Error(`${v2Events}: no execute.${phase} for read inside the subagent`);
  // The v2 fixtures keep the version in their canonical form (promote-tools.mjs).
  write("opencode/2.0", `tool-read-in-subagent-${phase}`, row, v2, true);
}
