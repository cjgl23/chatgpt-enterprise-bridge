<#
.SYNOPSIS
  Registers chatgpt-enterprise-bridge to start automatically when you log in to Windows.
.DESCRIPTION
  OPTIONAL. The bridge service works fine with plain `npm start` and does not
  need this. Run this script only if you want it to start on its own.

  Creates a Windows Task Scheduler task ("ChatGPTEnterpriseBridge") that runs
  `node bin/start.js` from this package's folder, triggered at your Windows
  logon. Safe to re-run: it replaces any existing task with the same name.

  Some corporate/managed laptops block Task Scheduler changes entirely — if
  Register-ScheduledTask below fails with an access-denied error, that is a
  policy restriction, not a bug in this script. In that case just keep
  starting the service by hand (`npm start`).
.PARAMETER ApiKey
  Optional. If given, persists CHATGPT_BRIDGE_API_KEY as a permanent user
  environment variable (via setx), so the key stays the same across restarts
  instead of a new random one being generated (and printed) every time.
#>

param(
    [string]$ApiKey
)

$ErrorActionPreference = 'Stop'

$TaskName = 'ChatGPTEnterpriseBridge'
$PackageDir = Split-Path -Parent $PSScriptRoot   # autostart/ -> package root
$StartScript = Join-Path $PackageDir 'bin\start.js'

if (-not (Test-Path $StartScript)) {
    throw "Could not find $StartScript - run this script from inside the package's autostart folder."
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    throw "node.exe not found on PATH. Install Node.js first."
}

if ($ApiKey) {
    setx CHATGPT_BRIDGE_API_KEY $ApiKey | Out-Null
    Write-Host "Persisted CHATGPT_BRIDGE_API_KEY as a user environment variable."
    Write-Host "(Existing terminals won't see it until reopened; the scheduled task will.)"
}

# Remove any existing registration so re-running this script updates it cleanly.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction -Execute $NodeCmd.Source -Argument "`"$StartScript`"" -WorkingDirectory $PackageDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description 'Starts the local ChatGPT Enterprise bridge service on login.' | Out-Null
} catch {
    Write-Warning "Could not register the scheduled task. If this says access is denied, your laptop's IT policy is likely blocking Task Scheduler changes — this is expected on some managed corporate machines. Just run 'npm start' by hand instead."
    throw
}

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "It will start automatically next time you log in."
Write-Host "To start it right now without logging out: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Note: depending on your Windows version, a console window may flash briefly on startup."
Write-Host "To remove it later: autostart\windows-uninstall.ps1"
