<#
.SYNOPSIS
  Windows daemon manager for claude-to-im bridge.

.DESCRIPTION
  Manages the bridge process on Windows.
  Preferred: WinSW wrapping as a Windows Service.
  Fallback:  Start-Process with hidden window + PID tracking.

  Usage:
    powershell -File scripts\daemon.ps1 start
    powershell -File scripts\daemon.ps1 stop
    powershell -File scripts\daemon.ps1 status
    powershell -File scripts\daemon.ps1 logs [N]
    powershell -File scripts\daemon.ps1 install-service   # WinSW setup
    powershell -File scripts\daemon.ps1 uninstall-service
#>

param(
    [Parameter(Position=0)]
    [ValidateSet('start','stop','status','logs','install-service','uninstall-service','help')]
    [string]$Command = 'help',

    [Parameter(Position=1)]
    [int]$LogLines = 50
)

$ErrorActionPreference = 'Stop'

# ── Paths ──
$CtiHome    = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$SkillDir   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$RuntimeDir = Join-Path $CtiHome 'runtime'
$PidFile    = Join-Path $RuntimeDir 'bridge.pid'
$WatchdogPidFile = Join-Path $RuntimeDir 'bridge-watchdog.pid'
$StopFile = Join-Path $RuntimeDir 'bridge.stop'
$StatusFile = Join-Path $RuntimeDir 'status.json'
$LogFile    = Join-Path (Join-Path $CtiHome 'logs') 'bridge.log'
$ErrorLogFile = Join-Path (Join-Path $CtiHome 'logs') 'bridge-error.log'
$DaemonMjs  = Join-Path (Join-Path $SkillDir 'dist') 'daemon.mjs'
$WatchdogMjs  = Join-Path (Join-Path $SkillDir 'dist') 'windows-watchdog.mjs'
$ServiceConfigModule = Join-Path $SkillDir 'scripts\windows-service-config.mjs'

$ServiceName = 'ClaudeToIMBridge'
$StartTimeoutSeconds = 20

# ── Helpers ──

