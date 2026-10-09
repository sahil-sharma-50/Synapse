param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if (!$Remove) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\synapse\src\theme.css') -Destination (Join-Path $PSScriptRoot 'theme.css')
}
$hostName = 'com.synapse.browser'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$crate = Join-Path $PSScriptRoot '..\synapse\src-tauri'
Push-Location $crate
try {
    $metadata = cargo metadata --no-deps --format-version 1 | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to locate the Cargo build directory.' }
    $hostManifest = Join-Path $metadata.target_directory "debug\$hostName.json"
    if ($Remove) {
        if (Test-Path -LiteralPath $registryPath) {
            $registered = (Get-Item -LiteralPath $registryPath).GetValue('')
            if ($registered -ne $hostManifest) { throw 'This registration belongs to another checkout; leave it unchanged.' }
            Remove-Item -LiteralPath $registryPath
        }
        Write-Host 'Native host registration removed. Remove the extension in Chrome separately.'
        return
    }
    cargo build --bin synapse-browser-host
    if ($LASTEXITCODE -ne 0) { throw 'Native host build failed.' }
    $binary = Join-Path $metadata.target_directory 'debug\synapse-browser-host.exe'
    $manifest = @{ name = $hostName; description = 'Synapse browser companion'; path = $binary; type = 'stdio'; allowed_origins = @("chrome-extension://$ExtensionId/") }
    $json = $manifest | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($hostManifest, $json, [System.Text.UTF8Encoding]::new($false))
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $hostManifest
    Write-Host 'Registered. Enable Chrome control in Synapse Settings -> AI, then click Reconnect in the extension.'
} finally { Pop-Location }
