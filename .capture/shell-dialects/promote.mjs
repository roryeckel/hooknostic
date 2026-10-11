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
  // A Windows host with no Git for Windows: what Claude Code advertises under each host configuration, and what those tools run.
  "without-git": { platform: "win32", label: "Windows", directory: "without-git", observations: "observations-without-git.json", withoutGit: true },
};
if (!Object.hasOwn(comparisons, selected)) throw new Error("Specify win32, darwin, linux, configured, configured-linux, builds, or without-git");
const target = comparisons[selected];
const account = process.env.HKN_CAPTURE_ACCOUNT ?? process.env.USERNAME ?? process.env.USER;
if (!account?.trim()) throw new Error("HKN_CAPTURE_ACCOUNT, USERNAME, or USER is required for account-path redaction");
// The named account, and every account a capture's own metadata records it ran as.
// None of them may remain in the published text.
const accounts = new Set([account]);
// The accounts redacted between path separators wherever they appear: the named
// one, and a capture's own when it records no home to redact exactly. This rule
// cannot tell an account's folder from another folder of the same name, so it is
// kept only for the captures that give nothing better to go on.
const between = new Set([account]);
// The home directory a capture's metadata records, which is redacted exactly: its
// last segment, wherever that path begins a path and whether or not anything follows.
const homes = new Set();
const literal = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Only an absolute path that ends in a name is taken for a home. Anything else
// could match text that is not a path, and a drive or the root has no last
// segment to stand for an account: it would match every path beneath it.
function recordHome(home) {
  if (typeof home !== "string" || !/^(?:[A-Za-z]:)?[\\/]/.test(home)) return false;
  const name = home.split(/[\\/]+/).filter(Boolean).at(-1);
  if (name === undefined || /^[A-Za-z]:$/.test(name)) return false;
  homes.add(home);
  // Its last segment is the account as the file system spells it, which need not be the login name.
  accounts.add(name);
  return true;
}
// The account and home a capture's metadata records. The driver writes a home only beside its account.
function recordCapture(metadata) {
  if (typeof metadata.account === "string") accounts.add(metadata.account);
  else if (metadata.home !== undefined) throw new Error("The capture's metadata records a home without an account");
  if (!recordHome(metadata.home) && typeof metadata.account === "string") between.add(metadata.account);
}
function homePattern(home) {
  const segments = home.split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:/.test(home);
  const unc = /^[\\/]{2}/.test(home);
  // A home that names no drive opens with its own separator: one for a rooted
  // path, two or more for a UNC one. The `//` of a URL is then not the root.
  const opens = drive ? "" : unc ? "[\\\\/]{2,}" : "[\\\\/]";
  const above = opens + segments.slice(0, -1).map((segment) => literal(segment) + "[\\\\/]+").join("");
  // The match begins where a path can begin: not partway through a longer path or
  // name, and for a home that names no drive, not behind a drive letter either.
  // A UNC opening behind any colon is a URL's `//`, or a drive's.
  const begins = drive ? "(?<![A-Za-z0-9])" : "(?<![A-Za-z0-9._~\\\\/-])" + (unc ? "(?<!:)" : "(?<!(?:^|[^A-Za-z0-9])[A-Za-z]:)");
  // It ends as a whole segment: at a separator, a closing quote, or the end. Any
  // other character can continue a folder's name, and a sibling such as `name+x`
  // is someone else's. What is left unmatched, published() refuses.
  const ends = '(?=[\\\\/"]|$)';
  // Windows compares paths without case; a drive letter, a UNC opening or a backslash marks one.
  return new RegExp("(" + begins + above + ")" + literal(segments.at(-1)) + ends, drive || unc || home.includes("\\") ? "gi" : "g");
}
function redact(value) {
  if (typeof value === "string") {
    const text = [...homes].reduce((path, home) => path.replace(homePattern(home), "$1user"), value);
    // The transcript folder a harness names after the working directory, for every account.
    const slugged = [...accounts].reduce((path, name) => path
      .replace(new RegExp("--users-" + literal(name) + "-", "gi"), (slug) => slug.slice(0, "--users-".length) + "user-"), text);
    // Without a recorded home, the account between separators. A path that only
    // ends at it is left alone, because an account can share its name with a
    // program, and published() then refuses what remains.
    return [...between].reduce((path, name) => path
      .replace(new RegExp("\\\\" + literal(name) + "\\\\", "gi"), "\\user\\")
      .replaceAll("/" + name + "/", "/user/"), slugged);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    // Keys as well: a harness can key a map by path. Two keys that redaction
    // made one would drop an entry without a word, so that is refused.
    const entries = Object.entries(value).map(([key, child]) => [redact(key), redact(child)]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Two keys became the same key after redaction");
    return Object.fromEntries(entries);
  }
  return value;
}
// The promoted text, refused if an account can still be read in it: a home
// directory under any name but `user`, which catches a capture made as an account
// nobody named, or a known account left anywhere as a word of its own. As in
// promote-fixtures.mjs, a home's segment ends at a separator or the closing
// quote. Refusing is the safe direction: an account that shares its name with a
// program the capture ran cannot be promoted, and is told so, instead of having
// that program's path rewritten. The message quotes what was matched.
function published(text) {
  // One separator or a run of them, taken whole: backslashes double again each time
  // a path sits inside a string inside a string.
  const separator = "(?:\\/|\\\\\\\\)+(?![\\/\\\\])";
  const other = '(?!user(?:[\\/\\\\"]|$))';
  const segment = '[^\\/\\\\"]*';
  const left = new RegExp("\\/home\\/" + other + segment).exec(text)
    ?? new RegExp(separator + "Users" + separator + other + segment, "i").exec(text)
    ?? [...accounts].filter((name) => name.toLowerCase() !== "user")
      .map((name) => new RegExp("(?<![A-Za-z0-9])" + literal(name) + "(?![A-Za-z0-9])", "i").exec(text)).find(Boolean);
  if (left) throw new Error("An account survived redaction (" + left[0] + "); name the capture's account in HKN_CAPTURE_ACCOUNT, or capture as an account whose name nothing else in the record shares");
  return text;
}
const shellToolNames = ["Bash", "PowerShell", "exec_command", "bash", "shell"];
const requestedShells = { "exec-command-powershell": "powershell.exe", "exec-command-cmd": "cmd.exe", "exec-command-bash": "/bin/bash", "exec-command-zsh": "/bin/zsh",
  "exec-command-fish": "/usr/bin/fish", "exec-command-tcsh": "/usr/bin/tcsh", "exec-command-pwsh": "/usr/bin/pwsh" };
// What OpenCode itself said about its shell, through which hook, and whether that
// arrived before the call it applies to. Only the stating sentence is kept.
function reported(harness, folder, rows) {
  if (harness === "opencode-v2") {
    // The statement in force for the call is the last one before it, as in promote-fixtures.mjs.
    const call = rows.findIndex((row) => row.hook === "execute.before" && row.event.tool === "shell");
    const states = (row) => row.hook === "context" && typeof row.event.tools?.shell?.description === "string";
    const before = rows.findLastIndex((row, index) => index < call && states(row));
    // A session that only stated its shell after the call is still recorded, as not before it.
    const stated = before !== -1 ? before : rows.findIndex(states);
    if (stated === -1) return undefined;
    const created = rows.find((row) => row.hook === "event" && row.event.type === "shell.created");
    return { hook: "context", field: "tools.shell.description",
      statement: /Commands run[^.]*\./.exec(rows[stated].event.tools.shell.description)?.[0] ?? null,
      beforeCall: stated < call, shellCreated: created?.event.data.info.shell ?? null };
  }
  if (harness !== "opencode-v1" || !existsSync(join(folder, "shell-report-order.jsonl"))) return undefined;
  const read = (file) => readFileSync(join(folder, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const order = read("shell-report-order.jsonl").map((row) => row.hook);
  // The statement in force for the call is the last one before it, as in promote-fixtures.mjs:
  // the order file counts the bash definitions that preceded the call.
  const preceding = order.slice(0, Math.max(0, order.indexOf("tool.execute.before"))).filter((hook) => hook === "tool.definition").length;
  const definitions = read("tool.definition.jsonl").filter((row) => row.input.toolID === "bash");
  const definition = definitions[Math.max(0, preceding - 1)];
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
// Nothing is written until the whole promotion has been accepted.
const pending = [];
// The without-git comparison is read on its own terms. Which shell tools exist is
// its question, so every configuration has a discovery of its own, and one that
// advertises none, exits before any request, or calls a tool that runs nothing is
// kept. A session the driver did not complete is not an observation of the
// harness and is refused, as is a capture missing a configuration it planned.
function withoutGit() {
  const directory = join(root, "captured", target.directory, "claude");
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  if (metadata.harness !== "claude" || metadata.platform !== target.platform) throw new Error("Expected a Windows Claude Code capture");
  if (!Array.isArray(metadata.gitForWindows) || metadata.gitForWindows.length) throw new Error("The capture host had Git for Windows");
  recordCapture(metadata);
  // The shell tools the driver calls, which are the ones a call folder is expected for.
  const driven = Array.isArray(metadata.shellTools) ? metadata.shellTools : ["Bash", "PowerShell"];
  const folders = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const completed = (name) => {
    const session = JSON.parse(readFileSync(join(directory, name, "drive.json"), "utf8"));
    if (typeof session.exit !== "number" || session.errors.length) throw new Error("The driver did not complete this session: " + name);
    return session;
  };
  const rows = (name, file) => !existsSync(join(directory, name, file)) ? []
    : readFileSync(join(directory, name, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const discoveries = folders.filter((name) => name.startsWith("discovery-")).map((name) => name.slice("discovery-".length));
  const planned = Array.isArray(metadata.configurations) ? [...metadata.configurations].sort() : [];
  if (!planned.length || JSON.stringify(planned) !== JSON.stringify(discoveries)) throw new Error("Expected a discovery for each planned configuration: " + planned.join(", "));
  const configurations = discoveries.map((configuration) => {
    const session = completed("discovery-" + configuration);
    const started = session.exit === 0;
    // Not starting means exiting before any model request, with whatever it printed.
    if (!started && session.requests !== 0) throw new Error("A discovery failed after it had started: " + configuration);
    if (started && configuration === "default") pending.push([join(root, "claude-tools-without-git.json"), JSON.stringify({
      names: session.tools.map((tool) => tool.name), shellTools: session.tools.filter((tool) => driven.includes(tool.name)) }, null, 2) + "\n"]);
    return { configuration, set: session.set, started,
      ...(started ? { advertised: session.tools.filter((tool) => driven.includes(tool.name)) }
        : { exit: session.exit, requests: session.requests, output: session.tail }) };
  });
  if (!configurations.some((entry) => entry.configuration === "default" && entry.started)) throw new Error("The default configuration did not start");
  // Each configuration that started is followed by one call per shell tool it advertised, and by nothing else.
  const expected = configurations.filter((entry) => entry.started)
    .flatMap((entry) => entry.advertised.map((tool) => tool.name.toLowerCase() + "-" + entry.configuration)).sort();
  const calls = folders.filter((entry) => !entry.startsWith("discovery-"));
  if (JSON.stringify(expected) !== JSON.stringify(calls)) throw new Error("Expected one call per advertised shell tool, and no other folder: " + expected.join(", "));
  for (const name of calls) {
    const session = completed(name);
    const before = rows(name, "PreToolUse.jsonl");
    if (before.length > 1) throw new Error("Expected at most one native before payload: " + name);
    if (session.observation && (session.observation.platform !== target.platform || before.length !== 1)) throw new Error("Expected a Windows process observation behind one before payload: " + name);
    cases.push({ harness: "claude", version: metadata.version, capturedAt: metadata.capturedAt, case: name,
      configuration: { set: session.set, host: session.host ?? null }, before: before[0] ?? null, execution: session.observation ?? null,
      // A call that ran nothing: what the harness reported for it instead.
      ...(session.observation ? {} : { failure: rows(name, "PostToolUseFailure.jsonl")[0] ?? null, exit: session.exit, output: session.tail }) });
  }
  return { host: { windows: metadata.windows ?? null, gitForWindows: metadata.gitForWindows, bashOnPath: metadata.bashOnPath ?? [] }, configurations };
}
const bare = target.withoutGit ? withoutGit() : undefined;
const captures = target.withoutGit ? [] : target.builds ? readdirSync(join(root, "captured", target.directory)).sort()
  : target.configured && target.platform === "win32" ? ["claude", "opencode-v1", "opencode-v2"] : ["claude", "codex", "opencode-v1", "opencode-v2"];
for (const capture of captures) {
  const directory = join(root, "captured", target.directory, capture);
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  recordCapture(metadata);
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
  else if (!target.builds) pending.push([join(root, harness + "-tools" + target.toolSuffix + ".json"), JSON.stringify({ names: tools.map((tool) => tool.name), shellTools }, null, 2) + "\n"]);
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
} else if (!target.withoutGit) {
  const codex = cases.filter((entry) => entry.harness === "codex");
  if ((codex.length > 0 || !target.builds) && new Set(codex.map((entry) => JSON.stringify(entry.before.tool_input))).size !== 1)
    throw new Error("Codex cases must have identical hook-visible command bytes");
}
pending.push([join(root, target.observations), JSON.stringify(redact({ platform: target.label, model: "scripted loopback playback",
  ...(target.configured ? { comparison: "host configuration", advertised } : target.builds ? { comparison: "builds" }
    : bare ? { comparison: "no Git for Windows", ...bare } : {}), cases }), null, 2) + "\n"]);
// Every file is checked before the first is written, so a refusal leaves the committed records as they were.
for (const [path, contents] of pending.map(([path, contents]) => [path, published(contents)])) writeFileSync(path, contents);
console.log(JSON.stringify(cases.map((entry) => ({ harness: entry.harness, version: entry.version, case: entry.case,
  interpreter: !entry.execution ? null : entry.execution.ancestry[1].name ?? entry.execution.ancestry[1].path }))));
