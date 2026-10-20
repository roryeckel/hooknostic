// Promote the pi MCP tool payloads into the reference fixture directory, with
// account redaction. Run from the repository root after probe.mjs, then
// regenerate canonicals with .capture/pi/make-canonical.mjs:
//   node --experimental-strip-types .capture/pi-mcp/promote.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtures = fileURLToPath(new URL(`../../fixtures/pi/${piHarness.fixtureDir}/`, import.meta.url));
const base = join(here, "captured", "win32");
const metadata = JSON.parse(readFileSync(join(base, "metadata.json"), "utf8"));
if (metadata.version !== piHarness.referenceVersion) throw new Error(`Unexpected harness build: ${metadata.version}`);
const redaction = createRedaction(metadata.account);
redaction.recordCapture(metadata);

const rows = (label, event) =>
  readFileSync(join(base, label, "events", `${event}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).payload);
const byTool = (name) => (row) => row.event.toolName === name;

/** [fixture, case, native event, pick] */
const CASES = [
  ["tool-call-mcp", "extension-direct", "tool_call", byTool("mcp__probe__probe_echo")],
  ["tool-result-mcp", "extension-direct", "tool_result", byTool("mcp__probe__probe_echo")],
  ["tool-call-codemode", "codemode-nested", "tool_call", byTool("codemode")],
  ["tool-call-mcp-nested", "codemode-nested", "tool_call", byTool("mcp__probe__probe_echo")],
  ["tool-result-mcp-nested", "codemode-nested", "tool_result", byTool("mcp__probe__probe_echo")],
];

for (const [fixture, label, event, pick] of CASES) {
  const observation = JSON.parse(readFileSync(join(base, label, "observation.json"), "utf8"));
  redaction.recordCapture(observation);
  if (observation.exitCode !== 0 || observation.version !== piHarness.referenceVersion)
    throw new Error(`Unusable capture: ${label}`);
  const payload = rows(label, event).find(pick);
  if (payload === undefined) throw new Error(`${fixture}: no matching ${event} in ${label}`);
  const text = JSON.stringify(redaction.redact(payload), null, 2) + "\n";
  writeFileSync(join(fixtures, `${fixture}.input.json`), redaction.published(text));
  console.log(`wrote ${fixture}.input.json`);
}
