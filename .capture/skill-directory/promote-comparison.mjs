#!/usr/bin/env node
// Promote reviewed command/effect evidence, excluding model reasoning and login state.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { capturingHomes, redactHomes, unredactedHomes } from "../../scripts/redact-capture.mjs";

const input = resolve(process.argv[2] ?? "missing-capture-directory");
const metadata = JSON.parse(readFileSync(join(input, "metadata.json"), "utf8"));
const results = JSON.parse(readFileSync(join(input, "results.json"), "utf8"));
if (results.length !== 20 || metadata.runsPerCell !== 5 || metadata.bodies.join(",") !== "F,E-reconstructed")
  throw new Error("Promotion requires the complete planned 20-session sample.");

function shellCalls(text) {
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec_command") {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const values = {};
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property)) {
            const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText();
            if (ts.isStringLiteralLike(property.initializer)) values[key] = property.initializer.text;
            else if (["cmd", "workdir", "shell"].includes(key)) throw new Error(`Manually review nonliteral ${key}`);
          }
        }
        if (values.cmd) calls.push(values);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("captured-code.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return calls;
}

const skills = {};
const sessions = results.map(result => {
  if (result.timedOut || result.exitCode !== 0 || result.errors.length || result.firstAttemptSuccess === null)
    throw new Error(`${result.label}: incomplete or unclassified session`);
  const key = `${result.body}/${result.projection}`;
  const skill = readFileSync(join(input, result.label, "SKILL.md"), "utf8");
  if (skills[key] !== undefined && skills[key] !== skill) throw new Error(`Unequal skill bytes in ${key}`);
  skills[key] = skill;
  const rollout = readFileSync(join(input, result.label, "rollout.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const calls = rollout.filter(event => event.type === "response_item" && event.payload.type === "custom_tool_call" && event.payload.name === "exec").flatMap(event => shellCalls(event.payload.input));
  const launchers = calls.filter(call => /where\.sh/.test(call.cmd) && /\bbash\b/i.test(call.cmd));
  if (launchers.length !== result.launcherAttempts.length) throw new Error(`${result.label}: manually review a nonliteral or unmatched launcher`);
  const marker = result.eventualExecution ? readFileSync(join(input, result.label, "executions.tsv"), "utf8").trim().split(/\r?\n/).map(line => {
    const [cwd, script, ...args] = line.split("\t");
    return { cwd, script, arguments: args.join("\t") };
  }) : [];
  if (result.firstAttemptSuccess && !marker.length) throw new Error(`${result.label}: success without a script marker`);
  return {
    run: result.label, round: result.round, body: result.body, projection: result.projection,
    sessionWorkingDirectory: join(result.state, "project"), installedSkillDirectory: result.installedSkill,
    firstAttemptSuccess: result.firstAttemptSuccess, eventualExecution: result.eventualExecution,
    attempts: result.launcherAttempts.map((attempt, index) => ({ cmd: launchers[index].cmd, workdir: launchers[index].workdir ?? null, ...(launchers[index].shell ? { shell: launchers[index].shell } : {}), exitCode: attempt.exit_code, output: attempt.aggregated_output })),
    executions: marker,
  };
});
const summary = Object.keys(skills).sort().map(key => {
  const selected = sessions.filter(session => `${session.body}/${session.projection}` === key);
  if (selected.length !== 5) throw new Error(`Unequal sample for ${key}`);
  return { body: selected[0].body, projection: selected[0].projection, sessions: selected.length, firstAttemptSuccesses: selected.filter(session => session.firstAttemptSuccess).length, eventualExecutions: selected.filter(session => session.eventualExecution).length };
});
const evidence = {
  provenance: "live-probe", date: "2026-10-19", harness: "codex", version: metadata.version, model: metadata.model,
  environment: { platform: "Windows", sandbox: metadata.sandbox, windowsSandboxSetting: metadata.windowsSandbox, bashDirectory: metadata.bashDirectory },
  placeholder: metadata.placeholder, reconstructedFrontmatter: metadata.reconstructedFrontmatter,
  method: "Five fresh isolated marketplace installs per body and projection, interleaved in alternating order. The existing projectSkillText helper changes only skillDirectory. First launcher attempts are checked against command outputs and the script's marker; retries are recorded separately.",
  limits: "Body F is the issue's full body. E-reconstructed adds declared substitute frontmatter because the original values were unavailable. Native sandboxing was disabled with explicit owner authorization after sandboxed execution controls stalled. Git Bash was pinned on PATH. The sample does not establish a general probability or an exact support rating. Production projection was not changed.",
  summary, skills, sessions,
};
const homes = capturingHomes({ home: homedir(), temp: tmpdir(), realpath: realpathSync.native });
// Git Bash spells the same Windows profile as /c/Users/<account> (or /mnt/c/... under WSL).
const windowsHome = /^([A-Za-z]):[\\/](.*)$/.exec(homedir());
if (windowsHome) for (const prefix of [`/${windowsHome[1].toLowerCase()}/`, `/mnt/${windowsHome[1].toLowerCase()}/`]) homes.push(prefix + windowsHome[2].replaceAll("\\", "/"));
const redacted = redactHomes(JSON.stringify(evidence, null, 2) + "\n", homes);
if (redacted.nearMisses.length || unredactedHomes(redacted.text, homes).length) throw new Error("Ambiguous home-path redaction; review before promotion.");
const target = fileURLToPath(new URL("evidence/codex-absolute-path-comparison.json", import.meta.url));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, redacted.text);
console.log(JSON.stringify({ target, summary }, null, 2));
