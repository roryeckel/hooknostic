#!/usr/bin/env node
// Promote reviewed file-tool captures (drive.mjs output) to fixtures: one
// verbatim hook payload per case with the account name redacted, plus the
// canonical event today's decoder produces from it.
//
//   node --experimental-strip-types .capture/file-tools/promote.mjs [<opencode-v2 capture root>]
//
// The optional argument is an HKN_CAPTURE_ROOT from
// `HKN_MODEL_ID=gpt-5-playback .capture/opencode-v2/drive.mjs tools-patch`.
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
const { decodeOpenCode } = await import("../../packages/adapter-opencode/src/decode.ts");
const { opencodeHarness } = await import("../../packages/adapter-opencode/src/harness.ts");
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");

const CAPTURED = join(REPO, ".capture/file-tools/captured");
const homes = capturingHomes({ home: homedir(), temp: tmpdir(), realpath: realpathSync.native });
const username = userInfo().username;

/**
 * The capturing home's account segment to `user`, through the shared,
 * fail-closed redaction (scripts/redact-capture.mjs). Claude's mangled
 * project directory (`C--Users-<name>-…`) joins segments with dashes, which
 * that module's separator match does not cover, so it gets one rewrite of its
 * own; the whole-name check after both is the backstop for any other form.
 */
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

const claude = (row) => decodeClaude(row, { targetId: "claude", harnessVersion: claudeHarness.referenceVersion });
for (const [caseName, tool, stem] of [
  ["write", "Write", "pre-tool-write"],
  ["edit", "Edit", "pre-tool-edit"],
  ["notebookedit", "NotebookEdit", "pre-tool-notebookedit"],
]) {
  const row = rows(join(CAPTURED, "claude", caseName, "PreToolUse.jsonl")).find((r) => r.tool_name === tool);
  write("claude/2.1", stem, row, claude);
}

const codex = (row) => decodeCodex(row, { targetId: "codex", harnessVersion: codexHarness.referenceVersion });
for (const caseName of ["patch-add", "patch-update-move", "patch-delete", "patch-multi"]) {
  const row = rows(join(CAPTURED, "codex", caseName, "PreToolUse.jsonl")).find((r) => r.tool_name === "apply_patch");
  write("codex/0.148", `pre-tool-apply-${caseName}`, row, codex);
}
write(
  "codex/0.148",
  "post-tool-apply-patch-add",
  rows(join(CAPTURED, "codex", "patch-add", "PostToolUse.jsonl")).find((r) => r.tool_name === "apply_patch"),
  codex,
);
write(
  "codex/0.148",
  "pre-tool-view-image",
  rows(join(CAPTURED, "codex", "view-image", "PreToolUse.jsonl")).find((r) => r.tool_name === "view_image"),
  codex,
);

const v1 = (row) => decodeOpenCode(row, { targetId: "opencode", harnessVersion: opencodeHarness.referenceVersion });
for (const [caseName, tool] of [
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["apply_patch@gpt-5-playback", "apply_patch"],
]) {
  const row = rows(join(CAPTURED, "opencode-v1", caseName, "tool.execute.before.jsonl")).find((r) => r.input?.tool === tool);
  write("opencode/1.18", `tool-${tool.replaceAll("_", "-")}-before`, row, v1);
}

const v2Root = process.argv[2];
if (v2Root !== undefined) {
  const v2 = (row) => decodeOpenCodeV2(row, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  const events = rows(join(v2Root, "captured/events.jsonl"));
  for (const phase of ["before", "after"]) {
    const row = events.find((r) => r.hook === `execute.${phase}` && r.event.tool === "patch");
    // The v2 fixtures keep the version in their canonical form (promote-tools.mjs).
    write("opencode/2.0", `tool-patch-${phase}`, row, v2, true);
  }
}
