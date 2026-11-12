$ErrorActionPreference = 'Stop'
$forgeRoot = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'start-agent-forge.ps1'
$shell = New-Object -ComObject WScript.Shell
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Forge.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Forge.lnk')
)
foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcutPath) {
        $existing = $shell.CreateShortcut($shortcutPath)
        if (-not $existing.Arguments.Contains($launcher)) { throw "An unrelated shortcut already exists: $shortcutPath" }
    }
}

foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $shortcut.WorkingDirectory = $forgeRoot
    $shortcut.WindowStyle = 1
    $shortcut.Description = 'Restart Agent Forge and open it in your browser'
    $shortcut.Save()
    Write-Host "Installed: $shortcutPath"
}
