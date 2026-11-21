# Windows Firewall trials for enforcing "no network" on a GitHub-hosted runner.
# Throwaway runners only; needs admin.
#   firewall-trial.ps1 inventory|a|b|c|restore -Dir <scratch dir>
# Trial (b) sets DefaultOutboundAction Block on every firewall profile, which
# is machine-wide and persistent. It refuses to run without the explicit
# -IDangerAcceptGlobalBlock switch, and prints the restore command.
# Each trial applies one mechanism, then runs probe.mjs (public IPv4, DNS,
# HTTPS, loopback round trip). `restore` puts back the recorded profile state
# and removes every rule and user the trials added. Prints names and states,
# never environment values or the trial user's password.
param(
  [Parameter(Mandatory)][ValidateSet('inventory', 'a', 'b', 'c', 'restore')][string]$Step,
  [Parameter(Mandatory)][string]$Dir,
  [switch]$IDangerAcceptGlobalBlock
)
$ErrorActionPreference = 'Stop'
# Before New-Item: a refusal writes nothing, not even the scratch directory.
if ($Step -eq 'b' -and -not $IDangerAcceptGlobalBlock) {
  [Console]::Error.WriteLine('firewall-trial: refusing trial (b) without -IDangerAcceptGlobalBlock')
  [Console]::Error.WriteLine('  Trial (b) sets DefaultOutboundAction Block on every Windows Firewall profile:')
  [Console]::Error.WriteLine('  machine-wide and persistent, not scoped to this process or the trial user.')
  [Console]::Error.WriteLine('  Run it only on a throwaway runner, then restore:')
  [Console]::Error.WriteLine("  pwsh -File `"$PSCommandPath`" -Step restore -Dir `"$Dir`"")
  exit 2
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$probe = Join-Path $PSScriptRoot 'probe.mjs'
$node = (Get-Command node).Source
function Save-State {
  if (-not (Test-Path "$Dir\profiles.json")) {
    Get-NetFirewallProfile | ForEach-Object {
      [ordered]@{ Name = $_.Name; Enabled = $_.Enabled.ToString(); DefaultOutboundAction = $_.DefaultOutboundAction.ToString(); DefaultInboundAction = $_.DefaultInboundAction.ToString() }
    } | ConvertTo-Json | Set-Content "$Dir\profiles.json"
  }
}
function Enable-Firewall { Save-State; Set-NetFirewallProfile -All -Enabled True }
function Invoke-Probe([string]$label) {
  $out = & $node $probe $label 2>&1 | Out-String
  "  $($out.Trim())"
}
function Get-RunnerImages {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^Runner\.(Listener|Worker)\.exe$' } |
    ForEach-Object { $_.ExecutablePath } | Sort-Object -Unique
}

switch ($Step) {
  'inventory' {
    "== firewall profiles"
    Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction, DefaultInboundAction | Format-Table | Out-String
    "== services: mpssvc $((Get-Service mpssvc).Status), bfe $((Get-Service bfe).Status), seclogon $((Get-Service seclogon).Status) ($((Get-Service seclogon).StartType))"
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    "== step user: $($me.Name), admin=$(([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
    "== runner processes"
    Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^Runner\.|^node\.exe$' } | ForEach-Object {
      $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
      "  $($_.Name) pid=$($_.ProcessId) ppid=$($_.ParentProcessId) user=$($owner.Domain)\$($owner.User) path=$($_.ExecutablePath)"
    }
    "== the runner's established connections (how it talks home)"
    $runnerPids = (Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^Runner\.(Listener|Worker)\.exe$' }).ProcessId
    $cache = @{}; Get-DnsClientCache -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Data) { $cache[[string]$_.Data] = $_.Entry } }
    Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $runnerPids } | ForEach-Object {
      $p = (Get-Process -Id $_.OwningProcess).ProcessName
      "  $p -> $($_.RemoteAddress):$($_.RemotePort) [$($cache[[string]$_.RemoteAddress])]"
    } | Sort-Object -Unique
    "== probe, no rules"
    Invoke-Probe 'inventory-open'
  }
  'a' {
    # (a) a block rule for one program: node.exe, the lanes' main image.
    Enable-Firewall
    New-NetFirewallRule -DisplayName 'hkn-trial-a' -Group 'hkn-trial' -Direction Outbound -Action Block -Program $node -Profile Any | Out-Null
    "== (a) outbound block for $node"
    Invoke-Probe 'trial-a-node-blocked'
    Remove-NetFirewallRule -DisplayName 'hkn-trial-a'
  }
  'b' {
    # (b) default outbound Block on every profile, with allow rules for the
    # runner's own images (and its bundled node under externals\).
    "== (b) restores the recorded profiles with: pwsh -File `"$PSCommandPath`" -Step restore -Dir `"$Dir`""
    Enable-Firewall
    $allow = @(Get-RunnerImages)
    $runnerDir = Split-Path -Parent (Split-Path -Parent ($allow | Select-Object -First 1))
    $allow += @(Get-ChildItem -Path (Join-Path $runnerDir 'externals') -Recurse -Filter node.exe -ErrorAction SilentlyContinue | ForEach-Object FullName)
    foreach ($image in $allow) {
      New-NetFirewallRule -DisplayName "hkn-trial-b-allow $([IO.Path]::GetFileName($image))" -Group 'hkn-trial' -Direction Outbound -Action Allow -Program $image -Profile Any | Out-Null
      "  allow: $image"
    }
    Set-NetFirewallProfile -All -DefaultOutboundAction Block
    "== (b) default outbound Block; left in place for the next steps"
    Invoke-Probe 'trial-b-default-block'
    "== (b) the block is still in place: every profile stays at DefaultOutboundAction Block until 'restore' runs"
  }
  'c' {
    # (c) block every outbound connection of one dedicated local user, by SID,
    # and run the probe as that user.
    Enable-Firewall
    $bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $plain = [Convert]::ToBase64String($bytes) + 'aA1!'
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    New-LocalUser -Name 'hkntrial' -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
    $sid = (Get-LocalUser -Name 'hkntrial').SID.Value
    "== (c) trial user SID $sid"
    try {
      New-NetFirewallRule -DisplayName 'hkn-trial-c' -Group 'hkn-trial' -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$sid)" -Profile Any | Out-Null
      "  rule created: outbound block for that SID"
    } catch { "  rule NOT created: $($_.Exception.Message)" }
    $work = Join-Path $Dir 'trial-c'; New-Item -ItemType Directory -Force -Path $work | Out-Null
    icacls $work /grant '*S-1-1-0:(OI)(CI)F' | Out-Null
    Copy-Item $probe "$work\probe.mjs"
    $cred = [pscredential]::new('hkntrial', $secure)
    "== run as the trial user: Start-Process -Credential"
    try {
      Start-Process -FilePath $node -ArgumentList "`"$work\probe.mjs`" trial-c-as-user" -Credential $cred -WorkingDirectory $work -Wait -NoNewWindow `
        -RedirectStandardOutput "$work\out.txt" -RedirectStandardError "$work\err.txt"
      "  $((Get-Content -Raw "$work\out.txt" -ErrorAction SilentlyContinue))".Trim()
      $err = Get-Content -Raw "$work\err.txt" -ErrorAction SilentlyContinue; if ($err) { "  stderr: $($err.Trim().Substring(0, [Math]::Min(300, $err.Trim().Length)))" }
    } catch { "  Start-Process failed: $($_.Exception.Message)" }
    "== run as the trial user: scheduled task"
    try {
      $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" `"$work\probe.mjs`" trial-c-task > `"$work\task.txt`" 2>&1`""
      Register-ScheduledTask -TaskName 'hkn-trial-c' -Action $action -User 'hkntrial' -Password $plain -RunLevel Limited -Force | Out-Null
      Start-ScheduledTask -TaskName 'hkn-trial-c'
      for ($i = 0; $i -lt 30 -and (Get-ScheduledTask -TaskName 'hkn-trial-c').State -ne 'Ready'; $i++) { Start-Sleep 1 }
      Start-Sleep 2
      "  $((Get-Content -Raw "$work\task.txt" -ErrorAction SilentlyContinue))".Trim()
      "  task result: $((Get-ScheduledTaskInfo -TaskName 'hkn-trial-c').LastTaskResult)"
    } catch { "  scheduled task failed: $($_.Exception.Message)" }
    "== the step's own user under the same rule (must stay online)"
    Invoke-Probe 'trial-c-step-user'
  }
  'restore' {
    Get-NetFirewallRule -Group 'hkn-trial' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Unregister-ScheduledTask -TaskName 'hkn-trial-c' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-LocalUser -Name 'hkntrial' -ErrorAction SilentlyContinue
    if (Test-Path "$Dir\profiles.json") {
      foreach ($p in (Get-Content -Raw "$Dir\profiles.json" | ConvertFrom-Json)) {
        Set-NetFirewallProfile -Name $p.Name -Enabled $p.Enabled -DefaultOutboundAction $p.DefaultOutboundAction -DefaultInboundAction $p.DefaultInboundAction
      }
    }
    "== restored"
    Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction | Format-Table | Out-String
    "  leftover trial rules: $(@(Get-NetFirewallRule -Group 'hkn-trial' -ErrorAction SilentlyContinue).Count)"
  }
}
