# Run a command with no IP network but loopback, as a dedicated standard user.
# Windows only, and GitHub-hosted runners only: it creates a local user and a
# firewall rule. scripts/without-network.sh is the Linux twin.
#
#   pwsh scripts/without-network.ps1 -StepTimeoutMinutes N -RequireEnv A,B -Run '<command line>'
#   pwsh scripts/without-network.ps1 -Cleanup
#   pwsh scripts/without-network.ps1 -DryRun -StepTimeoutMinutes N -RequireEnv A,B -Run '<command line>'
# The command line runs through cmd.exe, so .cmd shims such as pnpm work.
#
# -StepTimeoutMinutes is the calling step's own timeout-minutes. The wrapper
# stops the lane itself $StopReserveSeconds before that budget runs out,
# counted from its own start, so its message, its stop by owner SID and exit
# 124 happen before the runner kills the step.
#
# The goal is that accidental egress fails loudly: a lane that needs a
# download, or a harness that calls home. A deliberate escape is out of
# scope (docs/testing.md, "Network isolation on Windows").
#
# A run:
# 1. Checks its arguments: a non-empty -RequireEnv of variable names, a
#    command line, and a step budget long enough to keep the reserve.
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
# Once steps 3 to 6 start, they run under a finally that stops every process
# owned by the user (and checks that none is left), removes the rule group and
# disables the user. It prints what remains, and its own failures are warnings:
# it never hides the lane's error. -Cleanup is the workflow's always() step,
# the backstop for a runner kill, which runs no managed finally. It needs no
# precondition, is safe after a refusal, writes nothing, and exits 1 unless no
# process and no rule remains.
[CmdletBinding()]
param(
  [string]$RequireEnv = '',
  [switch]$Cleanup,
  [switch]$DryRun,
  [int]$StepTimeoutMinutes = 0,
  [string]$Run = ''
)
# From the wrapper's first line, so the limit counts its own setup too.
$timer = [Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference = 'Stop'
$LaneUser = 'hknoffline'
$RuleGroup = 'hkn-offline'
# Time kept back from the step's budget: Stop-LaneProcesses' bounded recheck,
# a bounded wait for the lane, and the last reads of its output.
$StopReserveSeconds = 60

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
    # Not Start-Sleep: a .NET call is not a pipeline stop point, so a Ctrl+C
    # during a lane is less likely to skip the wait (and the finally after it).
    [Threading.Thread]::Sleep(1000)
  }
  $left
}

# Stops every process the lane user owns, disables the user, and removes the
# rule group. Reports what remains and returns $false if any process or rule
# does. Runs in a finally, so a failing step prints a warning and never
# replaces the lane's own error.
function Invoke-LaneCleanup {
  $clean = $true
  $left = 0
  $rules = 0
  try {
    $user = Get-LocalUser -Name $LaneUser -ErrorAction SilentlyContinue
    if ($user) {
      $left = Stop-LaneProcesses $user.SID.Value
      [Console]::Out.WriteLine("without-network: lane processes left after stopping: $left")
      Disable-LocalUser -Name $LaneUser -ErrorAction Stop | Out-Null
    } else {
      [Console]::Out.WriteLine('without-network: no lane user, so no lane processes')
    }
  } catch {
    $clean = $false
    Write-Warning "without-network: could not stop the lane processes or disable ${LaneUser}: $($_.Exception.Message)"
  }
  try {
    $existing = @(Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue)
    # Out-Null: the cmdlet's CIM objects must not join the helper's return value.
    if ($existing.Count) { $existing | Remove-NetFirewallRule -ErrorAction Stop | Out-Null }
    $rules = @(Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue).Count
    [Console]::Out.WriteLine("without-network: firewall rules removed: $($existing.Count); left: $rules")
  } catch {
    $clean = $false
    Write-Warning "without-network: could not remove the ${RuleGroup} firewall rules: $($_.Exception.Message)"
  }
  return ($clean -and $left -eq 0 -and $rules -eq 0)
}

# Prints what was appended to a lane output file since the last call.
# $state holds, per file, the offset reached and one UTF-8 decoder, so a
# multi-byte character split across two reads decodes whole. The offset is
# where the reads stopped, never the file's length afterwards: bytes the
# lane appends meanwhile are read on the next call, not skipped.
function Read-New([string]$path, [hashtable]$state) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if (-not $state.ContainsKey($path)) {
    $state[$path] = @{ pos = [long]0; decoder = (New-Object Text.UTF8Encoding($false)).GetDecoder() }
  }
  $file = $state[$path]
  $buffer = New-Object byte[] 65536
  $chars = New-Object char[] ($buffer.Length + 8)
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $null = $fs.Seek($file.pos, 'Begin')
    while (($n = $fs.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $count = $file.decoder.GetChars($buffer, 0, $n, $chars, 0)
      if ($count) { [Console]::Out.Write([string]::new($chars, 0, $count)) }
    }
    $file.pos = $fs.Position
  } finally { $fs.Dispose() }
}

