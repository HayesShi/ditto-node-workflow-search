param([switch]$Push)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$gitOptions=@()
$proxySettings=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
if($proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer) {
    $configuredProxy=$proxySettings.ProxyServer
    if($configuredProxy -match '(?:^|;)https=([^;]+)') { $configuredProxy=$Matches[1] }
    elseif($configuredProxy -match '(?:^|;)http=([^;]+)') { $configuredProxy=$Matches[1] }
    if($configuredProxy -notmatch '^[a-zA-Z]+://') { $configuredProxy='http://'+$configuredProxy }
    # Use the existing enabled system route for this Git invocation only.
    $gitOptions=@('-c',"http.proxy=$configuredProxy")
}
& git @gitOptions fetch origin main
if($LASTEXITCODE -ne 0) { throw 'Unable to check remote main.' }
if($Push) {
    if(& git status --porcelain) { throw 'Commit or review local changes before publishing.' }
    & git merge-base --is-ancestor origin/main HEAD
    if($LASTEXITCODE -ne 0) { throw 'Remote main has independent changes; merge and validate before publishing.' }
    & git @gitOptions push origin HEAD:main
    if($LASTEXITCODE -ne 0) { throw 'Push failed; local commit remains available.' }
}
& git log -1 --oneline origin/main
