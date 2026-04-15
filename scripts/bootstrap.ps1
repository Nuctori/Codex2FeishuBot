<#
.SYNOPSIS
  One-command local bootstrap for Codex to Feishu on Windows.

.DESCRIPTION
  Runs dependency install, build, optional doctor/smoke, and optional skill install.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -Install
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -Install -Link
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -Smoke -Config $env:USERPROFILE\.claude-to-im\config.env
#>

param(
    [switch]$Install,
    [switch]$Link,
    [switch]$Smoke,
    [switch]$Doctor,
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [switch]$Keep,
    [switch]$DryRun,
    [string]$Config = '',
    [string]$ChatId = ''
)

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$bootstrapScript = Join-Path $scriptDir 'bootstrap.mjs'

$args = @()
if ($Install) { $args += '--install' }
if ($Link) { $args += '--link' }
if ($Smoke) { $args += '--smoke' }
if ($Doctor) { $args += '--doctor' }
if ($SkipDeps) { $args += '--skip-deps' }
if ($SkipBuild) { $args += '--skip-build' }
if ($Keep) { $args += '--keep' }
if ($DryRun) { $args += '--dry-run' }
if ($Config) { $args += @('--config', $Config) }
if ($ChatId) { $args += @('--chat-id', $ChatId) }

Push-Location $repoRoot
try {
    & node $bootstrapScript @args
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
