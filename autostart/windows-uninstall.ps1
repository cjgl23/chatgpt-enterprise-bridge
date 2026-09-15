<#
.SYNOPSIS
  Removes the chatgpt-enterprise-bridge Windows autostart entry.
#>

$ErrorActionPreference = 'Stop'
$TaskName = 'ChatGPTEnterpriseBridge'

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task '$TaskName' (if it existed)."
Write-Host "Note: this does not remove the CHATGPT_BRIDGE_API_KEY environment variable, if you set one during install."
