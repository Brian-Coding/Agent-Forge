param([switch]$NoBrowser, [switch]$NoPauseOnError)
$ErrorActionPreference = 'Stop'
$forgeRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $forgeRoot
$Host.UI.RawUI.WindowTitle = 'Agent Forge'
$forgeLockPath = Join-Path $forgeRoot 'agent-forge.lock'
$forgeServer = $null
$launchError = $null
$launchedToken = $null
$logStreams = @()
$logCopies = @()

function Get-VerifiedForge {
    # CIM may briefly return a dying process with no command line. Re-read the
    # lock and process together before deciding; missing metadata is never proof
    # that a still-running process is ours to terminate.
    for ($identityAttempt = 0; $identityAttempt -lt 5; $identityAttempt++) {
        if (-not (Test-Path -LiteralPath $forgeLockPath)) { return $null }
        try { $owner = Get-Content -LiteralPath $forgeLockPath -Raw | ConvertFrom-Json }
        catch [System.Management.Automation.ItemNotFoundException] { return $null }
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$owner.pid)"
        if (-not $candidate) { return $null }
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate.CommandLine) -and $candidate.CreationDate) { break }
        if ($identityAttempt -eq 4) { throw 'Previous Forge process metadata is unavailable. Refusing to kill an unverified process.' }
        Start-Sleep -Milliseconds 100
    }
    $age = ([DateTimeOffset]::Parse($owner.startedAt) - [DateTimeOffset]$candidate.CreationDate).TotalSeconds
    $entry = Join-Path $forgeRoot 'src\server\index.ts'
    $commandMatches = $candidate.CommandLine.Contains($entry) -or $candidate.CommandLine.Contains($entry.Replace('\','/')) -or ($candidate.CommandLine -match '(?:^|\s)src[/\\]server[/\\]index\.ts(?:\s|$)')
    if ($candidate.Name -ne 'bun.exe' -or $age -lt 0 -or $age -gt 15 -or -not $commandMatches -or $owner.token -notmatch '^[a-f0-9-]{36}$') {
        throw 'The lock belongs to an unverified process. Refusing to kill it.'
    }
    return [pscustomobject]@{ Process=$candidate; Token=$owner.token }
}

function Stop-VerifiedForge($verified) {
    if (-not $verified) { return }
    Write-Host "Stopping previous Agent Forge PID $($verified.Process.ProcessId)..."
    [IO.File]::WriteAllText("$forgeLockPath.stop-$($verified.Token)", 'restart')
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $current = Get-VerifiedForge
        if (-not $current) { return }
        if ($current.Token -ne $verified.Token -or $current.Process.CreationDate -ne $verified.Process.CreationDate) { throw 'Server identity changed during restart; refusing to stop it.' }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    # Legacy servers do not understand the graceful request. Revalidate just
    # before force-stopping only the recorded server and its descendants.
    $current = Get-VerifiedForge
    if (-not $current) { return }
    if ($current.Token -ne $verified.Token -or $current.Process.CreationDate -ne $verified.Process.CreationDate) { throw 'Server identity changed before force-stop.' }
    Write-Warning 'Graceful shutdown timed out; stopping the verified Forge process tree.'
    & "$env:SystemRoot\System32\taskkill.exe" /PID $current.Process.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the previous server.' }
}

# Serialize restart/startup but release once ready, so a later double-click
# can restart this instance. Do not hold the mutex for the server lifetime.
$rootHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($forgeRoot.ToLowerInvariant()))).Replace('-','')
$restartMutex = [Threading.Mutex]::new($false, "Local\AgentForgeRestart-$rootHash")
$ownsMutex = $false
try {
    try { $ownsMutex = $restartMutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another Forge launch is still in progress.' }
    $bunPath = (Get-Command bun -ErrorAction Stop).Source
    $chromePaths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
    $chromePath = $chromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $NoBrowser) {
        if (-not $chromePath) { throw 'Google Chrome is not installed.' }
        $chromeState = Get-Content -LiteralPath "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State" -Raw | ConvertFrom-Json
        $profile = $chromeState.profile.info_cache.psobject.Properties | Where-Object { $_.Value.name -eq 'First' }
        if (@($profile).Count -ne 1) { throw 'Expected exactly one Chrome profile named First.' }
        $profileDirectory = $profile.Name
    }
    Stop-VerifiedForge (Get-VerifiedForge)
    $runDirectory = Join-Path ([IO.Path]::GetTempPath()) ('AgentForge-launch-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $stdoutPath = Join-Path $runDirectory 'stdout.log'
    $stderrPath = Join-Path $runDirectory 'stderr.log'
    # Own the process handle from creation. Start-Process -PassThru can lose
    # access to exit status on Windows and return a null ExitCode.
    $forgeServer = New-Object System.Diagnostics.Process
    $forgeServer.StartInfo.FileName = $bunPath
    $forgeServer.StartInfo.Arguments = '"' + (Join-Path $forgeRoot 'src\server\index.ts') + '"'
    $forgeServer.StartInfo.WorkingDirectory = $forgeRoot
    $forgeServer.StartInfo.UseShellExecute = $false
    $forgeServer.StartInfo.RedirectStandardOutput = $true
    $forgeServer.StartInfo.RedirectStandardError = $true
    $forgeServer.StartInfo.EnvironmentVariables['AGENT_FORGE_LAUNCHER_PID'] = [string]$PID
    if (-not $forgeServer.Start()) { throw 'Could not create the Forge server process.' }
    $null = $forgeServer.Handle
    foreach ($logPath in @($stdoutPath,$stderrPath)) {
        $logStreams += [IO.FileStream]::new($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1, $true)
    }
    $logCopies += $forgeServer.StandardOutput.BaseStream.CopyToAsync($logStreams[0])
    $logCopies += $forgeServer.StandardError.BaseStream.CopyToAsync($logStreams[1])
    $deadline = (Get-Date).AddSeconds(60)
    $opened = $false
    $counts = @{ $stdoutPath=0; $stderrPath=0 }
    Write-Host 'Starting Agent Forge. Ctrl+C or close this terminal to stop it.'
    while (-not $forgeServer.HasExited) {
        foreach ($logPath in @($stdoutPath,$stderrPath)) {
            $lines = @(Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue)
            for ($i = $counts[$logPath]; $i -lt $lines.Count; $i++) {
                Write-Host $lines[$i]
                if (-not $opened -and $lines[$i] -match 'Server running at http://localhost:(\d+)') {
                    $url = "http://localhost:$($Matches[1])"
                    $listener = Get-NetTCPConnection -State Listen -LocalPort ([int]$Matches[1]) -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $forgeServer.Id
                    if (-not $listener) { throw 'The ready port is not owned by the launched Forge server.' }
                    $readyOwner = Get-VerifiedForge
                    if (-not $readyOwner -or $readyOwner.Process.ProcessId -ne $forgeServer.Id) { throw 'The ready server does not own the Forge lock.' }
                    $launchedToken = $readyOwner.Token
                    if (-not $NoBrowser) { Start-Process -FilePath $chromePath -ArgumentList @('--new-window', ('--profile-directory="' + $profileDirectory + '"'), $url) }
                    $opened = $true
                    Write-Host "Agent Forge ready at $url. Keep this terminal open."
                    $restartMutex.ReleaseMutex(); $ownsMutex = $false
                }
            }
            $counts[$logPath] = $lines.Count
        }
        if (-not $opened -and (Get-Date) -gt $deadline) { throw 'Forge did not become ready within 60 seconds.' }
        Start-Sleep -Milliseconds 250
        $forgeServer.Refresh()
    }
    $forgeServer.WaitForExit()
    foreach ($copy in $logCopies) { $copy.GetAwaiter().GetResult() }
    $restartRequested = $launchedToken -and (Test-Path -LiteralPath "$forgeLockPath.stop-$launchedToken")
    if (-not $opened -or ($forgeServer.ExitCode -ne 0 -and -not $restartRequested)) { throw "Forge exited with code $($forgeServer.ExitCode). Logs: $runDirectory" }
    Write-Host "Agent Forge stopped (exit code $($forgeServer.ExitCode))."
} catch {
    $launchError = $_.Exception.Message
} finally {
    if ($forgeServer -and -not $forgeServer.HasExited) {
        $own = Get-VerifiedForge
        if ($own -and $own.Process.ProcessId -eq $forgeServer.Id) { Stop-VerifiedForge $own }
    }
    if ($ownsMutex) { $restartMutex.ReleaseMutex() }
    $restartMutex.Dispose()
    foreach ($stream in $logStreams) { $stream.Dispose() }
}
if ($launchError) {
    Write-Host "Agent Forge launch failed: $launchError" -ForegroundColor Red
    if (-not $NoPauseOnError) { Read-Host 'Press Enter to close' }
    exit 1
}
