#!/usr/bin/env node
// Runs the without-git comparison in Windows Sandbox: a disposable Windows with no
// Git for Windows. This host maps its checkout, Node and claude.exe in read-only,
// and collects the raw capture from the one folder the sandbox may write.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windows Sandbox runs on Windows only");
const flags = process.argv.slice(2);
const unknown = flags.filter((flag) => flag !== "--prepare-only" && flag !== "--keep");
if (unknown.length) throw new Error("The flags are --prepare-only and --keep");
const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const onPath = (file) => (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, file)).find((candidate) => existsSync(candidate));
const sandbox = onPath("WindowsSandbox.exe") ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe");
if (!existsSync(sandbox) && !flags.includes("--prepare-only"))
  throw new Error("Windows Sandbox is not enabled on this host (optional feature Containers-DisposableClientVM)");
// The native binary, so the sandbox needs nothing installed to run it.
const claude = process.env.HKN_CLAUDE_EXE ?? onPath("claude.exe");
if (!claude || !existsSync(claude)) throw new Error("Put the native claude.exe on PATH, or name it in HKN_CLAUDE_EXE");
const pnpm = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager;
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pnpm ?? "")) throw new Error("package.json names no exact pnpm version");

const root = mkdtempSync(join(tmpdir(), "hkn-sandbox-"));
const tools = join(root, "tools");
const out = join(root, "out");
mkdirSync(tools);
mkdirSync(out);
cpSync(claude, join(tools, "claude.exe"));
// The sandbox half. Sources are copied off the read-only mount and built there, as
// the Linux container session did, so nothing in it depends on this host's
// dependency tree. Every step logs into the output folder.
const script = [
  "@echo off",
  "setlocal",
  'set "PATH=C:\\hkn\\node;C:\\hkn\\npm;C:\\hkn\\tools;%PATH%"',
  "set CI=true",
  'set "OUT=C:\\hkn\\out"',
  'echo started> "%OUT%\\started.txt"',
  'robocopy C:\\hkn\\src C:\\hkn\\work /E /XD node_modules .git captured /XF *.log /R:1 /W:1 /NFL /NDL /NP > "%OUT%\\copy.log" 2>&1',
  "if errorlevel 8 goto :failed",
  "cd /d C:\\hkn\\work",
  `call npm install --global --prefix C:\\hkn\\npm --no-fund --no-audit ${pnpm} > "%OUT%\\pnpm-setup.log" 2>&1 || goto :failed`,
  'call pnpm install --frozen-lockfile > "%OUT%\\pnpm-install.log" 2>&1 || goto :failed',
  'call pnpm run bundle > "%OUT%\\bundle.log" 2>&1 || goto :failed',
  'set "HKN_CAPTURE_ROOT=%OUT%\\captured"',
  'node --experimental-strip-types .capture\\shell-dialects\\drive.mjs claude without-git > "%OUT%\\capture.log" 2>&1',
  // Redirection first: `echo 0> file` would redirect handle 0 and write nothing.
  '> "%OUT%\\exit.txt" echo %ERRORLEVEL%',
  "goto :done",
  ":failed",
  '> "%OUT%\\exit.txt" echo setup-failed',
  ":done",
  ...(flags.includes("--keep") ? [] : ["shutdown /s /t 5"]),
  "",
];
writeFileSync(join(tools, "run.cmd"), script.join("\r\n"));
const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const mapped = (host, guest, readOnly) =>
  `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${guest}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
const configuration = join(root, "without-git.wsb");
writeFileSync(configuration, [
  "<Configuration>",
  "  <MemoryInMB>8192</MemoryInMB>",
  "  <VGpu>Disable</VGpu>",
  "  <AudioInput>Disable</AudioInput>",
  "  <VideoInput>Disable</VideoInput>",
  "  <PrinterRedirection>Disable</PrinterRedirection>",
  "  <ClipboardRedirection>Disable</ClipboardRedirection>",
  "  <MappedFolders>",
  mapped(repo, "C:\\hkn\\src", true),
  mapped(dirname(process.execPath), "C:\\hkn\\node", true),
  mapped(tools, "C:\\hkn\\tools", true),
  mapped(out, "C:\\hkn\\out", false),
  "  </MappedFolders>",
  "  <LogonCommand><Command>cmd.exe /c C:\\hkn\\tools\\run.cmd</Command></LogonCommand>",
  "</Configuration>",
  "",
].join("\r\n"));
console.log("configuration: " + configuration);
console.log("output: " + out);
if (flags.includes("--prepare-only")) process.exit(0);

spawn(sandbox, [configuration], { detached: true, stdio: "ignore" }).unref();
// The sandbox writes exit.txt last. Until then, say which step it has reached.
const steps = ["started.txt", "copy.log", "pnpm-setup.log", "pnpm-install.log", "bundle.log", "capture.log"];
const deadline = Date.now() + Number(process.env.HKN_SANDBOX_TIMEOUT_MINUTES ?? 40) * 60000;
let reached = "";
while (!existsSync(join(out, "exit.txt"))) {
  if (Date.now() > deadline) throw new Error("The sandbox did not finish; its logs are in " + out);
  const step = steps.findLast((file) => existsSync(join(out, file))) ?? "";
  if (step !== reached) console.log("sandbox reached: " + (reached = step));
  await new Promise((done) => setTimeout(done, 5000));
}
const exit = readFileSync(join(out, "exit.txt"), "utf8").trim();
const captured = join(out, "captured", "without-git", "claude");
if (existsSync(join(out, "capture.log"))) console.log(readFileSync(join(out, "capture.log"), "utf8").split("\n").map((line) => line.slice(0, 300)).join("\n"));
if (exit !== "0" || !existsSync(join(captured, "metadata.json"))) throw new Error("The sandbox run ended with " + exit + "; its logs are in " + out);
const destination = join(repo, ".capture/shell-dialects/captured/without-git/claude");
rmSync(destination, { recursive: true, force: true });
cpSync(captured, destination, { recursive: true });
console.log("collected " + readdirSync(destination).length + " entries into " + destination);
console.log("promote with HKN_CAPTURE_ACCOUNT=WDAGUtilityAccount node .capture/shell-dialects/promote.mjs without-git");
// The mapped folders stay held until the sandbox has shut down, about a minute after it reports.
const released = Date.now() + 180000;
while (!flags.includes("--keep")) {
  try {
    rmSync(root, { recursive: true, force: true });
    break;
  } catch {
    if (Date.now() > released) {
      console.log("left the sandbox's folders in " + root);
      break;
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
}