# Streams the lane's output files until it exits. Past $LimitSeconds on
# $Timer it says so, runs $Stop, waits a bounded time, and returns 124;
# otherwise it returns the lane's exit code.
function Watch-Lane($Process, [string[]]$Paths, [double]$LimitSeconds, [Diagnostics.Stopwatch]$Timer, [scriptblock]$Stop, [int]$PollMilliseconds = 1000) {
  $state = @{}
  $timedOut = $false
  while (-not $Process.HasExited) {
    foreach ($path in $Paths) { Read-New $path $state }
    if ($Timer.Elapsed.TotalSeconds -gt $LimitSeconds) { $timedOut = $true; break }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  if ($timedOut) {
    [Console]::Out.WriteLine("without-network: the lane ran past its limit of $([int]$LimitSeconds) s; stopping the user's processes")
    $null = & $Stop
    $null = $Process.WaitForExit(15000)
  } else {
    $Process.WaitForExit()
  }
  foreach ($path in $Paths) { Read-New $path $state }
  if ($timedOut) { return 124 }
  return $Process.ExitCode
}

if ($Cleanup) {
  # Fail closed: a process or a rule still there is not a clean runner, and
  # the next job on it may inherit either.
  if (Invoke-LaneCleanup) { exit 0 }
  exit 1
}

# 1. Arguments.
$names = @($RequireEnv -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($names.Count -eq 0) { Stop-Refusing 'no required variables: pass -RequireEnv A,B (an empty list checks nothing)' }
$bad = @($names | Where-Object { $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' })
if ($bad.Count) { Stop-Refusing "not a variable name: $($bad -join ', ')" }
if (-not $Run.Trim()) { Stop-Refusing "no command: pass -Run '<command line>'" }
if ($StepTimeoutMinutes * 60 -le 2 * $StopReserveSeconds) {
  Stop-Refusing "no room to stop the lane: pass -StepTimeoutMinutes, the step's timeout-minutes, above $(2 * $StopReserveSeconds / 60) (got $StepTimeoutMinutes)"
}
$limitSeconds = $StepTimeoutMinutes * 60 - $StopReserveSeconds

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
  "without-network: dry run: would run $(($Run.Trim() -split '\s+')[0]) as $LaneUser, requiring $($names -join ', '); stopping it $limitSeconds s after the wrapper starts (the step's $StepTimeoutMinutes minutes less $StopReserveSeconds s)"
  exit 0
}

# Steps 3 to 6 run under one finally: whatever ends the lane (its own exit, a
# thrown error, or a hand cancellation), the user's processes, the user and
# the rule group do not outlive it. The workflow's always() -Cleanup step stays
# as the backstop: a runner kill runs no managed finally.
$code = 0
try {
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
  try {
    $p = Start-Process @start -UseNewEnvironment
    'without-network: started the lane script with a fresh environment (-UseNewEnvironment)'
  } catch {
    # The lane script then has the runner's environment; it hands its own
    # children (the check and the command) only lane.json's allowlist.
    "without-network: Start-Process -UseNewEnvironment failed ($($_.Exception.GetType().Name)); started the lane script without it, so only its children get the allowlisted environment"
    $p = Start-Process @start
  }
  $null = $p.Handle # keeps ExitCode readable after the process ends
  "without-network: started the lane as $LaneUser after $([int]$timer.Elapsed.TotalSeconds) s; it is stopped after $limitSeconds s"
  $code = Watch-Lane -Process $p -Paths $out, $err -LimitSeconds $limitSeconds -Timer $timer -Stop { Stop-LaneProcesses $sid }
} finally {
  $clean = $null
  try {
    $clean = Invoke-LaneCleanup
  } catch {
    $clean = $false
    Write-Warning "without-network: cleanup failed: $($_.Exception.Message)"
  }
  if (-not $clean) {
    Write-Warning 'without-network: cleanup left lane processes or firewall rules behind; the workflow''s always() step retries it'
  }
}
"without-network: the lane exited $code after $([int]$timer.Elapsed.TotalSeconds) s"
exit $code
