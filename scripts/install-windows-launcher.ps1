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

# The workstation bootstrap installed a second sign-in path that starts Forge
# hidden. Retain its definition for recovery, but disable only that exact task.
# Refuse an unfamiliar same-name task before changing either startup mechanism.
$legacyTaskName = 'Agent Forge Startup'
$legacyLauncher = [IO.Path]::GetFullPath((Join-Path (Split-Path $forgeRoot -Parent) 'legacy-bootstrap\start-agent-forge.ps1'))
$legacyTasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object TaskName -eq $legacyTaskName)
foreach ($legacyTask in $legacyTasks) {
    $actions = @($legacyTask.Actions)
    if ($actions.Count -ne 1) { throw "Unrecognized actions on scheduled task '$legacyTaskName'; no launcher changes were made." }
    $action = $actions[0]
    $fileArgument = [regex]::Match([string]$action.Arguments, '(?i)(?:^|\s)-File\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))(?:\s|$)')
    if (-not $fileArgument.Success -or [IO.Path]::GetFileName([string]$action.Execute).ToLowerInvariant() -notin @('powershell.exe', 'pwsh.exe')) {
        throw "Unrecognized launcher on scheduled task '$legacyTaskName'; no launcher changes were made."
    }
    $taskScript = if ($fileArgument.Groups['quoted'].Success) { $fileArgument.Groups['quoted'].Value } else { $fileArgument.Groups['plain'].Value }
    if (-not [IO.Path]::IsPathRooted($taskScript) -or -not [string]::Equals([IO.Path]::GetFullPath($taskScript), $legacyLauncher, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Scheduled task '$legacyTaskName' belongs to another launcher; no launcher changes were made."
    }
}
foreach ($legacyTask in $legacyTasks) {
    if ($legacyTask.Settings.Enabled) {
        Disable-ScheduledTask -InputObject $legacyTask -ErrorAction Stop | Out-Null
    }
    if ((Get-ScheduledTask -TaskName $legacyTaskName -TaskPath '\' -ErrorAction Stop).Settings.Enabled) {
        throw "The legacy hidden startup task is still enabled; refusing to install a competing startup path."
    }
    Write-Host "Disabled legacy hidden startup task: $legacyTaskName (definition retained)."
}

foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $shortcut.WorkingDirectory = $forgeRoot
    $shortcut.WindowStyle = 1
    $shortcut.Description = 'Restart Agent Forge and open Chrome profile First'
    $shortcut.Save()
    Write-Host "Installed: $shortcutPath"
}
