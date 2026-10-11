#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const selected = process.argv[2] ?? "win32";
// A `configured` comparison holds the model's arguments fixed and varies the host
// configuration. Codex joins it on Linux only, where its default follows the host.
const comparisons = {
  win32: { platform: "win32", label: "Windows", directory: "", observations: "observations.json", toolSuffix: "" },
  darwin: { platform: "darwin", label: "macOS", directory: "darwin", observations: "observations-macos.json", toolSuffix: "-macos" },
  linux: { platform: "linux", label: "Linux", directory: "linux", observations: "observations-linux.json", toolSuffix: "-linux" },
  configured: { platform: "win32", label: "Windows", directory: "configured", observations: "observations-configured.json", configured: true },
  "configured-linux": { platform: "linux", label: "Linux", directory: "configured-linux", observations: "observations-configured-linux.json", configured: true },
  // The default cases on builds other than a comparison's own, one directory per harness and version.
  builds: { platform: "win32", label: "Windows", directory: "builds", observations: "observations-builds.json", builds: true },
};
if (!Object.hasOwn(comparisons, selected)) throw new Error("Specify win32, darwin, linux, configured, configured-linux, or builds");
const target = comparisons[selected];
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
const shellToolNames = ["Bash", "PowerShell", "exec_command", "bash", "shell"];
const requestedShells = { "exec-command-powershell": "powershell.exe", "exec-command-cmd": "cmd.exe", "exec-command-bash": "/bin/bash", "exec-command-zsh": "/bin/zsh",
  "exec-command-fish": "/usr/bin/fish", "exec-command-tcsh": "/usr/bin/tcsh", "exec-command-pwsh": "/usr/bin/pwsh" };
