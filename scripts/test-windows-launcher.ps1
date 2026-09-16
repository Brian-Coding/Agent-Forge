$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('AgentForge-launch-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts'),(Join-Path $testRoot 'src\server') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-agent-forge.ps1') -Destination (Join-Path $testRoot 'scripts\start-agent-forge.ps1')

# Exercise the shipped identity check against the transient CIM snapshot that
# appears during Windows shutdown. Mocks are confined to this invocation scope.
& {
    $forgeRoot = $testRoot
    $forgeLockPath = Join-Path $testRoot 'identity-case.lock'
    $created = (Get-Date).AddSeconds(-1)
    [IO.File]::WriteAllText($forgeLockPath, (@{ pid=43210; startedAt=[DateTimeOffset]::Now.ToString('o'); token=[guid]::NewGuid().ToString() } | ConvertTo-Json))
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $testRoot 'scripts\start-agent-forge.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'Launcher syntax failed before identity regression checks.' }
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-VerifiedForge' }, $true)
    if (-not $definition) { throw 'Could not locate the launcher identity check.' }
    . ([scriptblock]::Create($definition.Extent.Text))
    $probe = [pscustomobject]@{ Mode='exiting'; Calls=0 }
    function Get-CimInstance {
        param($ClassName, $Filter)
        $probe.Calls++
        if ($probe.Mode -eq 'exiting' -and $probe.Calls -gt 1) { return $null }
        $command = if ($probe.Mode -eq 'recovering' -and $probe.Calls -gt 1) { 'bun "' + (Join-Path $forgeRoot 'src\server\index.ts') + '"' } else { $null }
        return [pscustomobject]@{ ProcessId=43210; Name='bun.exe'; CreationDate=$created; CommandLine=$command }
    }
    if ($null -ne (Get-VerifiedForge) -or $probe.Calls -ne 2) { throw 'An exiting process was not recognized after its incomplete snapshot.' }
    $probe.Mode='recovering'; $probe.Calls=0
    $verified = Get-VerifiedForge
    if ($verified.Process.ProcessId -ne 43210 -or $probe.Calls -ne 2) { throw 'A recovered complete process identity was not verified.' }
    $probe.Mode='unavailable'; $probe.Calls=0
    try {
        $null = Get-VerifiedForge
        throw 'Unavailable process metadata was accepted.'
    } catch {
        if ($_.Exception.Message -notmatch 'metadata is unavailable' -or $probe.Calls -ne 5) { throw }
    }
    Write-Output 'PASS: exiting, recovered, and persistently unavailable Windows process identities'
}

