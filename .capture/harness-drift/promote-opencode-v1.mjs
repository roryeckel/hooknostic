#!/usr/bin/env node
// Promote a reviewed opencode-v1 drift artifact to fixtures: one verbatim
// envelope per drifted variant with any capturing account redacted, plus the
// canonical event today's decoder produces from it.
//
//   gh run download <run-id> -n drift-verdict-opencode-v1 -D <dir>
//   node --experimental-strip-types .capture/harness-drift/promote-opencode-v1.mjs <dir>
//
// Only for a playback-transport artifact a human has reviewed: the envelopes
// are the harness's own, the model side (and so argument values) is scripted.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capturingHomes, redactHomes, unredactedHomes } from "../../scripts/redact-capture.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { decodeOpenCode } = await import("../../packages/adapter-opencode/src/decode.ts");
const { opencodeHarness } = await import("../../packages/adapter-opencode/src/harness.ts");

const artifact = process.argv[2];
if (artifact === undefined) throw new Error("usage: promote-opencode-v1.mjs <downloaded artifact dir>");
const CAPTURED = join(resolve(artifact), "captured-opencode-v1");
const homes = capturingHomes({ home: homedir(), temp: tmpdir(), realpath: realpathSync.native });
const username = userInfo().username;

/** Fail-closed redaction (scripts/redact-capture.mjs), as .capture/file-tools/promote.mjs. */
function redact(text, stem) {
  const { text: redacted, nearMisses } = redactHomes(text, homes);
  if (nearMisses.length > 0) throw new Error(`${stem}: ambiguous home paths, review by hand: ${nearMisses.join(", ")}`);
  if (unredactedHomes(redacted, homes).length > 0 || redacted.includes(username)) {
    throw new Error(`${stem}: the capturing account survived redaction`);
  }
  return redacted;
}

function first(file, predicate) {
  const path = join(CAPTURED, file);
  if (!existsSync(path)) throw new Error(`missing capture ${path}`);
  const row = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find(predicate);
  if (row === undefined) throw new Error(`${file}: no matching row`);
  return row;
}

const decode = (row) => decodeOpenCode(row, { targetId: "opencode", harnessVersion: opencodeHarness.referenceVersion });
for (const [stem, file, predicate] of [
  ["chat-message", "chat.message.jsonl", () => true],
  ["session-created", "event.jsonl", (r) => r.input?.event?.type === "session.created"],
  ["session-idle", "event.jsonl", (r) => r.input?.event?.type === "session.idle"],
  ["tool-before", "tool.execute.before.jsonl", (r) => r.input?.tool === "bash"],
  ["tool-after", "tool.execute.after.jsonl", (r) => r.input?.tool === "bash"],
]) {
  const text = redact(JSON.stringify(first(file, predicate), null, 2), stem) + "\n";
  writeFileSync(join(REPO, "fixtures/opencode/1.18", `${stem}.input.json`), text, "utf8");
  const { raw, ...canonical } = decode(JSON.parse(text));
  void raw;
  delete canonical.harness.version;
  writeFileSync(
    join(REPO, "fixtures/opencode/1.18", `${stem}.canonical.json`),
    JSON.stringify(canonical, null, 2) + "\n",
    "utf8",
  );
  console.log(`fixtures/opencode/1.18/${stem}`);
}
