# Regenerates the MSIX logo assets in ./Assets from src-tauri/icons/icon.png.
# Run once after the app icon changes, then commit the PNGs:
#   powershell -ExecutionPolicy Bypass -File src-tauri/store/make-assets.ps1
#
# The `targetsize-*_altform-unplated` variants are what the taskbar, Start and
# Alt+Tab use; without them Windows draws the 44px logo on an accent-coloured
# plate. build-msix.ps1 indexes them into resources.pri with makepri.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here "..\icons\icon.png"
$assets = Join-Path $here "Assets"
New-Item -ItemType Directory -Force $assets | Out-Null

function Write-Png([int]$canvas, [int]$glyph, [string]$name) {
    $src = [System.Drawing.Image]::FromFile((Resolve-Path $source))
    try {
        $bmp = New-Object System.Drawing.Bitmap $canvas, $canvas
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $offset = [int](($canvas - $glyph) / 2)
        $g.DrawImage($src, $offset, $offset, $glyph, $glyph)
        $g.Dispose()
        $bmp.Save((Join-Path $assets $name), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    } finally {
        $src.Dispose()
    }
}

Write-Png 50 50 "StoreLogo.png"
Write-Png 44 44 "Square44x44Logo.png"
# Medium tile: Windows guidance leaves ~1/3 padding around the glyph.
Write-Png 150 100 "Square150x150Logo.png"
foreach ($size in 16, 24, 32, 48, 256) {
    Write-Png $size $size "Square44x44Logo.targetsize-${size}_altform-unplated.png"
}
Write-Host "Wrote MSIX assets to $assets"
