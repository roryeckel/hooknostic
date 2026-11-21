# Prototype of the Windows lane isolation, for measurement on a throwaway
# GitHub-hosted runner only: it needs admin, and it creates a local user and a
# firewall rule. It is not the implementation; it measures what the plan
# (Windows review response) relies on.
#   lane-setup.ps1 [-Integrity Medium|Low]
# In order:
# - Stages the admin-side scripts into an admin-only directory (Administrators
#   and SYSTEM only), before the lane user exists. The admin only ever runs
#   those copies, never the checkout's.
# - Turns on WFP connection and process-creation auditing, and fails unless
#   auditpol reports both as set.
# - Creates the standard user hknoffline (a random password, kept only as a
#   DPAPI blob in the admin directory), and an outbound block rule for its SID.
# - Creates the lane's scratch tree: Administrators and SYSTEM full control,
#   the lane user Modify, nobody else, no inheritance from the drive root.
#   With -Integrity Low the tree is labelled Low and the lane starts from a
#   copy of node.exe labelled Low, so every lane process runs at Low
#   integrity and cannot write any object that lacks a Low label.
# Prints names, SIDs and timings, never environment values or the password.
param([ValidateSet('Medium', 'Low')][string]$Integrity = 'Medium', [switch]$LabelProfile, [string]$Admin = 'C:\hkn-admin', [string]$Scratch = 'D:\hkn-lane')
$ErrorActionPreference = 'Stop'
$timer = [Diagnostics.Stopwatch]::StartNew()
$started = (Get-Date).ToUniversalTime()
function Mark([string]$what) { "lane-setup: {0,6:n1}s {1}" -f $timer.Elapsed.TotalSeconds, $what }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'lane-setup: needs an elevated administrator' }
if ((Get-Service mpssvc).Status -ne 'Running') { throw 'lane-setup: the firewall service is not running' }
$off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
if ($off.Count) { throw "lane-setup: firewall profile(s) not enabled: $($off.Name -join ', ')" }

# 1. Admin-only staging.
New-Item -ItemType Directory -Force -Path $Admin | Out-Null
icacls $Admin /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
foreach ($f in 'lane-run.ps1', 'lane-after.ps1', 'lane-inner.mjs', 'lane-snapshot.ps1') { Copy-Item -Force (Join-Path $PSScriptRoot $f) $Admin }
Mark "staged admin scripts; ACL: $((icacls $Admin | Select-Object -Skip 1 | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }) -join ' | ')"

# 2. Auditing, checked.
$wfp = '{0CCE9226-69AE-11D9-BED3-505054503030}'
$proc = '{0CCE922B-69AE-11D9-BED3-505054503030}'
auditpol /set /subcategory:$wfp /success:enable /failure:enable | Out-Null
auditpol /set /subcategory:$proc /success:enable | Out-Null
# Filtering Platform Packet Drop (5152): where a block may be logged instead of 5157.
auditpol /set /subcategory:'{0CCE9225-69AE-11D9-BED3-505054503030}' /failure:enable | Out-Null
reg add 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit' /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f | Out-Null
wevtutil sl Security /ms:2147483648
$set = auditpol /get /subcategory:$wfp /r | ConvertFrom-Csv
if ($set.'Inclusion Setting' -ne 'Success and Failure') { throw "lane-setup: WFP auditing is '$($set.'Inclusion Setting')'" }
Mark "auditing on: Filtering Platform Connection = $($set.'Inclusion Setting')"

# 3. The user and its rule.
$bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secure = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + 'aA1!') -AsPlainText -Force
New-LocalUser -Name hknoffline -Password $secure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null
$sid = (Get-LocalUser -Name hknoffline).SID.Value
$secure | ConvertFrom-SecureString | Set-Content "$Admin\cred.txt"
$groups = @(Get-LocalGroup | Where-Object { (Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue).SID.Value -contains $sid } | ForEach-Object Name)
if ($groups -notcontains 'Users') { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member hknoffline; $groups += 'Users (added)' }
Mark "user hknoffline $sid; groups: $($groups -join ', ')"
New-NetFirewallRule -DisplayName 'hkn-offline' -Group 'hkn-offline' -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$sid)" -Profile Any | Out-Null
Mark 'outbound block rule for the SID'

# 4. Scratch tree, the only place the lane may write.
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
icacls $Scratch /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*${sid}:(OI)(CI)M" | Out-Null
if ($Integrity -eq 'Low') { icacls $Scratch /setintegritylevel '(OI)(CI)low' | Out-Null }
foreach ($d in 'home', 'temp', 'appdata', 'localappdata', 'work', 'bin') { New-Item -ItemType Directory -Force -Path (Join-Path $Scratch $d) | Out-Null }
$laneNode = (Get-Command node).Source
if ($Integrity -eq 'Low') {
  Copy-Item $laneNode "$Scratch\bin\node.exe"
  icacls "$Scratch\bin\node.exe" /setintegritylevel low | Out-Null
  $laneNode = "$Scratch\bin\node.exe"
}
Copy-Item -Force (Join-Path $PSScriptRoot 'lane-inner.mjs') "$Scratch\bin\lane-inner.mjs"
if ($Integrity -eq 'Low' -and $LabelProfile) {
  # Some harnesses find their home through the known-folder API, which ignores
  # USERPROFILE and names the real profile. Create it with one logon, then
  # label it Low, so a Low lane can write there too.
  $cred = [pscredential]::new('hknoffline', $secure)
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d /c exit 0' -Credential $cred -LoadUserProfile -Wait -NoNewWindow -WorkingDirectory $Scratch
  $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object SID -EQ $sid).LocalPath
  if ($profilePath) {
    $out = icacls $profilePath /setintegritylevel '(OI)(CI)low' /T /C /Q 2>&1 | Select-Object -Last 1
    Mark "lane profile created and labelled Low ($($profilePath -replace '\\[^\\]+$', '\<user>')): $out"
  } else { Mark 'lane profile: none created' }
}
Mark "scratch tree ($Integrity); label: $((icacls $Scratch | Select-String 'Mandatory Label') -replace '^\s+', '')"

[ordered]@{ sid = $sid; user = 'hknoffline'; integrity = $Integrity; scratch = $Scratch; laneNode = $laneNode; started = $started.ToString('o') } |
  ConvertTo-Json | Set-Content "$Admin\state.json"
Mark 'done'
