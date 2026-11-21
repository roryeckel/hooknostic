# Start the Windows egress audit on a throwaway runner (needs admin).
# - Windows Filtering Platform connection auditing: Security events 5156
#   (allowed) and 5157 (blocked), with the process id, image and destination.
# - Process creation auditing with command lines: Security event 4688, so
#   each connection can be attributed through the process tree.
# - The DNS Client operational log, for hostnames.
# Subcategories by GUID, so a localized image does not matter.
$ErrorActionPreference = 'Stop'
$filteringPlatformConnection = '{0CCE9226-69AE-11D9-BED3-505054503030}'
$processCreation = '{0CCE922B-69AE-11D9-BED3-505054503030}'
auditpol /set /subcategory:$filteringPlatformConnection /success:enable /failure:enable | Out-Null
auditpol /set /subcategory:$processCreation /success:enable | Out-Null
reg add 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit' /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f | Out-Null
wevtutil sl Security /ms:2147483648
wevtutil cl Security
wevtutil sl Microsoft-Windows-DNS-Client/Operational /e:true /ms:268435456
wevtutil cl Microsoft-Windows-DNS-Client/Operational
auditpol /get /subcategory:"$filteringPlatformConnection,$processCreation"
