# Run one command as the lane user (prototype; see lane-setup.ps1). Run the
# staged copy from the admin directory, never the checkout's.
#   C:\hkn-admin\lane-run.ps1 -Label <name> -Command '<command line>' [-RequireEnv A,B] [-Bits] [-TimeoutSec N]
# - The lane gets an allowlisted environment: Windows' own variables, CI and
#   RUNNER_OS-style booleans, and HOOKNOSTIC_* / HKN_* names. Its profile,
#   temp and app-data variables point into the scratch tree. Everything else,
#   including ACTIONS_*, GITHUB_TOKEN and the file-command paths, stays out.
#   The dropped names are listed (names only).
# - The required names and the lane user's SID reach the lane from here, as
#   data written before it starts, never from the environment it checks.
# - HKN_RIPGREP_DIR and HKN_PLAYBACK_ARTIFACT_DIR are re-pointed into the
#   scratch tree (ripgrep is copied), so the lane writes nothing the admin's
#   later steps read in place.
# - Output goes to files in the admin directory, through handles the lane
#   inherits; this script tails them into the log and exits with the lane's
#   exit code.
param(
  [Parameter(Mandatory)][string]$Label,
  [Parameter(Mandatory)][string]$Command,
  [string]$RequireEnv = '',
  [switch]$Bits,
  [int]$TimeoutSec = 0,
  [string]$Cwd = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
$Admin = $PSScriptRoot
$state = Get-Content -Raw "$Admin\state.json" | ConvertFrom-Json
$Scratch = $state.scratch
$timer = [Diagnostics.Stopwatch]::StartNew()

# 1. The allowlisted environment.
$system = @('ALLUSERSPROFILE', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'COMPUTERNAME', 'ComSpec',
  'DriverData', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PSModulePath', 'PUBLIC', 'SystemDrive',
  'SystemRoot', 'windir', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'RUNNER_TRACKING_ID')
$sensitive = '^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)|(TOKEN|SECRET|PASSWORD|_KEY)$'
$laneEnv = [ordered]@{}
$dropped = [Collections.Generic.List[string]]::new()
foreach ($item in Get-ChildItem env:) {
  if ($item.Name -in $system -or $item.Name -match '^(HOOKNOSTIC_|HKN_)') { $laneEnv[$item.Name] = $item.Value } else { $dropped.Add($item.Name) }
}
$laneHome = Join-Path $Scratch 'home'
$laneEnv['USERPROFILE'] = $laneHome; $laneEnv['HOME'] = $laneHome
$laneEnv['HOMEDRIVE'] = Split-Path -Qualifier $laneHome; $laneEnv['HOMEPATH'] = Split-Path -NoQualifier $laneHome
$laneEnv['APPDATA'] = Join-Path $Scratch 'appdata'; $laneEnv['LOCALAPPDATA'] = Join-Path $Scratch 'localappdata'
$laneEnv['TEMP'] = Join-Path $Scratch 'temp'; $laneEnv['TMP'] = Join-Path $Scratch 'temp'
$laneEnv['USERNAME'] = $state.user
$laneEnv['HOOKNOSTIC_PLAYBACK_NETWORK'] = 'none'
if ($laneEnv.Contains('HKN_RIPGREP_DIR')) {
  $rg = Join-Path $Scratch 'work\ripgrep'
  if (Test-Path $laneEnv['HKN_RIPGREP_DIR']) { Copy-Item -Recurse -Force $laneEnv['HKN_RIPGREP_DIR'] $rg } else { New-Item -ItemType Directory -Force -Path $rg | Out-Null }
  $laneEnv['HKN_RIPGREP_DIR'] = $rg
}
if ($laneEnv.Contains('HKN_PLAYBACK_ARTIFACT_DIR')) { $laneEnv['HKN_PLAYBACK_ARTIFACT_DIR'] = Join-Path $Scratch 'work\playback-artifacts' }
"lane-run ${Label}: step environment $($laneEnv.Count + $dropped.Count) names; passed $($laneEnv.Count); dropped $($dropped.Count)"
"lane-run ${Label}: dropped names that look sensitive: $((@($dropped | Where-Object { $_ -match $sensitive }) | Sort-Object) -join ', ')"

# 2. What the lane must not be able to write or read (labels, not paths, are printed).
$targets = [Collections.Generic.List[object]]::new()
function Add-Target([string]$label, [string]$kind, [string]$path) { if ($path) { $targets.Add([ordered]@{ label = $label; kind = $kind; path = $path }) } }
$ws = $env:GITHUB_WORKSPACE
$work = Split-Path -Parent (Split-Path -Parent $ws)
Add-Target 'workspace' dir $ws
Add-Target 'workspace\scripts' dir "$ws\scripts"
Add-Target 'workspace\.git' dir "$ws\.git"
Add-Target 'workspace\node_modules' dir "$ws\node_modules"
Add-Target 'RUNNER_TEMP' dir $env:RUNNER_TEMP
Add-Target 'RUNNER_TEMP\_runner_file_commands' dir "$env:RUNNER_TEMP\_runner_file_commands"
Add-Target 'actions dir (_actions)' dir "$work\_actions"
Add-Target 'admin staging dir' dir $Admin
Add-Target 'npm global prefix' dir ((npm config get prefix) | Select-Object -First 1)
Add-Target 'node toolcache dir' dir (Split-Path -Parent (Get-Command node).Source)
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) {
  Add-Target 'pnpm command dir' dir (Split-Path -Parent $pnpm.Source)
  Add-Target 'pnpm command' read $pnpm.Source
  Add-Target 'pnpm store' dir ((& $pnpm.Source store path 2>$null) | Select-Object -First 1)
}
Add-Target 'hostedtoolcache' dir 'C:\hostedtoolcache\windows'
Add-Target 'Git for Windows cmd' dir 'C:\Program Files\Git\cmd'
Add-Target 'runneradmin profile' dir $env:USERPROFILE
Add-Target 'C:\ root' dir 'C:\'
Add-Target 'D:\ root' dir 'D:\'
Add-Target 'C:\Windows\Temp' dir 'C:\Windows\Temp'
$worker = (Get-CimInstance Win32_Process -Filter "Name = 'Runner.Worker.exe'" | Select-Object -First 1).ExecutablePath
if ($worker) {
  Add-Target 'runner bin dir' dir (Split-Path -Parent $worker)
  Add-Target 'runner root' dir 'C:\actions-runner'
  Get-ChildItem 'C:\actions-runner' -Force -Recurse -Depth 3 -Include '.credentials', '.credentials_rsaparams', '.runner' -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Target "runner $($_.Name)" read $_.FullName }
}
foreach ($name in 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { Add-Target "$name file" write $value; Add-Target "$name file" read $value }
}
Get-ChildItem $env:RUNNER_TEMP -Filter 'git-credentials-*.config' -ErrorAction SilentlyContinue | ForEach-Object { Add-Target 'checkout credentials file' read $_.FullName }
Add-Target 'workspace scripts\without-network.sh' write "$ws\scripts\without-network.sh"
Add-Target 'workspace .git\config' write "$ws\.git\config"
Add-Target 'staged lane-after.ps1' write "$Admin\lane-after.ps1"
Add-Target 'staged lane-after.ps1' read "$Admin\lane-after.ps1"
Add-Target 'admin cred.txt' read "$Admin\cred.txt"
Add-Target 'toolcache node.exe' write (Get-Command node).Source

