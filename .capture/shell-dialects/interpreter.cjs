const { execFileSync } = require("node:child_process");
const { writeFileSync, readFileSync, readlinkSync } = require("node:fs");
const { join } = require("node:path");

let ancestry;
if (process.platform === "win32") {
  const query = [
    "$probeProcess = " + process.pid,
    "$rows = @()",
    "for ($i = 0; $i -lt 5 -and $probeProcess -gt 0; $i++) {",
    "$row = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $probeProcess)",
    "if (-not $row) { break }",
    "$rows += [pscustomobject]@{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; name = $row.Name; path = $row.ExecutablePath }",
    "$probeProcess = [int]$row.ParentProcessId",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress",
  ].join("\n");
  const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  // A Win32_Process query can stall on a busy hosted runner. One 20s attempt
  // used to abort the probe before it wrote interpreter.json, which playback
  // read as a missing file rather than a transient WMI failure. Retry once
  // and leave enough room for a slow query to finish.
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ancestry = JSON.parse(execFileSync(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
        { encoding: "utf8", windowsHide: true, timeout: 30000 },
      ));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (ancestry === undefined) throw lastError;
} else if (process.platform === "darwin") {
  ancestry = [];
  let pid = process.pid;
  for (let i = 0; i < 5 && pid > 0; i++) {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,ucomm=,comm="],
      { encoding: "utf8", timeout: 20000 });
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)\s*$/.exec(output);
    if (!row || Number(row[1]) !== pid) throw new Error("Unexpected ps ancestry row: " + output);
    const parentPid = Number(row[2]);
    ancestry.push({ pid, parentPid, name: row[3], command: row[4].trim() });
    pid = parentPid;
  }
} else if (process.platform === "linux") {
  ancestry = [];
  let pid = process.pid;
  for (let i = 0; i < 5 && pid > 0; i++) {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parentPid = Number(rest[1]);
    ancestry.push({ pid, parentPid, path: readlinkSync("/proc/" + pid + "/exe") });
    pid = parentPid;
  }
} else {
  throw new Error("This procedure has not been established on " + process.platform);
}
const observation = { platform: process.platform, node: process.version, ancestry };
writeFileSync("interpreter.json", JSON.stringify(observation, null, 2) + "\n");
console.log(JSON.stringify(observation));
