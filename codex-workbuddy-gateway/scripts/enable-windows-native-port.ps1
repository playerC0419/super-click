$ErrorActionPreference = 'Stop'
$gatewayRoot = Split-Path -Parent $PSScriptRoot
$backupPath = Join-Path $gatewayRoot 'data\setup\windows-environment-before.json'
$previous = [Environment]::GetEnvironmentVariable('WORKBUDDY_REMOTE_DEBUGGING_PORT', 'User')
if (!(Test-Path -LiteralPath $backupPath)) {
    @{name='WORKBUDDY_REMOTE_DEBUGGING_PORT'; previous=$previous; scope='User'} | ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding UTF8
}
[Environment]::SetEnvironmentVariable('WORKBUDDY_REMOTE_DEBUGGING_PORT', '18491', 'User')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GatewayEnvironmentNotification {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$broadcastResult = [UIntPtr]::Zero
[void][GatewayEnvironmentNotification]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
Write-Output 'Saved the WorkBuddy native loopback port for normal future desktop launches; previous value backed up.'
