<#
.SYNOPSIS
  Windows wrapper for the bridge diagnostics script.
#>

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$doctorScript = Join-Path $scriptDir 'doctor.sh'
$doctorNodeScript = Join-Path $scriptDir 'doctor-node.mjs'
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
    if (-not (Test-Path $doctorNodeScript)) {
        Write-Error "bash not found in PATH, and fallback diagnostics script is missing: $doctorNodeScript"
        exit 1
    }

    & node $doctorNodeScript @args
    exit $LASTEXITCODE
}

& $bashPath $doctorScript @args
exit $LASTEXITCODE