$env:AGENT_FORGE_TEST_MONITOR = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\server\services\launch-lifecycle.ts'
$fakeServer = @'
import { existsSync } from 'node:fs';
const { monitorLauncher } = await import(process.env.AGENT_FORGE_TEST_MONITOR!);
const token = crypto.randomUUID();
await Bun.write('agent-forge.lock', JSON.stringify({pid:process.pid, startedAt:new Date().toISOString(), token}));
const stop = (code = 0) => { server.stop(true); const {unlinkSync} = require('node:fs'); unlinkSync('agent-forge.lock'); process.exit(code); };
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:(request)=>{
  const path = new URL(request.url).pathname;
  if (path === '/exit' || path === '/fail') setTimeout(() => stop(path === '/fail' ? 7 : 0),100);
  return new Response('launcher test');
}});
const launcherPid = Number(process.env.AGENT_FORGE_LAUNCHER_PID);
if (process.env.AGENT_FORGE_TEST_LEGACY !== '1') monitorLauncher({
  probe: async () => { try { process.kill(launcherPid,0); return {status:'partial',identity:{pid:launcherPid}}; } catch { return {status:'missing'}; } },
  stopRequested: () => existsSync(`agent-forge.lock.stop-${token}`),
  shutdown: () => stop(),
  intervalMs:100,
});
console.log(`Server running at http://localhost:${server.port}`);
'@
[IO.File]::WriteAllText((Join-Path $testRoot 'src\server\index.ts'), $fakeServer)
$shellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$testLaunchers = @()
function Start-TestLauncher($name) {
    $args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $testRoot 'scripts\start-agent-forge.ps1') + '" -NoBrowser -NoPauseOnError'
    return Start-Process -FilePath $shellPath -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot "$name.out") -RedirectStandardError (Join-Path $testRoot "$name.err")
}
function Wait-Ready($name, $previousPid = 0) {
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        $lockPath = Join-Path $testRoot 'agent-forge.lock'
        if (Test-Path -LiteralPath $lockPath) {
            try { $owner = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json }
            catch [System.Management.Automation.ItemNotFoundException] { continue }
            $outputPath = Join-Path $testRoot "$name.out"
            if ($owner.pid -ne $previousPid -and (Test-Path -LiteralPath $outputPath) -and (Get-Content -LiteralPath $outputPath -Raw) -match 'Agent Forge ready at') { return [int]$owner.pid }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Launcher $name never became ready. Diagnostics: $testRoot"
}
function Wait-Missing($targetPid) {
    $deadline = (Get-Date).AddSeconds(10)
    while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $deadline) { throw "PID $targetPid survived shutdown. Diagnostics: $testRoot" }
        Start-Sleep -Milliseconds 100
    }
}
try {
    $first = Start-TestLauncher 'first'; $testLaunchers += $first
    $firstServer = Wait-Ready 'first'
    Start-Sleep -Milliseconds 1500
    if (-not (Get-Process -Id $first.Id -ErrorAction SilentlyContinue)) { throw 'Launcher exited while its server was running.' }
    if ((Get-Content -LiteralPath (Join-Path $testRoot 'first.out') -Raw) -match 'launch failed') { throw 'Launcher falsely reported failure while running.' }
    $second = Start-TestLauncher 'second'; $testLaunchers += $second
    $secondServer = Wait-Ready 'second' $firstServer
    Wait-Missing $firstServer
    Wait-Missing $first.Id
    Write-Output 'PASS: launch, ready-port validation, graceful restart, previous terminal exit'
    Stop-Process -Id $second.Id
    Wait-Missing $secondServer
    Write-Output 'PASS: abrupt launching-terminal exit stops its server'
    $env:AGENT_FORGE_TEST_LEGACY = '1'
    $legacy = Start-TestLauncher 'legacy'; $testLaunchers += $legacy
    $legacyServer = Wait-Ready 'legacy'
    Remove-Item Env:\AGENT_FORGE_TEST_LEGACY
    $replacement = Start-TestLauncher 'replacement'; $testLaunchers += $replacement
    $replacementServer = Wait-Ready 'replacement' $legacyServer
    Wait-Missing $legacyServer
    Wait-Missing $legacy.Id
    Write-Output 'PASS: verified force-stop replaces a legacy server without leaving its terminal open'
    Stop-Process -Id $replacement.Id
    Wait-Missing $replacementServer
    foreach ($scenario in @('exit','fail')) {
        $normal = Start-TestLauncher $scenario; $testLaunchers += $normal
        $normalServer = Wait-Ready $scenario
        $port = (Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object OwningProcess -eq $normalServer | Select-Object -First 1).LocalPort
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/$scenario" | Out-Null
        Wait-Missing $normalServer
        Wait-Missing $normal.Id
        $report = Get-Content -LiteralPath (Join-Path $testRoot "$scenario.out") -Raw
        if ($scenario -eq 'exit' -and ($report -notmatch 'stopped \(exit code 0\)' -or $report -match 'launch failed')) { throw 'A clean exit was misreported.' }
        if ($scenario -eq 'fail' -and $report -notmatch 'Forge exited with code 7') { throw 'The real failure exit code was not reported.' }
    }
    Write-Output 'PASS: terminal remains alive while serving; clean exit 0 and failure exit 7 are correctly reported'
    Write-Output "Retained isolated diagnostics: $testRoot"
} finally {
    foreach ($launcherProcess in $testLaunchers) {
        if (Get-Process -Id $launcherProcess.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $launcherProcess.Id }
    }
    Remove-Item Env:\AGENT_FORGE_TEST_MONITOR
}
