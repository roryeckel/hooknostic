# What later admin steps trust, as a comparable record (prototype; see
# lane-setup.ps1). Run the staged copy, as the admin, before and after the
# lane:
#   C:\hkn-admin\lane-snapshot.ps1 -Workspace <dir> -NpmPrefix <dir> [-Since <utc time>]
# Returns an ordered table:
# - "hash ..." SHA-256 of the file-command files, the staged admin files, the
#   workspace's .git\config and scripts\*;
# - "list ..." the entry names of the workspace root, .git, scripts and
#   node_modules, of _actions, of the npm prefix and of node's toolcache
#   directory;
# - with -Since, "newer ..." the files under the npm prefix, node's toolcache
#   directory and the workspace (outside node_modules) whose creation or
#   write time is later. Write times can be set by a writer, so this is a
#   backstop to the hashes, not proof.
param([Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$NpmPrefix, [datetime]$Since)
$ErrorActionPreference = 'Stop'
$entries = [ordered]@{}
function Add-Hash([string]$label, [string]$path) {
  if (Test-Path -LiteralPath $path -PathType Leaf) { $entries["hash $label"] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
}
function Add-List([string]$label, [string]$path) {
  if (Test-Path -LiteralPath $path) { $entries["list $label"] = ((Get-ChildItem -LiteralPath $path -Force -Name | Sort-Object) -join '|') }
}
foreach ($f in @(Get-ChildItem "$env:RUNNER_TEMP\_runner_file_commands" -File -Force -ErrorAction SilentlyContinue)) { Add-Hash "file-command $($f.Name)" $f.FullName }
foreach ($f in @(Get-ChildItem $PSScriptRoot -File | Where-Object Name -Match '^(lane-.*\.(ps1|mjs)|state\.json|cred\.txt)$')) { Add-Hash "admin $($f.Name)" $f.FullName }
Add-Hash 'workspace .git\config' "$Workspace\.git\config"
foreach ($f in @(Get-ChildItem "$Workspace\scripts" -File)) { Add-Hash "workspace scripts\$($f.Name)" $f.FullName }
Add-List 'workspace' $Workspace
Add-List 'workspace .git' "$Workspace\.git"
Add-List 'workspace scripts' "$Workspace\scripts"
Add-List 'workspace node_modules' "$Workspace\node_modules"
Add-List '_actions' (Join-Path (Split-Path -Parent (Split-Path -Parent $Workspace)) '_actions')
Add-List 'npm prefix' $NpmPrefix
$nodeDir = Split-Path -Parent (Get-Command node).Source
Add-List 'node toolcache dir' $nodeDir
if ($PSBoundParameters.ContainsKey('Since')) {
  $since = $Since.ToUniversalTime()
  $isNewer = { param($f) $f.LastWriteTimeUtc -gt $since -or $f.CreationTimeUtc -gt $since }
  foreach ($root in @(@{ label = 'npm prefix'; path = $NpmPrefix }, @{ label = 'node toolcache dir'; path = $nodeDir })) {
    $newer = @(Get-ChildItem -LiteralPath $root.path -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { & $isNewer $_ } |
        ForEach-Object { $_.FullName.Substring($root.path.Length) })
    $entries["newer $($root.label)"] = ($newer | Sort-Object) -join '|'
  }
  $newer = @(Get-ChildItem -LiteralPath $Workspace -Force | Where-Object Name -NE 'node_modules' | ForEach-Object {
      if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue } else { $_ }
    } | Where-Object { & $isNewer $_ } | ForEach-Object { $_.FullName.Substring($Workspace.Length) })
  $entries['newer workspace outside node_modules'] = ($newer | Sort-Object) -join '|'
}
$entries
