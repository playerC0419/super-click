$ErrorActionPreference = 'Stop'
$gatewayRoot = Split-Path -Parent $PSScriptRoot
$gatewayNode = Join-Path $gatewayRoot 'runtime\node.exe'
$gatewaySupervisor = Join-Path $PSScriptRoot 'windows-supervisor.mjs'
Start-Process -FilePath $gatewayNode -ArgumentList ('"' + $gatewaySupervisor + '"') -WorkingDirectory $gatewayRoot -WindowStyle Hidden
