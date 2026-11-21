# After a lane run (prototype; see lane-setup.ps1). Run the staged copy from
# the admin directory. Deletes nothing: the scratch tree, the user profile
# and the rule stay on the single-use runner.
#   C:\hkn-admin\lane-after.ps1 -Label <name> [-KillOnly]
# 1. Finds every process whose owner SID is the lane user's (CIM, not
#    taskkill's name filter, whose matches are only reported) and stops them;
#    fails unless none is left.
# 2. Unless -KillOnly: disables the user; checks WFP auditing is still set;
#    then joins the Security log since setup:
#      - 4688 process creations whose new process runs as the lane SID;
#      - 5156/5157 outbound events of those processes.
#    Fails closed: unless the lane's own blocked connections (at least the
#    canary's three IPv4 probes) are there, the audit is not live, and "no
#    allowed connection" means nothing. Fails on any allowed non-loopback
#    connection by a lane process. Writes <Label>-after.json here.
param([Parameter(Mandatory)][string]$Label, [switch]$KillOnly)
$ErrorActionPreference = 'Stop'
$Admin = $PSScriptRoot
$state = Get-Content -Raw "$Admin\state.json" | ConvertFrom-Json
$timer = [Diagnostics.Stopwatch]::StartNew()
$problems = [Collections.Generic.List[string]]::new()

function Get-LaneProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
      try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $state.sid } catch { $false }
    })
}
$alive = Get-LaneProcesses
$byName = @($alive | Group-Object Name | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
"lane-after ${Label}: lane processes alive: $($alive.Count)$(if ($byName) { " ($byName)" })"
$bare = @(tasklist /FI "USERNAME eq $($state.user)" /FO CSV /NH 2>$null | Where-Object { $_ -like '"*' }).Count
$qualified = @(tasklist /FI "USERNAME eq $([Environment]::MachineName)\$($state.user)" /FO CSV /NH 2>$null | Where-Object { $_ -like '"*' }).Count
"lane-after ${Label}: tasklist USERNAME filter matches: bare name $bare, COMPUTER\name $qualified"
foreach ($p in $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$left = Get-LaneProcesses
"lane-after ${Label}: lane processes after stopping: $($left.Count)"
if ($left.Count) { $problems.Add("$($left.Count) lane processes survive") }
if ($KillOnly) { if ($problems.Count) { exit 1 } else { exit 0 } }

Disable-LocalUser -Name $state.user
$set = (auditpol /get /subcategory:'{0CCE9226-69AE-11D9-BED3-505054503030}' /r | ConvertFrom-Csv).'Inclusion Setting'
"lane-after ${Label}: WFP auditing: $set"
if ($set -ne 'Success and Failure') { $problems.Add("WFP auditing is '$set'") }

$since = [datetime]::Parse($state.started, $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
Start-Sleep -Seconds 3 # let the last events land
function Get-Data($event) { $h = @{}; foreach ($d in ([xml]$event.ToXml()).Event.EventData.Data) { $h[$d.Name] = [string]$d.'#text' }; $h }
$lanePids = @{}
$creations = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688; StartTime = $since } -ErrorAction SilentlyContinue)
foreach ($e in $creations) {
  $d = Get-Data $e
  # The first lane process is created by seclogon (Subject SYSTEM, Target the
  # lane); its descendants have the lane as Subject and Target S-1-0-0.
  if ($d.TargetUserSid -eq $state.sid -or $d.SubjectUserSid -eq $state.sid) {
    $lanePids[[Convert]::ToInt32($d.NewProcessId, 16)] = $e.TimeCreated
  }
}
"lane-after ${Label}: 4688 process creations since setup: $($creations.Count)"
$blocked = [Collections.Generic.List[object]]::new(); $allowed = [Collections.Generic.List[object]]::new(); $loop = 0; $all = 0
foreach ($e in @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5156, 5157; StartTime = $since } -ErrorAction SilentlyContinue)) {
  $all++
  $d = Get-Data $e
  if ($d.Direction -notmatch '14593') { continue }
  $procId = [int]$d.ProcessID
  if (-not $lanePids.ContainsKey($procId) -or $lanePids[$procId] -gt $e.TimeCreated) { continue }
  if ($d.DestAddress -match '^(127\.|::1$)') { if ($e.Id -eq 5156) { $loop++ }; continue }
  $row = [pscustomobject]@{ app = Split-Path -Leaf $d.Application; dest = "$($d.DestAddress):$($d.DestPort)" }
  if ($e.Id -eq 5157) { $blocked.Add($row) } else { $allowed.Add($row) }
}
"lane-after ${Label}: $all connection events since setup; lane processes created: $($lanePids.Count); lane loopback allowed: $loop"
"lane-after ${Label}: lane blocked (5157): $($blocked.Count)"
$blocked | Group-Object app, dest | Sort-Object Count -Descending | Select-Object -First 25 | ForEach-Object { "  blocked $($_.Name) x$($_.Count)" }
"lane-after ${Label}: lane ALLOWED non-loopback (5156): $($allowed.Count)"
$allowed | Group-Object app, dest | ForEach-Object { "  ALLOWED $($_.Name) x$($_.Count)" }
if ($blocked.Count -lt 3) { $problems.Add("audit not live: only $($blocked.Count) blocked lane connections (the canary alone makes 3)") }
if ($allowed.Count) { $problems.Add("$($allowed.Count) allowed lane connections") }
[ordered]@{
  label = $Label; seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1); laneProcessesCreated = $lanePids.Count; aliveBeforeKill = $alive.Count
  tasklistBare = $bare; tasklistQualified = $qualified; blocked = $blocked.Count; allowed = $allowed.Count; loopbackAllowed = $loop
  blockedByDest = @($blocked | Group-Object app, dest | ForEach-Object { "$($_.Name) x$($_.Count)" }); problems = $problems
} | ConvertTo-Json -Depth 4 | Set-Content "$Admin\$Label-after.json"
"lane-after ${Label}: $([math]::Round($timer.Elapsed.TotalSeconds, 1)) s; $(if ($problems.Count) { "PROBLEMS: $($problems -join '; ')" } else { 'clean' })"
if ($problems.Count) { exit 1 }
