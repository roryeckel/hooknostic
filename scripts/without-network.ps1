# Run a command with no IP network but loopback, as a dedicated standard user.
# Windows only, and GitHub-hosted runners only: it creates a local user and a
# firewall rule. scripts/without-network.sh is the Linux twin.
#
#   pwsh scripts/without-network.ps1 -RequireEnv A,B [-TimeoutMinutes N] -Run '<command line>'
#   pwsh scripts/without-network.ps1 -Cleanup
#   pwsh scripts/without-network.ps1 -DryRun -RequireEnv A,B -Run '<command line>'
# The command line runs through cmd.exe, so .cmd shims such as pnpm work.
#
# The goal is that accidental egress fails loudly: a lane that needs a
# download, or a harness that calls home. A deliberate escape is out of
# scope (docs/testing.md, "Network isolation on Windows").
#
# A run:
# 1. Checks its arguments: a non-empty -RequireEnv of variable names, and a
#    command line.
# 2. Refuses unless on a GitHub-hosted runner, elevated, with the Windows
#    Firewall service running and every profile enabled. -DryRun stops after
#    these checks: tests use it, so no test ever reaches the steps below,
#    even on CI's elevated runner.
# 3. Creates the standard user hknoffline (a random password, held only in
#    memory; a member of Users only), and one outbound block rule for its SID
#    (rule group hkn-offline). Block beats every allow rule; loopback is
#    exempt from firewall rules.
# 4. Makes a scratch directory the user may write. The lane's profile, temp
#    and app-data variables point there; the runner user's profile, which
#    they would otherwise name, is closed to it.
# 5. Hands over an allowlisted environment: Windows' own variables, CI,
#    GITHUB_ACTIONS, RUNNER_OS/ARCH/ENVIRONMENT/TRACKING_ID, and HOOKNOSTIC_*
#    and HKN_* names, plus HOOKNOSTIC_PLAYBACK_NETWORK=none and CODEX_HOME in
#    the scratch directory. Everything else stays out, ACTIONS_* and the
#    file-command paths included; their names, never values, are listed.
# 6. Starts scripts/without-network-lane.mjs as that user. The lane side runs
#    scripts/assert-no-network.mjs --offline with the required names and the
#    expected SID from here, and runs the command only if that passes. Output
#    streams into the log; the exit code is the lane's.
#
# -Cleanup is the always() step. It needs no precondition and is safe after
# a refusal: it stops every process owned by the user (and checks that none
# is left), removes the rule group, and disables the user. It deletes
# nothing. A cancelled workflow may skip it; the runner is single-use.
[CmdletBinding()]
param(
  [string]$RequireEnv = '',
  [switch]$Cleanup,
  [switch]$DryRun,
  [int]$TimeoutMinutes = 0,
  [string]$Run = ''
)
$ErrorActionPreference = 'Stop'
$LaneUser = 'hknoffline'
$RuleGroup = 'hkn-offline'

function Stop-Refusing([string]$why) {
  [Console]::Error.WriteLine("without-network: $why")
  exit 2
}

# Every process owned by the lane user, by owner SID (not taskkill's name
# filter). Stops them and checks again, a bounded number of times, because
# Stop-Process returns before a process has gone. Returns how many are left.
function Stop-LaneProcesses([string]$sid) {
  $left = 0
  for ($i = 0; $i -lt 10; $i++) {
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $sid } catch { $false }
      })
    $left = $procs.Count
    if ($left -eq 0) { break }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
  $left
}