function Ensure-Dirs {
    @('data','logs','runtime','data/messages') | ForEach-Object {
        $dir = Join-Path $CtiHome $_
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
}

function Ensure-Built {
    $daemonMissing = -not (Test-Path $DaemonMjs)
    $watchdogMissing = -not (Test-Path $WatchdogMjs)

    if ($daemonMissing -or $watchdogMissing) {
        Write-Host "Building daemon bundle..."
        Push-Location $SkillDir
        npm run build
        Pop-Location
    } else {
        $srcFiles = Get-ChildItem -Path (Join-Path $SkillDir 'src') -Filter '*.ts' -Recurse
        $bundleTime = (Get-Item $DaemonMjs).LastWriteTime
        $stale = $srcFiles | Where-Object { $_.LastWriteTime -gt $bundleTime } | Select-Object -First 1
        $watchdogSource = Join-Path $SkillDir 'src\windows-watchdog.ts'
        $watchdogTime = (Get-Item $WatchdogMjs).LastWriteTime
        $watchdogStale = (Test-Path $watchdogSource) -and ((Get-Item $watchdogSource).LastWriteTime -gt $watchdogTime)

        if ($stale -or $watchdogStale) {
            Write-Host "Rebuilding daemon bundle (source changed)..."
            Push-Location $SkillDir
            npm run build
            Pop-Location
        }
    }
}

function Read-Pid {
    if (Test-Path $PidFile) { return (Get-Content $PidFile -Raw).Trim() }
    return $null
}

function Read-WatchdogPid {
    if (Test-Path $WatchdogPidFile) { return (Get-Content $WatchdogPidFile -Raw).Trim() }
    return $null
}

function Test-PidAlive {
    param([string]$ProcessId)
    if (-not $ProcessId) { return $false }
    try { $null = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop; return $true }
    catch { return $false }
}

function Get-StatusObject {
    if (-not (Test-Path $StatusFile)) { return $null }
    try {
        return Get-Content $StatusFile -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-ProcessCommandLine {
    param([string]$ProcessId)
    if (-not $ProcessId) { return $null }
    try {
        return (Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ProcessId)" -ErrorAction Stop).CommandLine
    } catch {
        return $null
    }
}

function Test-BridgeProcess {
    param([string]$ProcessId)
    if (-not (Test-PidAlive $ProcessId)) { return $false }
    $commandLine = Get-ProcessCommandLine $ProcessId
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }

    $daemonPattern = [regex]::Escape($DaemonMjs)
    return $commandLine -match $daemonPattern
}

function Test-WatchdogProcess {
    param([string]$ProcessId)
    if (-not (Test-PidAlive $ProcessId)) { return $false }
    $commandLine = Get-ProcessCommandLine $ProcessId
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }

    $watchdogPattern = [regex]::Escape($WatchdogMjs)
    return $commandLine -match $watchdogPattern
}

function Test-StatusRunning {
    param([string]$ExpectedPid = $null)

    $json = Get-StatusObject
    if (-not $json) { return $false }
    if ($json.running -ne $true) { return $false }
    if (-not $ExpectedPid) { return $true }
    return "$($json.pid)" -eq "$ExpectedPid"
}

function Write-StoppedStatus {
    param([string]$Reason = 'stopped')

    $status = @{}
    if (Test-Path $StatusFile) {
        try {
            $existing = Get-Content $StatusFile -Raw | ConvertFrom-Json -ErrorAction Stop
            foreach ($prop in $existing.PSObject.Properties) {
                $status[$prop.Name] = $prop.Value
            }
        } catch {
            $status = @{}
        }
    }

    $status.running = $false
    $status.pid = $null
    $status.lastExitReason = $Reason
    $status.stoppedAt = (Get-Date).ToUniversalTime().ToString('o')

    $status | ConvertTo-Json -Depth 6 | Set-Content -Path $StatusFile -Encoding UTF8
}

function Show-LastExitReason {
    if (Test-Path $StatusFile) {
        $json = Get-Content $StatusFile -Raw | ConvertFrom-Json
        if ($json.lastExitReason) {
            Write-Host "Last exit reason: $($json.lastExitReason)"
        }
    }
}

function Show-FailureHelp {
    Write-Host ""
    Write-Host "Recent logs:"
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail 20
    } else {
        Write-Host "  (no log file)"
    }
    Write-Host ""
    Write-Host "Recent stderr:"
    if (Test-Path $ErrorLogFile) {
        Get-Content $ErrorLogFile -Tail 20
    } else {
        Write-Host "  (no error log file)"
    }
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Run diagnostics:  powershell -File `"$SkillDir\scripts\doctor.ps1`""
    Write-Host "  2. Check full logs:  powershell -File `"$SkillDir\scripts\daemon.ps1`" logs 100   # shows bridge.log + bridge-error.log"
    Write-Host "  3. Rebuild bundle:   cd `"$SkillDir`"; npm run build"
    Write-Host "  4. Install WinSW for true service-mode auto restart"
}

function Get-ForwardedServiceEnvironment {
    $forwarded = @()
    foreach ($name in @('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'CTI_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
        $value = [System.Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrEmpty($value)) { continue }
        $forwarded += [pscustomobject]@{
            Name = $name
            Value = $value
        }
    }

    return $forwarded
}

function ConvertTo-WinSWEnvXml {
    param([object[]]$Entries)

    return ($Entries | ForEach-Object {
        $escaped = [System.Security.SecurityElement]::Escape($_.Value)
        "  <env name=""$($_.Name)"" value=""$escaped""/>"
    }) -join "`r`n"
}

function Get-NodePath {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        Write-Error "Node.js not found in PATH. Install Node.js >= 20."
        exit 1
    }
    return $nodePath
}

function Get-BridgeRuntimeState {
    $watchdogPid = Read-WatchdogPid
    $bridgePid = Read-Pid
    $watchdogAlive = $watchdogPid -and (Test-WatchdogProcess $watchdogPid)
    $bridgeAlive = $bridgePid -and (Test-BridgeProcess $bridgePid)
    $statusReady = $bridgePid -and (Test-StatusRunning $bridgePid)

    return [pscustomobject]@{
        WatchdogPid = $watchdogPid
        BridgePid = $bridgePid
        WatchdogAlive = [bool]$watchdogAlive
        BridgeAlive = [bool]$bridgeAlive
        StatusReady = [bool]$statusReady
    }
}

