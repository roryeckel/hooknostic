# Summarize the Windows egress audit for one measured step.
#   export-audit.ps1 -Dir <dir with root.pid, start.txt, end.txt> -Label <name>
# Writes <Dir>\summary.json and <Dir>\outbound.csv.
# Attribution:
# - Each WFP connection event (5156/5157) is joined to the process that made
#   it (the latest 4688 for that pid before the event).
# - That process's chain of creators is walked.
# - It is "lane" when the measured step's own shell (root.pid) is an
#   ancestor.
# - Otherwise it is "runner" when it is the runner's own (Runner.Worker,
#   Runner.Listener, or the runner's bundled node under externals\), and
#   "system" otherwise (services, svchost, Defender, ...).
# Loopback is counted separately: lane loopback traffic shows the audit saw
# the lane's processes at all.
param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Label)
$ErrorActionPreference = 'Stop'
function Read-Utc($path) { [datetime]::Parse((Get-Content -Raw $path).Trim(), $null, [Globalization.DateTimeStyles]::RoundtripKind) }
$start = Read-Utc "$Dir\start.txt"
$end = Read-Utc "$Dir\end.txt"
$root = [int](Get-Content -Raw "$Dir\root.pid").Trim()
Start-Sleep -Seconds 5 # let the last events land
function Get-Data($event) {
  $h = @{}
  foreach ($d in ([xml]$event.ToXml()).Event.EventData.Data) { $h[$d.Name] = [string]$d.'#text' }
  $h
}

# Every process created since the audit started (the log was cleared then).
$procs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688 } -ErrorAction SilentlyContinue | ForEach-Object {
    $d = Get-Data $_
    [pscustomobject]@{
      pid = [Convert]::ToInt32($d.NewProcessId, 16)
      ppid = [Convert]::ToInt32($d.ProcessId, 16)
      name = $d.NewProcessName
      cmd = if ($d.CommandLine) { $d.CommandLine.Substring(0, [Math]::Min(300, $d.CommandLine.Length)) } else { '' }
      time = $_.TimeCreated.ToUniversalTime()
    }
  } | Sort-Object time)
$byPid = @{}
foreach ($p in $procs) { if (-not $byPid.ContainsKey($p.pid)) { $byPid[$p.pid] = [Collections.Generic.List[object]]::new() }; $byPid[$p.pid].Add($p) }
function Find-Proc([int]$procId, [datetime]$at) {
  if (-not $byPid.ContainsKey($procId)) { return $null }
  $hit = $null
  foreach ($p in $byPid[$procId]) { if ($p.time -le $at) { $hit = $p } }
  $hit
}
$rootProc = Find-Proc $root $start
function Get-Chain($proc) {
  $chain = @(); $cur = $proc
  for ($i = 0; $cur -and $i -lt 40; $i++) { $chain += $cur; $cur = Find-Proc $cur.ppid $cur.time }
  $chain
}
function Get-Class($proc, [string]$app) {
  if ($proc) {
    $chain = Get-Chain $proc
    if ($rootProc -and ($chain | Where-Object { $_.pid -eq $rootProc.pid -and $_.time -eq $rootProc.time })) { return 'lane' }
  }
  if ($app -match 'Runner\.(Worker|Listener)\.exe$|\\actions-runner\\|\\externals\\') { return 'runner' }
  if ($proc -and (Get-Chain $proc | Where-Object { $_.name -match 'Runner\.(Worker|Listener)\.exe$' })) { return 'runner' }
  'system'
}

# DNS answers: address -> names.
$names = @{}; $queries = @{}
Get-WinEvent -LogName 'Microsoft-Windows-DNS-Client/Operational' -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 3006, 3008, 3020 -and $_.TimeCreated.ToUniversalTime() -ge $start.AddSeconds(-5) -and $_.TimeCreated.ToUniversalTime() -le $end.AddSeconds(30) } |
  ForEach-Object {
    $d = Get-Data $_
    $q = $d.QueryName
    if (-not $q) { return }
    if (-not $queries.ContainsKey($q)) { $queries[$q] = [ordered]@{ name = $q; events = 0; results = [Collections.Generic.HashSet[string]]::new(); pids = [Collections.Generic.HashSet[string]]::new() } }
    $queries[$q].events++
    # Which process the DNS Client log names: the caller, or the Dnscache service.
    $execPid = [int]([xml]$_.ToXml()).Event.System.Execution.ProcessID
    $execProc = Find-Proc $execPid $_.TimeCreated.ToUniversalTime()
    [void]$queries[$q].pids.Add("${execPid}:$(if ($execProc) { "$(Split-Path -Leaf $execProc.name)/$(Get-Class $execProc $execProc.name)" } else { 'not-created-in-window' })")
    foreach ($m in [regex]::Matches([string]$d.QueryResults, '(?<![\w:.])(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7})(?![\w:.])')) {
      $ip = $m.Value -replace '^::ffff:', ''
      [void]$queries[$q].results.Add($ip)
      if (-not $names.ContainsKey($ip)) { $names[$ip] = [Collections.Generic.HashSet[string]]::new() }
      [void]$names[$ip].Add($q)
    }
  }

