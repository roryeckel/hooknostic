// Promote selected native payloads and bounded observations, with account redaction.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtures = fileURLToPath(new URL(`../../fixtures/pi/${piHarness.fixtureDir}/`, import.meta.url));
const evidence = join(here, "feature-evidence");
mkdirSync(evidence, { recursive: true });
for (const platform of ["win32", "linux"]) {
  const base = join(here, "captured-features", platform);
  if (!existsSync(base)) continue;
  const metadata = JSON.parse(readFileSync(join(base, "metadata.json"), "utf8"));
  const redaction = createRedaction(metadata.account);
  redaction.recordCapture(metadata);
  const save = (path, value) =>
    writeFileSync(path, redaction.published(JSON.stringify(redaction.redact(value), null, 2) + "\n"));
  const observations = [];
  for (const label of readdirSync(base).filter((name) => name !== "metadata.json")) {
    const observed = JSON.parse(readFileSync(join(base, label, "observation.json"), "utf8"));
    redaction.recordCapture(observed);
    if (observed.exitCode !== 0) throw new Error(`Unsuccessful capture: ${label}`);
    if (observed.version !== piHarness.referenceVersion) throw new Error(`Unexpected harness build: ${label}`);
    const firstRequest = observed.requests[0];
    const system = firstRequest?.messages?.find((message) => message.role === "system")?.content ?? "";
    const promptPath = join(base, label, "events/before_agent_start.jsonl");
    const promptEvent = existsSync(promptPath)
      ? JSON.parse(readFileSync(promptPath, "utf8").trim().split("\n")[0]).payload.event
      : undefined;
    observations.push({
      label,
      version: observed.version,
      capturedAt: observed.date,
      settings: observed.settings,
      tools: observed.tools,
      ...(observed.interpreter ? { interpreter: observed.interpreter } : {}),
      ...(observed.interpreter
        ? {
            configuredEnvironment: observed.configuredEnvironment?.SHELL
              ? { SHELL: observed.configuredEnvironment.SHELL }
              : {},
            toolDescriptions: firstRequest.tools.filter((tool) => ["bash", "powershell"].includes(tool.function?.name)),
            toolSnippets: promptEvent?.systemPromptOptions?.toolSnippets,
          }
        : {}),
      ...(label === "turn-fields"
        ? { sessionReads: observed.sessionContext.map((entry) => ({ event: entry.event.type, branch: entry.branch })) }
        : {}),
      ...(label.startsWith("skill-")
        ? {
            // These are extracted verbatim from the model request, not model reports.
            descriptionVisible: system.includes("FEATURE_SKILL_DESCRIPTION"),
            skillListing: /<available_skills>[\s\S]*?<\/available_skills>/.exec(system)?.[0] ?? null,
            userMessages: firstRequest.messages.filter((message) => message.role === "user"),
          }
        : { before: observed.before, after: observed.after }),
    });
    if (platform === "win32" && ["file-read", "file-edit", "bash-configured-powershell"].includes(label)) {
      const suffix = label === "bash-configured-powershell" ? label : label.slice(5);
      for (const [prefix, rows] of [
        ["tool-call", observed.before],
        ["tool-result", observed.after],
      ]) {
        if (rows.length !== 1) throw new Error(`${label}: expected one ${prefix}`);
        save(join(fixtures, `${prefix}-${suffix}.input.json`), rows[0].payload);
      }
    }
    if (platform === "win32" && label === "turn-fields") {
      const stop = JSON.parse(readFileSync(join(base, label, "events/agent_settled.jsonl"), "utf8").trim()).payload;
      const settled = observed.sessionContext.find((entry) => entry.event.type === "agent_settled");
      save(join(fixtures, "agent-settled-with-message.input.json"), stop);
      save(join(fixtures, "agent-settled-with-message.enrichment.json"), { branch: settled.branch });
    }
  }
  save(join(evidence, platform + ".json"), { platform, observations });
}

for (const platform of ["win32", "linux"]) {
  const path = join(here, "captured-completion", platform + ".json");
  if (!existsSync(path)) continue;
  const captured = JSON.parse(readFileSync(path, "utf8"));
  if (captured.version !== piHarness.referenceVersion) throw new Error("Unexpected completion probe build");
  const redaction = createRedaction(captured.account);
  redaction.recordCapture(captured);
  const save = (path, value) =>
    writeFileSync(path, redaction.published(JSON.stringify(redaction.redact(value), null, 2) + "\n"));
  // Preserve each selected native entry verbatim; earlier history stays in raw evidence.
  const cases = captured.cases.map((entry) => ({
    ...entry,
    branch: entry.branch.filter((row) => row.type === "message").slice(-3),
  }));
  save(join(evidence, "completion-" + platform + ".json"), {
    version: captured.version,
    platform,
    capturedAt: captured.date,
    cases,
    events: captured.events,
    requests: captured.requests.map(({ phase, fault }) => ({ phase, fault })),
  });
  if (platform === "win32")
    for (const entry of cases) {
      if (!["error", "aborted", "retry", "retry-aborted", "resumed"].includes(entry.prompt)) continue;
      save(join(fixtures, `agent-settled-${entry.prompt}.input.json`), entry.native);
      save(join(fixtures, `agent-settled-${entry.prompt}.enrichment.json`), { branch: entry.branch });
    }
}