function Wait-ForBridgeLaunch {
    param(
        [switch]$RequireWatchdog,
        [int]$TimeoutSeconds = $StartTimeoutSeconds,
        [int]$PollMilliseconds = 500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $state = Get-BridgeRuntimeState

    while ($true) {
        $ready = if ($RequireWatchdog) {
            $state.WatchdogAlive -and $state.BridgeAlive
        } else {
            $state.BridgeAlive
        }

        if ($ready) {
            return $state
        }

        if ((Get-Date) -ge $deadline) {
            return $state
        }

        Start-Sleep -Milliseconds $PollMilliseconds
        $state = Get-BridgeRuntimeState
    }
}

# ── WinSW / NSSM detection ──

function Find-ServiceManager {
    # Prefer WinSW, then NSSM
    $winsw = Get-Command 'WinSW.exe' -ErrorAction SilentlyContinue
    if ($winsw) { return @{ type = 'winsw'; path = $winsw.Source } }

    $nssm = Get-Command 'nssm.exe' -ErrorAction SilentlyContinue
    if ($nssm) { return @{ type = 'nssm'; path = $nssm.Source } }

    return $null
}

function Install-WinSWService {
    param([string]$WinSWPath)
    $nodePath = Get-NodePath
    $xmlPath = Join-Path $SkillDir "$ServiceName.xml"
    $envJson = (Get-ForwardedServiceEnvironment | ConvertTo-Json -Compress)
    $xml = & node $ServiceConfigModule `
        build-winsw-xml `
        --service-name $ServiceName `
        --node-path $nodePath `
        --daemon-path $DaemonMjs `
        --working-directory $SkillDir `
        --log-directory (Join-Path $CtiHome 'logs') `
        --env-json $envJson
    Set-Content -Path $xmlPath -Value $xml -Encoding UTF8

    # Copy WinSW next to the XML with matching name
    $winswCopy = Join-Path $SkillDir "$ServiceName.exe"
    Copy-Item $WinSWPath $winswCopy -Force

    & $winswCopy install
    Write-Host "Service '$ServiceName' installed via WinSW."
    Write-Host "  Service account: default Windows service account"
    Write-Host "  Secrets are not embedded in $xmlPath; use config.env/CTI_HOME for runtime credentials."
    Write-Host "Start with:  & `"$winswCopy`" start"
    Write-Host "Or:          sc.exe start $ServiceName"
}

function Show-NSSMNotSupported {
    param([string]$NSSMPath)

    Write-Host "NSSM detected at: $NSSMPath"
    Write-Host "Secure auto-install via NSSM is disabled."
    Write-Host "Reason: configuring NSSM for the current Windows user requires passing the account password on the command line."
    Write-Host "Install WinSW instead, then re-run:"
    Write-Host "  powershell -File `"$PSCommandPath`" install-service"
    exit 1
}

# ── Fallback: Start-Process (no service manager) ──

function Start-Fallback {
    $nodePath = Get-NodePath

    $originalClaudeCode = [System.Environment]::GetEnvironmentVariable('CLAUDECODE', 'Process')
    $originalCtiHome = [System.Environment]::GetEnvironmentVariable('CTI_HOME', 'Process')

    try {
        # Make the child deterministic without permanently mutating the parent shell.
        [System.Environment]::SetEnvironmentVariable('CLAUDECODE', $null, 'Process')
        [System.Environment]::SetEnvironmentVariable('CTI_HOME', $CtiHome, 'Process')

        $proc = Start-Process -FilePath $nodePath `
            -ArgumentList $WatchdogMjs `
            -WorkingDirectory $SkillDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError $ErrorLogFile `
            -PassThru
    } finally {
        [System.Environment]::SetEnvironmentVariable('CLAUDECODE', $originalClaudeCode, 'Process')
        [System.Environment]::SetEnvironmentVariable('CTI_HOME', $originalCtiHome, 'Process')
    }

    Set-Content -Path $WatchdogPidFile -Value $proc.Id
    return $proc.Id
}

# ── Commands ──