$isLoopback = { param($a) $a -match '^(127\.|::1$|0:0:0:0:0:0:0:1$)' }
$rows = [Collections.Generic.List[object]]::new()
$loop = @{}
$windowEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5156, 5157; StartTime = $start.ToLocalTime(); EndTime = $end.AddSeconds(5).ToLocalTime() } -ErrorAction SilentlyContinue)
foreach ($e in $windowEvents) {
  $d = Get-Data $e
  if ($d.Direction -notmatch '14593') { continue } # outbound only
  $at = $e.TimeCreated.ToUniversalTime()
  $proc = Find-Proc ([int]$d.ProcessID) $at
  $app = $d.Application
  $class = Get-Class $proc $app
  $leaf = Split-Path -Leaf $app
  if (& $isLoopback $d.DestAddress) {
    $key = "$class|$leaf"; $loop[$key] = 1 + [int]$loop[$key]; continue
  }
  $rows.Add([pscustomobject]@{
      class = $class; app = $leaf; path = $app; pid = [int]$d.ProcessID; dest = $d.DestAddress; port = $d.DestPort
      proto = $(if ($d.Protocol -eq '6') { 'tcp' } elseif ($d.Protocol -eq '17') { 'udp' } else { $d.Protocol }); allowed = ($e.Id -eq 5156); time = $at.ToString('o')
      names = if ($names.ContainsKey($d.DestAddress)) { ($names[$d.DestAddress] | Sort-Object) -join ',' } else { '' }
      cmd = if ($proc) { $proc.cmd } else { '' }
      chain = if ($proc) { ((Get-Chain $proc | Select-Object -First 6 | ForEach-Object { Split-Path -Leaf $_.name }) -join ' < ') } else { '' }
    })
}
$rows | Export-Csv -NoTypeInformation -Path "$Dir\outbound.csv"
$groups = $rows | Group-Object class, app, dest, port, proto | ForEach-Object {
  $f = $_.Group[0]
  [ordered]@{
    class = $f.class; app = $f.app; dest = $f.dest; port = $f.port; proto = $f.proto; names = $f.names
    count = $_.Count; allowed = @($_.Group | Where-Object allowed).Count
    first = ($_.Group | Sort-Object time | Select-Object -First 1).time
    exampleCmd = $f.cmd; chain = $f.chain
  }
} | Sort-Object { $_['class'] }, { $_['first'] }
$laneProcs = @($procs | Where-Object { $_.time -ge $start.AddSeconds(-2) } | Where-Object { (Get-Class $_ $_.name) -eq 'lane' })
$summary = [ordered]@{
  label = $Label
  window = [ordered]@{ start = $start.ToString('o'); end = $end.ToString('o') }
  rootFound = [bool]$rootProc
  connectionEvents = $windowEvents.Count
  laneProcesses = $laneProcs.Count
  laneImages = @($laneProcs | Group-Object { Split-Path -Leaf $_.name } | Sort-Object Count -Descending | ForEach-Object { "$($_.Name) x$($_.Count)" })
  loopbackOutbound = $loop
  destinations = @($groups)
  dns = @($queries.Values | ForEach-Object { [ordered]@{ name = $_.name; events = $_.events; results = @($_.results); loggedBy = @($_.pids) } } | Sort-Object { $_['name'] })
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "$Dir\summary.json"
"$Label : $($windowEvents.Count) connection events; lane processes $($laneProcs.Count); non-loopback outbound by class:"
$rows | Group-Object class | ForEach-Object { "  $($_.Name): $($_.Count)" }
"lane destinations:"
$groups | Where-Object { $_['class'] -eq 'lane' } | ForEach-Object { "  $($_['app']) -> $($_['dest']):$($_['port'])/$($_['proto']) [$($_['names'])] x$($_['count'])" }