if ($Cleanup) {
  $left = 0
  $user = Get-LocalUser -Name $LaneUser -ErrorAction SilentlyContinue
  if ($user) {
    $left = Stop-LaneProcesses $user.SID.Value
    "without-network: lane processes left after stopping: $left"
    Disable-LocalUser -Name $LaneUser -ErrorAction SilentlyContinue
  } else {
    'without-network: no lane user, so no lane processes'
  }
  $rules = @(Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue)
  if ($rules.Count) { $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
  "without-network: firewall rules removed: $($rules.Count); left: $(@(Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue).Count)"
  if ($left) { exit 1 }
  exit 0
}

# 1. Arguments.
$names = @($RequireEnv -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($names.Count -eq 0) { Stop-Refusing 'no required variables: pass -RequireEnv A,B (an empty list checks nothing)' }
$bad = @($names | Where-Object { $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' })
if ($bad.Count) { Stop-Refusing "not a variable name: $($bad -join ', ')" }
if (-not $Run.Trim()) { Stop-Refusing "no command: pass -Run '<command line>'" }

# 2. Refusals.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  Stop-Refusing 'GitHub-hosted runners only: it creates a local user and a firewall rule'
}
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Refusing 'needs an elevated administrator'
}
if ((Get-Service mpssvc).Status -ne 'Running') { Stop-Refusing 'the Windows Firewall service is not running' }
$off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
if ($off.Count) { Stop-Refusing "firewall profile(s) not enabled: $($off.Name -join ', ')" }
if (Get-LocalUser -Name $LaneUser -ErrorAction SilentlyContinue) { Stop-Refusing "user $LaneUser exists already: one lane per job" }
if ($DryRun) {
  "without-network: dry run: would run $(($Run.Trim() -split '\s+')[0]) as $LaneUser, requiring $($names -join ', ')"
  exit 0
}
$timer = [Diagnostics.Stopwatch]::StartNew()

# 3. The user and its rule.
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secure = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + 'aA1!') -AsPlainText -Force
New-LocalUser -Name $LaneUser -Password $secure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null
$sid = (Get-LocalUser -Name $LaneUser).SID.Value
if (-not (@(Get-LocalGroupMember -SID 'S-1-5-32-545' -ErrorAction SilentlyContinue).SID.Value -contains $sid)) {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $LaneUser
}
New-NetFirewallRule -DisplayName "$RuleGroup outbound" -Group $RuleGroup -Direction Outbound -Action Block `
  -LocalUser "D:(A;;CC;;;$sid)" -Profile Any | Out-Null
"without-network: user $LaneUser ($sid), Users only; outbound blocked by rule group $RuleGroup"

# 4. Scratch directory.
$scratch = Join-Path (Split-Path -Qualifier $env:RUNNER_TEMP) 'hkn-lane'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
icacls $scratch /grant "*${sid}:(OI)(CI)M" | Out-Null
foreach ($d in 'home', 'temp', 'appdata', 'localappdata', 'codex') { New-Item -ItemType Directory -Force -Path (Join-Path $scratch $d) | Out-Null }

# 5. The allowlisted environment.
$system = @('ALLUSERSPROFILE', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'COMPUTERNAME', 'ComSpec',
  'DriverData', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PSModulePath', 'PUBLIC', 'SystemDrive',
  'SystemRoot', 'windir', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'RUNNER_TRACKING_ID')
$laneEnv = [ordered]@{}
$dropped = New-Object System.Collections.Generic.List[string]
foreach ($item in Get-ChildItem env:) {
  if ($item.Name -in $system -or $item.Name -match '^(HOOKNOSTIC_|HKN_)') { $laneEnv[$item.Name] = $item.Value } else { $dropped.Add($item.Name) }
}
$laneHome = Join-Path $scratch 'home'
$laneEnv['USERPROFILE'] = $laneHome
$laneEnv['HOME'] = $laneHome
$laneEnv['HOMEDRIVE'] = Split-Path -Qualifier $laneHome
$laneEnv['HOMEPATH'] = Split-Path -NoQualifier $laneHome
$laneEnv['APPDATA'] = Join-Path $scratch 'appdata'
$laneEnv['LOCALAPPDATA'] = Join-Path $scratch 'localappdata'
$laneEnv['TEMP'] = Join-Path $scratch 'temp'
$laneEnv['TMP'] = Join-Path $scratch 'temp'
$laneEnv['USERNAME'] = $LaneUser
# For harness paths that set no CODEX_HOME of their own (the Code Mode drives).
$laneEnv['CODEX_HOME'] = Join-Path $scratch 'codex'
$laneEnv['HOOKNOSTIC_PLAYBACK_NETWORK'] = 'none'
$sensitive = '^(ACTIONS_|GITHUB_TOKEN$|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$|INPUT_)'
"without-network: environment: $($laneEnv.Count) names passed, $($dropped.Count) kept out, of which: $((@($dropped | Where-Object { $_ -match $sensitive }) | Sort-Object) -join ', ')"
$laneJson = Join-Path $scratch 'lane.json'
[ordered]@{ env = $laneEnv; require = $names; sid = $sid; command = $Run.Trim(); cwd = (Get-Location).Path } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -Path $laneJson

# 6. Run as the user, streaming its output.
$cred = New-Object System.Management.Automation.PSCredential($LaneUser, $secure)
$node = (Get-Command node).Source
$lane = Join-Path $PSScriptRoot 'without-network-lane.mjs'
$out = Join-Path $env:RUNNER_TEMP "without-network-$PID.out"
$err = Join-Path $env:RUNNER_TEMP "without-network-$PID.err"
$start = @{
  FilePath = $node; ArgumentList = @("`"$lane`"", "`"$laneJson`""); Credential = $cred; WorkingDirectory = (Get-Location).Path
  NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $out; RedirectStandardError = $err
}
try { $p = Start-Process @start -UseNewEnvironment } catch { $p = Start-Process @start }
$null = $p.Handle # keeps ExitCode readable after the process ends
"without-network: started the lane as $LaneUser after $([int]$timer.Elapsed.TotalSeconds) s"
$pos = @{}
function Read-New([string]$path) {
  if (-not (Test-Path $path)) { return }
  if (-not $pos.ContainsKey($path)) { $pos[$path] = [long]0 }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $null = $fs.Seek($pos[$path], 'Begin')
    $text = (New-Object IO.StreamReader($fs)).ReadToEnd()
    $pos[$path] = $fs.Length
  } finally { $fs.Dispose() }
  if ($text) { [Console]::Out.Write($text) }
}
$timedOut = $false
while (-not $p.HasExited) {
  Read-New $out
  Read-New $err
  if ($TimeoutMinutes -gt 0 -and $timer.Elapsed.TotalMinutes -gt $TimeoutMinutes) { $timedOut = $true; break }
  Start-Sleep -Milliseconds 1000
}
if ($timedOut) {
  "without-network: the lane ran past $TimeoutMinutes minutes; stopping the user's processes"
  $null = Stop-LaneProcesses $sid
}
$p.WaitForExit()
Read-New $out
Read-New $err
$code = if ($timedOut) { 124 } else { $p.ExitCode }
"without-network: the lane exited $code after $([int]$timer.Elapsed.TotalSeconds) s"
exit $code
