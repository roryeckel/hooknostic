#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const platform = process.argv[2] ?? "win32";
const platforms = {
  win32: { label: "Windows", directory: "", observations: "observations.json", toolSuffix: "" },
  darwin: { label: "macOS", directory: "darwin", observations: "observations-macos.json", toolSuffix: "-macos" },
};
if (!Object.hasOwn(platforms, platform)) throw new Error("Specify win32 or darwin");
const target = platforms[platform];
const account = process.env.HKN_CAPTURE_ACCOUNT ?? process.env.USERNAME ?? process.env.USER;
if (!account) throw new Error("HKN_CAPTURE_ACCOUNT, USERNAME, or USER is required for account-path redaction");
function redact(value) {
  if (typeof value === "string") {
    return value.replaceAll("\\" + account + "\\", "\\user\\")
      .replaceAll("/" + account + "/", "/user/")
      .replaceAll("--Users-" + account + "-", "--Users-user-")
      .replaceAll("--users-" + account + "-", "--users-user-");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
  return value;
}
const cases = [];
for (const harness of ["claude", "codex", "opencode-v1", "opencode-v2"]) {
  const directory = join(root, "captured", target.directory, harness);
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  if (metadata.platform !== platform) throw new Error("Expected " + target.label + " capture metadata: " + harness);
  const tools = JSON.parse(readFileSync(join(directory, "discovery.json"), "utf8"));
  for (const name of readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "discovery").map((entry) => entry.name).sort()) {
    const folder = join(directory, name);
    const drive = JSON.parse(readFileSync(join(folder, "drive.json"), "utf8"));
    if (drive.exit !== 0 || drive.errors.length || !drive.observation) throw new Error("Incomplete execution: " + name);
    if (drive.observation.platform !== platform) throw new Error("Expected " + target.label + " process observation: " + name);
    const file = harness === "opencode-v2" ? "events.jsonl" : harness === "opencode-v1" ? "tool.execute.before.jsonl" : "PreToolUse.jsonl";
    const rows = readFileSync(join(folder, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const before = harness === "opencode-v2" ? rows.filter((row) => row.hook === "execute.before" && row.event.tool === "shell") : rows;
    if (before.length !== 1) throw new Error("Expected one native before payload: " + name);
    cases.push({ harness, version: metadata.version, capturedAt: metadata.capturedAt, case: name,
      requestedShell: ({ "exec-command-powershell": "powershell.exe", "exec-command-cmd": "cmd.exe", "exec-command-bash": "/bin/bash", "exec-command-zsh": "/bin/zsh" })[name] ?? "default",
      before: before[0], execution: drive.observation });
  }
  writeFileSync(join(root, harness + "-tools" + target.toolSuffix + ".json"), JSON.stringify({ names: tools.map((tool) => tool.name), shellTools: tools.filter((tool) => ["Bash", "PowerShell", "exec_command", "bash", "shell"].includes(tool.name)) }, null, 2) + "\n");
}
const codex = cases.filter((entry) => entry.harness === "codex");
if (new Set(codex.map((entry) => JSON.stringify(entry.before.tool_input))).size !== 1)
  throw new Error("Codex cases must have identical hook-visible command bytes");
writeFileSync(join(root, target.observations), JSON.stringify(redact({ platform: target.label, model: "scripted loopback playback", cases }), null, 2) + "\n");
console.log(JSON.stringify(cases.map((entry) => ({ harness: entry.harness, version: entry.version, case: entry.case, interpreter: entry.execution.ancestry[1].name }))));
