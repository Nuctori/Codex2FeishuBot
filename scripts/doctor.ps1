<#
.SYNOPSIS
  Windows wrapper for the bridge diagnostics script.
#>

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$doctorScript = Join-Path $scriptDir 'doctor.sh'
$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
$bashPath = if ($bashCommand) { $bashCommand.Source } else { $null }

if (-not $bashPath) {
    foreach ($candidate in @(
        'C:\Program Files\Git\bin\bash.exe',
        'C:\Program Files\Git\usr\bin\bash.exe',
        'C:\Windows\System32\bash.exe'
    )) {
        if (Test-Path $candidate) {
            $bashPath = $candidate
            break
        }
    }
}

if (-not $bashPath) {
    Write-Error "bash not found in PATH. Install Git Bash or WSL, or run the diagnostics from a Unix-like shell."
    exit 1
}

& $bashPath $doctorScript @args
exit $LASTEXITCODE
