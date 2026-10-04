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
  ancestry = JSON.parse(execFileSync(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  ));
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
