# Install fast-vibe shortcuts: Desktop, Start Menu, and Windows Startup folder.
# Re-runnable: overwrites existing shortcuts with the same name.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
# Flags:  -SkipStartup   skip the Startup folder shortcut (no auto-start on login)
#         -Uninstall     remove all three shortcuts

param(
    [switch]$SkipStartup,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher   = Join-Path $repoRoot 'scripts\launch.bat'
$shortcutName = 'fast-vibe.lnk'

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$startupDir = [Environment]::GetFolderPath('Startup')

$targets = @(
    @{ Name = 'Desktop';     Path = (Join-Path $desktopDir $shortcutName)   },
    @{ Name = 'Start Menu';  Path = (Join-Path $startMenuDir $shortcutName) }
)
if (-not $SkipStartup) {
    $targets += @{ Name = 'Startup';     Path = (Join-Path $startupDir $shortcutName)   }
}

if ($Uninstall) {
    foreach ($t in $targets) {
        if (Test-Path $t.Path) {
            Remove-Item $t.Path -Force
            Write-Host "Removed: $($t.Name) -> $($t.Path)"
        } else {
            Write-Host "Skipped: $($t.Name) (not found)"
        }
    }
    exit 0
}

if (-not (Test-Path $launcher)) {
    Write-Error "Launcher not found: $launcher"
    exit 1
}

$wshell = New-Object -ComObject WScript.Shell

foreach ($t in $targets) {
    $sc = $wshell.CreateShortcut($t.Path)
    $sc.TargetPath       = $launcher
    $sc.WorkingDirectory = $repoRoot
    $sc.IconLocation     = 'cmd.exe,0'
    $sc.Description      = 'fast-vibe — web terminal multiplexer for parallel Claude Code sessions'
    $sc.WindowStyle      = 1
    $sc.Save()
    Write-Host "Installed: $($t.Name) -> $($t.Path)"
}

Write-Host ""
Write-Host "Done. Launcher: $launcher"
Write-Host "Re-run with -Uninstall to remove these shortcuts."