switch ($Command) {
    'start' {
        Ensure-Dirs
        Ensure-Built

        $existingWatchdogPid = Read-WatchdogPid
        if ($existingWatchdogPid -and (Test-WatchdogProcess $existingWatchdogPid)) {
            Write-Host "Bridge watchdog already running (PID: $existingWatchdogPid)"
            if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            exit 1
        } elseif ($existingWatchdogPid) {
            Write-Host "Ignoring stale watchdog PID file (PID: $existingWatchdogPid)"
            if (Test-Path $WatchdogPidFile) { Remove-Item $WatchdogPidFile -Force }
            Write-StoppedStatus -Reason 'stale_watchdog_pid'
        }

        $existingPid = Read-Pid
        if ($existingPid -and -not (Test-BridgeProcess $existingPid)) {
            Write-Host "Ignoring stale bridge PID file (PID: $existingPid)"
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            Write-StoppedStatus -Reason 'stale_pid'
        }

        if (Test-Path $StopFile) { Remove-Item $StopFile -Force }

        # Check if registered as Windows Service
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "Starting bridge via Windows Service..."
            Start-Service -Name $ServiceName
            $serviceState = Wait-ForBridgeLaunch -TimeoutSeconds $StartTimeoutSeconds
            $newPid = $serviceState.BridgePid
            if ($serviceState.BridgeAlive) {
                Write-Host "Bridge started (PID: $newPid, managed by Windows Service)"
                if (-not $serviceState.StatusReady) {
                    Write-Host "Bridge status file is still warming up; the service child is already alive."
                }
                if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            } else {
                Write-Host "Failed to start bridge via service."
                Write-StoppedStatus -Reason 'start_failed'
                Show-LastExitReason
                Show-FailureHelp
                exit 1
            }
        } else {
            Write-Host "Starting bridge watchdog (background process)..."
            $watchdogPid = Start-Fallback
            $launchState = Wait-ForBridgeLaunch -RequireWatchdog -TimeoutSeconds $StartTimeoutSeconds
            $newWatchdogPid = $launchState.WatchdogPid
            $newPid = $launchState.BridgePid
            $watchdogAlive = $launchState.WatchdogAlive
            $bridgeAlive = $launchState.BridgeAlive
            $statusReady = $launchState.StatusReady
            if ($watchdogAlive -and $bridgeAlive) {
                Write-Host "Bridge started (PID: $newPid, watchdog PID: $newWatchdogPid)"
                if (-not $statusReady) {
                    Write-Host "Bridge status file is still warming up; watchdog confirms the child is alive."
                }
                if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            } else {
                Write-Host "Failed to start bridge."
                if (-not $watchdogAlive) {
                    Write-Host "  Watchdog exited immediately."
                } elseif (-not $bridgeAlive) {
                    Write-Host "  Bridge child did not come up."
                }
                Write-StoppedStatus -Reason 'start_failed'
                Show-LastExitReason
                Show-FailureHelp
                exit 1
            }
        }
    }

    'stop' {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Host "Stopping bridge via Windows Service..."
            Stop-Service -Name $ServiceName -Force
            Write-Host "Bridge stopped"
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            Write-StoppedStatus -Reason 'stopped'
        } else {
            $watchdogPid = Read-WatchdogPid
            if ($watchdogPid -and (Test-WatchdogProcess $watchdogPid)) {
                New-Item -ItemType File -Path $StopFile -Force | Out-Null
                taskkill /PID $watchdogPid /T /F | Out-Null
                Write-Host "Bridge stopped"
                Write-StoppedStatus -Reason 'stopped'
                if (Test-Path $WatchdogPidFile) { Remove-Item $WatchdogPidFile -Force }
                if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
                if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
                exit 0
            }

            $bridgePid = Read-Pid
            if (-not $bridgePid) {
                Write-Host "No bridge running"
                Write-StoppedStatus -Reason 'not_running'
                exit 0
            }
            if (Test-BridgeProcess $bridgePid) {
                Stop-Process -Id ([int]$bridgePid) -Force
                Write-Host "Bridge stopped"
                Write-StoppedStatus -Reason 'stopped'
            } else {
                if (Test-PidAlive $bridgePid) {
                    Write-Host "Bridge PID belongs to a different process; leaving it untouched"
                } else {
                    Write-Host "Bridge was not running (stale PID file)"
                }
                Write-StoppedStatus -Reason 'stale_pid'
            }
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            if (Test-Path $WatchdogPidFile) { Remove-Item $WatchdogPidFile -Force }
            if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
        }
    }

    'status' {
        $watchdogPid = Read-WatchdogPid
        $bridgePid = Read-Pid

        # Check Windows Service
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "Windows Service '$ServiceName': $($svc.Status)"
        }

        if ($watchdogPid -and (Test-WatchdogProcess $watchdogPid)) {
            Write-Host "Bridge watchdog is running (PID: $watchdogPid)"
        }

        if ($bridgePid -and (Test-BridgeProcess $bridgePid)) {
            Write-Host "Bridge process is running (PID: $bridgePid)"
            if (Test-StatusRunning $bridgePid) {
                Write-Host "Bridge status: running"
            } else {
                if ($watchdogPid -and (Test-WatchdogProcess $watchdogPid)) {
                    Write-Host "Bridge status: process alive under watchdog; status.json is lagging"
                } else {
                    Write-Host "Bridge status: process alive but status.json not reporting running"
                }
            }
            if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
        } elseif ($watchdogPid -and (Test-WatchdogProcess $watchdogPid)) {
            Write-Host "Bridge child is currently not visible, but the watchdog is still running."
            Write-Host "Bridge status: watchdog supervising / child may be restarting"
            if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
        } else {
            Write-Host "Bridge is not running"
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            if ($watchdogPid -and -not (Test-WatchdogProcess $watchdogPid) -and (Test-Path $WatchdogPidFile)) {
                Remove-Item $WatchdogPidFile -Force
            }
            Write-StoppedStatus -Reason 'not_running'
            Show-LastExitReason
        }
    }

    'logs' {
        $shown = $false
        if (Test-Path $LogFile) {
            Write-Host "== bridge.log =="
            Get-Content $LogFile -Tail $LogLines | ForEach-Object {
                $_ -replace '(token|secret|password)(["'']?\s*[:=]\s*["'']?)[^\s"]+', '$1$2*****'
            }
            $shown = $true
        }
        if (Test-Path $ErrorLogFile) {
            if ($shown) {
                Write-Host ""
            }
            Write-Host "== bridge-error.log =="
            Get-Content $ErrorLogFile -Tail $LogLines | ForEach-Object {
                $_ -replace '(token|secret|password)(["'']?\s*[:=]\s*["'']?)[^\s"]+', '$1$2*****'
            }
            $shown = $true
        }
        if (-not $shown) {
            Write-Host "No log files found at $LogFile or $ErrorLogFile"
        }
    }

    'install-service' {
        Ensure-Dirs
        Ensure-Built

        $mgr = Find-ServiceManager
        if (-not $mgr) {
            Write-Host "WinSW not found."
            Write-Host "  WinSW:  https://github.com/winsw/winsw/releases"
            Write-Host ""
            Write-Host "After installing, add it to PATH and re-run:"
            Write-Host "  powershell -File `"$PSCommandPath`" install-service"
            exit 1
        }

        switch ($mgr.type) {
            'winsw' { Install-WinSWService -WinSWPath $mgr.path }
            'nssm'  { Show-NSSMNotSupported -NSSMPath $mgr.path }
        }
    }

    'uninstall-service' {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Host "Service '$ServiceName' is not installed."
            exit 0
        }

        if ($svc.Status -eq 'Running') {
            Stop-Service -Name $ServiceName -Force
        }

        $mgr = Find-ServiceManager
        if ($mgr -and $mgr.type -eq 'nssm') {
            & $mgr.path remove $ServiceName confirm
        } else {
            # WinSW or generic
            $winswExe = Join-Path $SkillDir "$ServiceName.exe"
            if (Test-Path $winswExe) {
                & $winswExe uninstall
                Remove-Item $winswExe -Force -ErrorAction SilentlyContinue
                Remove-Item (Join-Path $SkillDir "$ServiceName.xml") -Force -ErrorAction SilentlyContinue
            } else {
                sc.exe delete $ServiceName
            }
        }
        Write-Host "Service '$ServiceName' uninstalled."
    }

    'help' {
        Write-Host "Usage: daemon.ps1 {start|stop|status|logs [N]|install-service|uninstall-service}"
        Write-Host ""
        Write-Host "Commands:"
        Write-Host "  start             Start the bridge daemon"
        Write-Host "  stop              Stop the bridge daemon"
        Write-Host "  status            Show bridge status"
        Write-Host "  logs [N]          Show last N log lines (default 50)"
        Write-Host "  install-service   Install as Windows Service (requires WinSW)"
        Write-Host "  uninstall-service Remove the Windows Service"
    }
}