// What OpenCode itself said about its shell, through which hook, and whether that
// arrived before the call it applies to. Only the stating sentence is kept.
function reported(harness, folder, rows) {
  if (harness === "opencode-v2") {
    const stated = rows.findIndex((row) => row.hook === "context" && typeof row.event.tools?.shell?.description === "string");
    if (stated === -1) return undefined;
    const call = rows.findIndex((row) => row.hook === "execute.before" && row.event.tool === "shell");
    const created = rows.find((row) => row.hook === "event" && row.event.type === "shell.created");
    return { hook: "context", field: "tools.shell.description",
      statement: /Commands run[^.]*\./.exec(rows[stated].event.tools.shell.description)?.[0] ?? null,
      beforeCall: stated < call, shellCreated: created?.event.data.info.shell ?? null };
  }
  if (harness !== "opencode-v1" || !existsSync(join(folder, "shell-report-order.jsonl"))) return undefined;
  const read = (file) => readFileSync(join(folder, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const order = read("shell-report-order.jsonl").map((row) => row.hook);
  const definition = read("tool.definition.jsonl").find((row) => row.input.toolID === "bash");
  // The callback's shape: its input verbatim and the keys of its output, a live object.
  return { hook: "tool.definition", input: definition?.input ?? null, outputKeys: Object.keys(definition?.output ?? {}), field: "description",
    statement: /Be aware:[^\n]*/.exec(definition?.output.description ?? "")?.[0] ?? null,
    beforeCall: order.includes("tool.definition") && order.indexOf("tool.definition") < order.indexOf("tool.execute.before"),
    configShell: read("config.jsonl")[0]?.shell ?? null };
}
// What Codex's transcript file held about the shell when PreToolUse ran: the pending
// call's router arguments and the shell the harness stated. Not a hook payload.
function transcriptAtHook(folder) {
  const file = join(folder, "transcript-at-PreToolUse.jsonl");
  if (!existsSync(file)) return undefined;
  const [row] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return { existed: row.transcriptExists, statedShells: row.statedShells ?? [],
    pendingCalls: (row.calls ?? []).map((call) => ({ type: call.type, name: call.name, arguments: call.arguments })),
    shellKeys: (row.shellKeys ?? []).map((entry) => ({ at: entry.at.replace(/^line\d+\./, ""), value: entry.value })) };
}
const cases = [];
const advertised = {};
const captures = target.builds ? readdirSync(join(root, "captured", target.directory)).sort()
  : target.configured && target.platform === "win32" ? ["claude", "opencode-v1", "opencode-v2"] : ["claude", "codex", "opencode-v1", "opencode-v2"];
for (const capture of captures) {
  const directory = join(root, "captured", target.directory, capture);
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  const harness = metadata.harness;
  if (capture !== (target.builds ? harness + "-" + metadata.version : harness)) throw new Error("Capture directory does not match its metadata: " + capture);
  if (metadata.platform !== target.platform) throw new Error("Expected " + target.label + " capture metadata: " + harness);
  const tools = JSON.parse(readFileSync(join(directory, "discovery.json"), "utf8"));
  for (const name of readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "discovery").map((entry) => entry.name).sort()) {
    const folder = join(directory, name);
    const drive = JSON.parse(readFileSync(join(folder, "drive.json"), "utf8"));
    if (drive.exit !== 0 || drive.errors.length || !drive.observation) throw new Error("Incomplete execution: " + name);
    if (drive.observation.platform !== target.platform) throw new Error("Expected " + target.label + " process observation: " + name);
    const file = harness === "opencode-v2" ? "events.jsonl" : harness === "opencode-v1" ? "tool.execute.before.jsonl" : "PreToolUse.jsonl";
    const rows = readFileSync(join(folder, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const before = harness === "opencode-v2" ? rows.filter((row) => row.hook === "execute.before" && row.event.tool === "shell") : rows;
    if (before.length !== 1) throw new Error("Expected one native before payload: " + name);
    if (target.configured && (typeof drive.set !== "string" || !drive.host)) throw new Error("Expected a recorded host configuration: " + name);
    const stated = reported(harness, folder, rows);
    const transcript = harness === "codex" ? transcriptAtHook(folder) : undefined;
    cases.push({ harness, version: metadata.version, capturedAt: metadata.capturedAt, case: name,
      ...(target.configured ? { configuration: { set: drive.set, opencodeShell: drive.opencodeShell, host: drive.host } }
        : { requestedShell: requestedShells[name] ?? "default", ...(drive.host ? { host: drive.host } : {}) }),
      before: before[0], ...(stated ? { reported: stated } : {}), ...(transcript ? { transcript } : {}), execution: drive.observation });
  }
  const shellTools = tools.filter((tool) => shellToolNames.includes(tool.name));
  // A configured comparison embeds what was advertised; its full tool list matches the default one.
  if (target.configured) advertised[harness] = shellTools;
  else if (!target.builds) writeFileSync(join(root, harness + "-tools" + target.toolSuffix + ".json"), JSON.stringify({ names: tools.map((tool) => tool.name), shellTools }, null, 2) + "\n");
}
// What the hook saw of the call itself: the native tool name and its arguments.
function hookVisible(entry) {
  if (entry.harness === "opencode-v2") return JSON.stringify([entry.before.event.tool, entry.before.event.input]);
  if (entry.harness === "opencode-v1") return JSON.stringify([entry.before.input.tool, entry.before.output.args]);
  return JSON.stringify([entry.before.tool_name, entry.before.tool_input]);
}
if (target.configured) {
  // The comparison only means something if nothing the hook receives separates the cases of one tool.
  const inputs = new Map();
  for (const entry of cases) {
    const [tool, input] = JSON.parse(hookVisible(entry));
    const key = entry.harness + " " + tool;
    if (inputs.has(key) && inputs.get(key) !== JSON.stringify(input)) throw new Error("Configured cases must have identical hook-visible input: " + key);
    inputs.set(key, JSON.stringify(input));
  }
} else {
  const codex = cases.filter((entry) => entry.harness === "codex");
  if ((codex.length > 0 || !target.builds) && new Set(codex.map((entry) => JSON.stringify(entry.before.tool_input))).size !== 1)
    throw new Error("Codex cases must have identical hook-visible command bytes");
}
writeFileSync(join(root, target.observations), JSON.stringify(redact({ platform: target.label, model: "scripted loopback playback",
  ...(target.configured ? { comparison: "host configuration", advertised } : target.builds ? { comparison: "builds" } : {}), cases }), null, 2) + "\n");
console.log(JSON.stringify(cases.map((entry) => ({ harness: entry.harness, version: entry.version, case: entry.case,
  interpreter: entry.execution.ancestry[1].name ?? entry.execution.ancestry[1].path }))));
