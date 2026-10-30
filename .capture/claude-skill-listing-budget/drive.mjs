#!/usr/bin/env node
// Claude skill-listing budget probe. Model replies are scripted on loopback.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { runProcess, startModelPlayback } = await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const executable = process.env.HKN_CLAUDE_BINARY ?? "claude";
const probeName = "budget-probe";
const probeDescription = "BUDGET_PROBE_DESCRIPTION harmless capture control.";
// default: no override. raised: no listing reaches it. tight: well under the
// bundled set alone, so the over-budget path shows which entries it keeps.
const cases = [
  { label: "default" },
  { label: "raised", budget: "100000" },
  { label: "tight", budget: "2000" },
];

// A run started from inside a Claude session inherits that session's variables.
const isolatedBase = () => {
  const env = withoutCredentials();
  for (const key of Object.keys(env)) if (/^(CLAUDE|AI_AGENT)/.test(key)) delete env[key];
  delete env.ANTHROPIC_BASE_URL;
  return env;
};

const versionHome = mkdtempSync(join(tmpdir(), "hkn-listing-version-"));
const versionResult = await runProcess(executable, ["--version"], {
  cwd: here,
  env: { ...isolatedBase(), HOME: versionHome, USERPROFILE: versionHome, CLAUDE_CONFIG_DIR: versionHome },
  timeoutMs: 120000,
});
const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
if (versionResult.code !== 0 || !version) throw new Error(`Could not identify Claude version: ${versionResult.stderr}`);
const raw = join(here, "captured", `${version}-${Date.now()}`);
mkdirSync(raw, { recursive: true });

const textStrings = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(textStrings)
      : [];
const probeLine = new RegExp(`^- ${probeName}(?::|$)`, "m");

// The listing is the paragraph holding the probe's entry; entries start "- ".
// Bundled skill text is not recorded, only each entry's name, form and length.
function listing(requests) {
  const request = requests.find((value) => value && typeof value === "object" && "tools" in value);
  const text = textStrings(request).find((value) => probeLine.test(value));
  if (text === undefined) return undefined;
  const paragraph = text.split("\n\n").find((part) => probeLine.test(part));
  const entries = paragraph.split(/\n(?=- )/).map((entry) => {
    const [, name, description] = /^- ([^:\n]+)(?::\s([\s\S]*))?$/.exec(entry) ?? [];
    return { name, form: description === undefined ? "name-only" : "full", chars: entry.length };
  });
  return {
    chars: paragraph.length,
    entries,
    probeEntry: paragraph.split("\n").find((line) => probeLine.test(line)),
  };
}

const results = [];
for (const { label, budget } of cases) {
  const root = mkdtempSync(join(tmpdir(), "hkn-listing-budget-"));
  const project = join(root, "project");
  const skill = join(project, ".claude/skills", probeName);
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nname: ${probeName}\ndescription: ${probeDescription}\n---\n\nBUDGET_PROBE_BODY\nRespond with the word done.\n`,
  );
  const env = { ...isolatedBase(), HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "claude-home") };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const git = await runProcess(process.env.HKN_SKILL_GIT_BINARY ?? "git", ["init"], { cwd: project, env, timeoutMs: 30000 });
  if (git.code !== 0) throw new Error(`Could not initialize isolated project: ${git.stderr}`);
  const debugFile = join(root, "debug.log");
  const server = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "capture complete" }]);
  let result;
  try {
    result = await runProcess(
      executable,
      [
        "-p",
        "Reply with done.",
        "--model",
        "hooknostic-playback",
        "--dangerously-skip-permissions",
        "--max-turns",
        "2",
        "--debug-file",
        debugFile,
      ],
      {
        cwd: project,
        timeoutMs: 120000,
        env: {
          ...env,
          ANTHROPIC_API_KEY: "local-playback",
          ANTHROPIC_BASE_URL: server.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          ...(budget === undefined ? {} : { SLASH_COMMAND_TOOL_CHAR_BUDGET: budget }),
        },
      },
    );
  } finally {
    await server.close();
  }
  const requests = JSON.stringify(server.requests);
  writeFileSync(join(raw, `${label}.requests.json`), requests);
  const debug = existsSync(debugFile) ? readFileSync(debugFile, "utf8") : "";
  const summary = listing(server.requests);
  if (result.code !== 0 || server.errors.length > 0 || summary === undefined)
    throw new Error(`${label}: exit ${result.code}, errors ${JSON.stringify(server.errors)}, listing ${summary !== undefined}`);
  results.push({
    label,
    budgetEnv: budget ?? null,
    exitCode: result.code,
    listing: summary,
    overBudgetLog:
      debug
        .split(/\r?\n/)
        .find((line) => line.includes("Skill listing over budget"))
        ?.replace(/^\S+\s+/, "") ?? null,
    requestsSha256: createHash("sha256").update(requests).digest("hex"),
  });
  console.log(`${label}: ${summary.probeEntry} (${summary.chars} listing chars)`);
}

const evidence = join(here, "evidence", `${version}-${process.platform}.json`);
mkdirSync(join(here, "evidence"), { recursive: true });
writeFileSync(
  evidence,
  JSON.stringify(
    { harness: "claude", version, date: new Date().toLocaleDateString("en-CA"), platform: process.platform, node: process.version, probeName, probeDescription, cases: results },
    null,
    2,
  ) + "\n",
);
console.log(`evidence: ${evidence}\nraw: ${raw}`);