# 3. Hand-off, written before the lane exists... as far as this run is concerned.
$require = @($RequireEnv -split ',' | Where-Object { $_ })
[ordered]@{
  label = $Label; integrity = $state.integrity; command = $Command; cwd = $Cwd; require = $require; bits = [bool]$Bits
  scratch = $Scratch; targets = $targets; env = $laneEnv
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$Scratch\bin\lane.json"

# 4. Launch as the lane user and stream its output.
$cred = [pscredential]::new($state.user, (Get-Content "$Admin\cred.txt" | ConvertTo-SecureString))
$out = "$Admin\$Label.out"; $err = "$Admin\$Label.err"
$argList = @("$Scratch\bin\lane-inner.mjs", $Scratch, $state.sid)
$mode = 'UseNewEnvironment'
try {
  $p = Start-Process -FilePath $state.laneNode -ArgumentList $argList -Credential $cred -UseNewEnvironment -WorkingDirectory $Cwd -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
} catch {
  $mode = "inherited environment (UseNewEnvironment failed: $($_.Exception.Message))"
  $p = Start-Process -FilePath $state.laneNode -ArgumentList $argList -Credential $cred -WorkingDirectory $Cwd -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
}
$null = $p.Handle
"lane-run ${Label}: started pid $($p.Id) after $([int]$timer.Elapsed.TotalMilliseconds) ms ($mode)"
$pos = @{ $out = [long]0; $err = [long]0 }
function Read-New([string]$path) {
  if (-not (Test-Path $path)) { return }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $null = $fs.Seek($pos[$path], 'Begin')
    $text = [IO.StreamReader]::new($fs).ReadToEnd()
    $pos[$path] = $fs.Length
  } finally { $fs.Dispose() }
  if ($text) { [Console]::Out.Write($text) }
}
$timedOut = $false
while (-not $p.HasExited) {
  Read-New $out; Read-New $err
  if ($TimeoutSec -gt 0 -and $timer.Elapsed.TotalSeconds -gt $TimeoutSec) { $timedOut = $true; break }
  Start-Sleep -Milliseconds 1000
}
if ($timedOut) {
  "lane-run ${Label}: own timeout after $TimeoutSec s; stopping the lane user's processes"
  & "$Admin\lane-after.ps1" -Label "$Label-timeout" -KillOnly
}
$p.WaitForExit()
Read-New $out; Read-New $err
$code = if ($timedOut) { 124 } else { $p.ExitCode }
"lane-run ${Label}: exit $code after $([int]$timer.Elapsed.TotalSeconds) s"
exit $code
