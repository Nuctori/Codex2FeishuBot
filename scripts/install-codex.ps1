<#
.SYNOPSIS
  Install claude-to-im into the local Codex skills directory on Windows.

.DESCRIPTION
  Copies this repository into %USERPROFILE%\.codex\skills\claude-to-im by default,
  or creates a live link in development mode with -Link.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\install-codex.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-codex.ps1 -Link
#>

param(
    [switch]$Link,
    [string]$HomeDir = $env:USERPROFILE,
    [string]$SourceDir = (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
)

$ErrorActionPreference = 'Stop'

$SkillName = 'claude-to-im'
$CodexSkillsDir = Join-Path $HomeDir '.codex\skills'
$TargetDir = Join-Path $CodexSkillsDir $SkillName
$DaemonBundle = Join-Path $TargetDir 'dist\daemon.mjs'
$WatchdogBundle = Join-Path $TargetDir 'dist\windows-watchdog.mjs'

function Ensure-Command {
    param([string]$Name, [string]$Hint)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found. $Hint"
    }
}

function Test-IsLink {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $item = Get-Item -LiteralPath $Path -Force
    return ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Show-ExistingInstallMessage {
    if (Test-IsLink -Path $TargetDir) {
        $resolved = (Get-Item -LiteralPath $TargetDir -Force).Target
        if (-not $resolved) {
            $resolved = $TargetDir
        }
        Write-Host "Already installed as link -> $resolved"
        Write-Host "To reinstall, remove it first: Remove-Item -Force `"$TargetDir`""
        return
    }

    Write-Host "Already installed at $TargetDir"
    Write-Host "To reinstall, remove it first: Remove-Item -Recurse -Force `"$TargetDir`""
}

function Test-ExcludedCopyPath {
    param([string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return $false
    }

    $segments = $RelativePath -split '[\\/]'
    foreach ($segment in $segments) {
        if ($segment -in @('.git', 'node_modules', 'dist')) {
            return $true
        }
    }

    return ([IO.Path]::GetFileName($RelativePath) -eq '.DS_Store')
}

function Copy-SkillTree {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [string]$RelativeBase = ''
    )

    foreach ($entry in Get-ChildItem -LiteralPath $SourcePath -Force) {
        $relativePath = if ([string]::IsNullOrEmpty($RelativeBase)) {
            $entry.Name
        } else {
            Join-Path $RelativeBase $entry.Name
        }

        if (Test-ExcludedCopyPath -RelativePath $relativePath) {
            continue
        }

        $destinationEntry = Join-Path $DestinationPath $entry.Name
        if ($entry.PSIsContainer) {
            if (-not (Test-Path -LiteralPath $destinationEntry)) {
                New-Item -ItemType Directory -Path $destinationEntry -Force | Out-Null
            }
            Copy-SkillTree -SourcePath $entry.FullName -DestinationPath $destinationEntry -RelativeBase $relativePath
            continue
        }

        Copy-Item -LiteralPath $entry.FullName -Destination $destinationEntry -Force
    }
}

function Install-Link {
    try {
        New-Item -ItemType SymbolicLink -Path $TargetDir -Target $SourceDir | Out-Null
        Write-Host "Linked: $TargetDir -> $SourceDir"
        return
    } catch {
        Write-Warning "Symbolic link creation failed, retrying as a junction."
    }

    try {
        New-Item -ItemType Junction -Path $TargetDir -Target $SourceDir | Out-Null
        Write-Host "Linked: $TargetDir -> $SourceDir"
        return
    } catch {
        throw "Failed to create a development link. Enable Developer Mode or run an elevated PowerShell, then retry. $($_.Exception.Message)"
    }
}

function Ensure-DependenciesAndBuild {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir 'node_modules'))) {
        Write-Host "Installing dependencies..."
        Push-Location $TargetDir
        try {
            npm install
        } finally {
            Pop-Location
        }
    }

    if ((-not (Test-Path -LiteralPath $DaemonBundle)) -or (-not (Test-Path -LiteralPath $WatchdogBundle))) {
        Write-Host "Building daemon bundle..."
        Push-Location $TargetDir
        try {
            npm run build
        } finally {
            Pop-Location
        }
    }
}

Write-Host "Installing $SkillName skill for Codex..."

Ensure-Command -Name 'node' -Hint 'Install Node.js >= 20 and retry.'
Ensure-Command -Name 'npm' -Hint 'Install Node.js >= 20 and retry.'

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'SKILL.md'))) {
    throw "SKILL.md not found in $SourceDir"
}

New-Item -ItemType Directory -Path $CodexSkillsDir -Force | Out-Null

if (Test-Path -LiteralPath $TargetDir) {
    Show-ExistingInstallMessage
    exit 0
}

if ($Link) {
    Install-Link
} else {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Copy-SkillTree -SourcePath $SourceDir -DestinationPath $TargetDir
    Write-Host "Copied to: $TargetDir"
}

Ensure-DependenciesAndBuild

Write-Host ""
Write-Host "Done! Start a new Codex session and use:"
Write-Host "  claude-to-im setup    - configure Codex to Feishu credentials"
Write-Host "  claude-to-im start    - start the bridge daemon"
Write-Host "  claude-to-im doctor   - diagnose issues"
