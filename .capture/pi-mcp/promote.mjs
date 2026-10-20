// Promote the pi MCP tool payloads into the reference fixture directory, with
// account redaction. Run from the repository root after probe.mjs, then
// regenerate canonicals with .capture/pi/make-canonical.mjs:
//   node --experimental-strip-types .capture/pi-mcp/promote.mjs [fixture...]
// Naming fixtures promotes only those, leaving the others' captured temporary
// paths as they are. It reads captured/<platform>/ for this platform, or the
// one HKN_PI_MCP_PLATFORM names. Each tool_result fixture gets an enrichment
// holding the source pi.getAllTools() reported for its tool in that session.
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtures = fileURLToPath(new URL(`../../fixtures/pi/${piHarness.fixtureDir}/`, import.meta.url));
const base = join(here, "captured", process.env.HKN_PI_MCP_PLATFORM ?? process.platform);
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
const toolSources = (label) =>
  readFileSync(join(base, label, "events", "tool-source.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** [fixture, case, native event, pick] */
const CASES = [
  ["tool-call-mcp", "extension-direct", "tool_call", byTool("mcp__probe__probe_echo")],
  ["tool-result-mcp", "extension-direct", "tool_result", byTool("mcp__probe__probe_echo")],
  ["tool-call-codemode", "codemode-nested", "tool_call", byTool("codemode")],
  ["tool-call-mcp-nested", "codemode-nested", "tool_call", byTool("mcp__probe__probe_echo")],
  ["tool-result-mcp-nested", "codemode-nested", "tool_result", byTool("mcp__probe__probe_echo")],
  // A server's error result still states the split; a JSON-RPC error does not.
  ["tool-result-mcp-error", "extension-tool-error", "tool_result", byTool("mcp__probe__probe_fail")],
  ["tool-result-mcp-rpc-error", "extension-tool-error", "tool_result", byTool("mcp__probe__probe_throw")],
  // Another extension's tool under an MCP-shaped name, and one under the native
  // tool's own name: each states a split in details, and its source is that
  // extension's file rather than pi's MCP extension.
  ["tool-result-mcp-extension", "extension-mcp-name", "tool_result", byTool("mcp__fake__echo")],
  ["tool-result-mcp-shadow", "extension-mcp-shadow", "tool_result", byTool("mcp__probe__probe_echo")],
];

const only = new Set(process.argv.slice(2));
for (const name of only) {
  if (!CASES.some(([fixture]) => fixture === name)) throw new Error(`Unknown fixture: ${name}`);
}
for (const [fixture, label, event, pick] of CASES) {
  if (only.size > 0 && !only.has(fixture)) continue;
  const observation = JSON.parse(readFileSync(join(base, label, "observation.json"), "utf8"));
  redaction.recordCapture(observation);
  if (observation.exitCode !== 0 || observation.version !== piHarness.referenceVersion)
    throw new Error(`Unusable capture: ${label}`);
  const payload = rows(label, event).find(pick);
  if (payload === undefined) throw new Error(`${fixture}: no matching ${event} in ${label}`);
  const text = JSON.stringify(redaction.redact(payload), null, 2) + "\n";
  writeFileSync(join(fixtures, `${fixture}.input.json`), redaction.published(text));
  console.log(`wrote ${fixture}.input.json`);
  if (event !== "tool_result") continue;
  const source = toolSources(label).find(
    (row) =>
      row.event === event && row.toolName === payload.event.toolName && row.toolCallId === payload.event.toolCallId,
  );
  if (source?.tools?.length !== 1) throw new Error(`${fixture}: no single tool source recorded beside it`);
  const enrichment = { toolSource: source.tools[0].sourceInfo };
  const enrichmentText = JSON.stringify(redaction.redact(enrichment), null, 2) + "\n";
  writeFileSync(join(fixtures, `${fixture}.enrichment.json`), redaction.published(enrichmentText));
  console.log(`wrote ${fixture}.enrichment.json`);
}
