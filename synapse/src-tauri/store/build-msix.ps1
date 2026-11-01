# Builds the Microsoft Store MSIX for Synapse Voice.
#
#   npm run store:msix                 # from synapse/: build the app, then pack
#   npm run store:msix -- -SkipBuild   # repack the existing release exe
#   npm run store:msix -- -Register    # also register the staged folder locally
#                                      # (needs Windows Developer Mode) to test
#                                      # the packaged app before uploading
#
# Output: src-tauri/target/msix/SynapseVoice_<version>_x64.msix, unsigned on
# purpose. Partner Center signs MSIX packages itself, so upload it as-is.
# The package contains what the NSIS installer ships: synapse.exe and the TTS
# sidecar resource. Keep the two in step if bundle.resources changes.
param(
    [switch]$SkipBuild,
    [switch]$Register
)
$ErrorActionPreference = "Stop"

$store = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriDir = Resolve-Path (Join-Path $store "..")
$appDir = Resolve-Path (Join-Path $tauriDir "..")

$conf = Get-Content (Join-Path $tauriDir "tauri.conf.json") -Raw | ConvertFrom-Json
if ($conf.version -notmatch '^\d+\.\d+\.\d+$') {
    throw "tauri.conf.json version '$($conf.version)' is not plain major.minor.patch; the Store needs a numeric version"
}
$version = "$($conf.version).0"

# Newest Windows SDK that has makeappx + makepri.
$kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$sdk = Get-ChildItem $kits -Directory -Filter "10.*" |
    Sort-Object { [version]$_.Name } -Descending |
    Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
    Select-Object -First 1
if (-not $sdk) { throw "Windows SDK not found under $kits (install the Windows 10/11 SDK)" }
$makeappx = Join-Path $sdk.FullName "x64\makeappx.exe"
$makepri = Join-Path $sdk.FullName "x64\makepri.exe"

if (-not $SkipBuild) {
    Push-Location $appDir
    try {
        # --no-bundle: build the exe only; MSIX packing happens below.
        npm run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
    } finally {
        Pop-Location
    }
}

$exe = Join-Path $tauriDir "target\release\synapse.exe"
if (-not (Test-Path $exe)) { throw "$exe not found; run without -SkipBuild" }

$out = Join-Path $tauriDir "target\msix"
$stage = Join-Path $out "stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage, (Join-Path $stage "resources") | Out-Null

Copy-Item $exe $stage
Copy-Item (Join-Path $tauriDir "resources\tts_sidecar.py") (Join-Path $stage "resources")
Copy-Item (Join-Path $store "Assets") $stage -Recurse

$manifest = (Get-Content (Join-Path $store "AppxManifest.xml") -Raw).Replace("__VERSION__", $version)
Set-Content -Path (Join-Path $stage "AppxManifest.xml") -Value $manifest -Encoding utf8

# resources.pri lets Windows pick the unplated, size-specific taskbar icons.
$priConfig = Join-Path $out "priconfig.xml"
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed" }
& $makepri new /pr $stage /cf $priConfig /mn (Join-Path $stage "AppxManifest.xml") /of (Join-Path $stage "resources.pri") /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri new failed" }

$msix = Join-Path $out "SynapseVoice_$($conf.version)_x64.msix"
& $makeappx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed" }

Write-Host ""
Write-Host "MSIX: $msix (version $version)"

if ($Register) {
    # Loose-file registration runs the exact staged layout with package
    # identity, without signing. Remove with:
    #   Get-AppxPackage SahilSharmaStudios.SynapseVoice | Remove-AppxPackage
    Add-AppxPackage -Register (Join-Path $stage "AppxManifest.xml")
    Write-Host "Registered. Launch 'Synapse Voice' from Start to test."
}
