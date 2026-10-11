#!/usr/bin/env node
// Promote reviewed shell-statement captures (drive.mjs output) to fixtures, and
// re-derive the canonical events of the Claude fixtures whose tool pins a dialect.
//
//   node --experimental-strip-types .capture/shell-dialects/promote-fixtures.mjs
//
// An OpenCode fixture is three files: the verbatim before-tool payload, the
// enrichment the shim hands the decoder beside it, and the canonical event
// today's decoder produces from both. The enrichment is the shell name this
// adapter's own parser reads out of the description captured in the same
// session, so a statement the parser cannot read fails here, not in a hook.
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
const { decodeOpenCode } = await import("../../packages/adapter-opencode/src/decode.ts");
const { opencodeHarness } = await import("../../packages/adapter-opencode/src/harness.ts");
const { statedShellV1, statedShellV2 } = await import("../../packages/adapter-opencode/src/shell-statement.ts");
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");

const CAPTURED = join(REPO, ".capture/shell-dialects/captured");
const homes = capturingHomes({ home: homedir(), temp: tmpdir(), realpath: realpathSync.native });
// A capture made under another account, such as the Linux container's.
const accounts = [userInfo().username, process.env.HKN_CAPTURE_ACCOUNT].filter(Boolean);

function redact(text, stem) {
  const { text: redacted, nearMisses } = redactHomes(text, homes);
  if (nearMisses.length > 0) throw new Error(`${stem}: ambiguous home paths, review by hand: ${nearMisses.join(", ")}`);
  // A home directory of another account, such as a container's, is not in `homes`.
  // The redacted account is `user` as a whole segment: followed by a separator,
  // the closing quote of the JSON string, or the end. `Users` is matched in any
  // case and with either separator, as Windows reports it; Linux's `/home/` is
  // case-sensitive, like the file system it names.
  const redactedAccount = "(?!user(?:[\\/\\\\\"]|$))";
  const foreignHome =
    new RegExp("\\/home\\/" + redactedAccount).test(redacted) ||
    new RegExp("(?:\\/|\\\\\\\\)Users(?:\\/|\\\\\\\\)" + redactedAccount, "i").test(redacted);
  if (unredactedHomes(redacted, homes).length > 0 || foreignHome || accounts.some((account) => redacted.includes(account))) {
    throw new Error(`${stem}: a capturing account survived redaction`);
  }
  return redacted;
}

function rows(file) {
  if (!existsSync(file)) throw new Error(`missing capture ${file}`);
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function json(dir, name, value) {
  writeFileSync(join(REPO, "fixtures", dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

// OpenCode 2.x canonicals keep the harness version; the other directories' omit it.
function canonicalOf(decoded, keepVersion = false) {
  const { raw, ...canonical } = decoded;
  void raw;
  if (!keepVersion) delete canonical.harness.version;
  return canonical;
}

// [capture directory, case, fixture stem]: one mapped shell and one the adapter does not map.
const CASES = [
  ["configured", "config-cmd", "tool-before-shell-cmd"],
  ["configured-linux", "env-tcsh", "tool-before-shell-tcsh"],
];

for (const [directory, suffix, stem] of CASES) {
  const folder = join(CAPTURED, directory, "opencode-v1", `bash-${suffix}`);
  const [before] = rows(join(folder, "tool.execute.before.jsonl"));
  // The statement in force for the call: the last bash definition before it, which
  // the arrival-order file counts (the tee writes one file per hook).
  const order = rows(join(folder, "shell-report-order.jsonl")).map((row) => row.hook);
  const preceding = order.slice(0, Math.max(0, order.indexOf("tool.execute.before"))).filter((hook) => hook === "tool.definition").length;
  const definition = rows(join(folder, "tool.definition.jsonl")).filter((row) => row.input.toolID === "bash")[preceding - 1];
  const shell = statedShellV1(definition?.output.description);
  if (shell === undefined) throw new Error(`${stem}: no shell statement before the captured call`);
  const input = JSON.parse(redact(JSON.stringify(before), `opencode/1.18/${stem}`));
  json("opencode/1.18", `${stem}.input.json`, input);
  json("opencode/1.18", `${stem}.enrichment.json`, { shell });
  const invocation = { targetId: "opencode", harnessVersion: opencodeHarness.referenceVersion };
  json("opencode/1.18", `${stem}.canonical.json`, canonicalOf(decodeOpenCode(input, invocation, { shell })));
  console.log(`fixtures/opencode/1.18/${stem} (stated ${shell})`);
}

for (const [directory, suffix, stem] of CASES) {
  const events = rows(join(CAPTURED, directory, "opencode-v2", `shell-${suffix}`, "events.jsonl"));
  const call = events.findIndex((row) => row.hook === "execute.before" && row.event.tool === "shell");
  // The statement in force for the call: the last context hook before it.
  const context = events.slice(0, call).findLast((row) => row.hook === "context");
  const shell = statedShellV2(context?.event.tools?.shell?.description);
  if (call === -1 || shell === undefined) throw new Error(`${stem}: no shell statement before the captured call`);
  const input = JSON.parse(redact(JSON.stringify(events[call]), `opencode/2.0/${stem}`));
  json("opencode/2.0", `${stem}.input.json`, input);
  json("opencode/2.0", `${stem}.enrichment.json`, { shell });
  const invocation = { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion };
  json("opencode/2.0", `${stem}.canonical.json`, canonicalOf(decodeOpenCodeV2(input, invocation, { shell }), true));
  console.log(`fixtures/opencode/2.0/${stem} (stated ${shell})`);
}

// Claude's dialect comes from the tool name, so its existing inputs are simply decoded again.
for (const stem of ["pre-tool-bash", "post-tool-bash", "pre-tool-powershell", "permission-request"]) {
  const input = JSON.parse(readFileSync(join(REPO, "fixtures/claude/2.1", `${stem}.input.json`), "utf8"));
  const invocation = { targetId: "claude", harnessVersion: claudeHarness.referenceVersion };
  const canonical = canonicalOf(decodeClaude(input, invocation));
  // Keep the committed file's key order, so the diff is the decoder's change alone.
  const committed = JSON.parse(readFileSync(join(REPO, "fixtures/claude/2.1", `${stem}.canonical.json`), "utf8"));
  const ordered = Object.fromEntries([...Object.keys(committed), ...Object.keys(canonical)].map((key) => [key, canonical[key]]));
  json("claude/2.1", `${stem}.canonical.json`, ordered);
  console.log(`fixtures/claude/2.1/${stem}`);
}
