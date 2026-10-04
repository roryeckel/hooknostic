#!/usr/bin/env node
// Promote narrow, verbatim prompt excerpts; keep full raw requests in ignored captured/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const names = ["gate-control", "gate-claude", "gate-codex", "gate-opencode"];
const redact = (text) => text.replace(/(C:[\\/]Users[\\/])[^\\/]+/gi, "$1user");
function redactValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  return value;
}
function excerpts(value, path = "$", found = []) {
  if (typeof value === "string" && /GATE_(DESCRIPTION|BODY)_/.test(value)) {
    // Include only probe-bearing lines, not unrelated built-in skill descriptions.
    const lines = value.split("\n");
    const selected = lines.flatMap((line, index) =>
      /GATE_(DESCRIPTION|BODY)_/.test(line) ? [{ line: index + 1, text: redact(line) }] : [],
    );
    found.push({ path, lines: selected });
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) excerpts(child, `${path}[${JSON.stringify(key)}]`, found);
  }
  return found;
}
const groups = new Map();
for (const arg of process.argv.slice(2)) {
  const dir = resolve(root, "captured", arg);
  if (!dir.startsWith(resolve(root, "captured") + "/") && !dir.startsWith(resolve(root, "captured") + "\\"))
    throw new Error("Expected a captured session directory");
  for (const label of readdirSync(dir)) {
    const caseDir = join(dir, label);
    const e = JSON.parse(readFileSync(join(caseDir, "evidence.json"), "utf8"));
    const raw = readFileSync(join(caseDir, "requests.json"));
    const requests = JSON.parse(raw);
    if (e.exit !== 0 || e.errors.length || !e.requestCount) throw new Error(`Incomplete session: ${label}`);
    const key = `${e.harness}-${e.version}`;
    const group = groups.get(key) ?? { harness: e.harness, version: e.version, platform: e.platform, cases: [] };
    const cases = group.cases;
    cases.push({
      label,
      capturedAt: e.capturedAt,
      prompt: e.prompt,
      action: e.action,
      gated: e.gated,
      exit: e.exit,
      errors: e.errors,
      requestCount: e.requestCount,
      descriptionMarkersInInitialRequest: names.filter((name) =>
        e.initial.some((text) => text.includes(`GATE_DESCRIPTION_${name}`)),
      ),
      bodiesReachedModel: names.filter((name) =>
        [...e.initial, ...e.subsequent].some((text) => text.includes(`GATE_BODY_${name}`)),
      ),
      skillTool: e.tools.find((tool) => tool.name.toLowerCase() === "skill") ?? null,
      pluginConfig: e.pluginConfig ?? null,
      rawRequestsSha256: createHash("sha256").update(raw).digest("hex"),
      excerpts: excerpts(requests),
      toolResponses: requests
        .flatMap((request) => (request.messages ?? []).filter((message) => message.role === "tool"))
        .map(redactValue),
    });
    groups.set(key, group);
  }
}
mkdirSync(join(root, "evidence"), { recursive: true });
for (const [key, group] of groups) {
  const { cases, ...metadata } = group;
  cases.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const evidence = {
    provenance: "live-probe",
    ...metadata,
    scope: "Native project skills; model replies and forced tool calls were scripted on loopback.",
    extraction:
      "Probe-bearing lines are verbatim excerpts from recorded request bodies; JSON paths and one-based string line numbers identify their source. Only the Windows account-name path segment is redacted to user. descriptionMarkersInInitialRequest and bodiesReachedModel summarize complete tool-bearing model requests, not just these excerpts. Complete raw requests remain in ignored captured/; their hashes are recorded per case.",
    cases,
  };
  const file = join(root, "evidence", `${key}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`${basename(file)}: ${cases.length} cases`);
}
