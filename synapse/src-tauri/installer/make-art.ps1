Add-Type -AssemblyName System.Drawing

$logoPath = 'C:\Users\sahil\Desktop\Synapse\assets\synapse_icon.png'
$outDir   = 'C:\Users\sahil\Desktop\Synapse\synapse\src-tauri\installer'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$logo = [System.Drawing.Image]::FromFile($logoPath)

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  return @($bmp, $g)
}

# ---------- header.bmp : 150x57, sits top-right of every page on a white header ----------
$r = New-Canvas 150 57
$bmp = $r[0]; $g = $r[1]
$g.Clear([System.Drawing.Color]::White)

# The MUI header in Tauri's NSIS template is left-aligned, so this is a
# left-to-right lockup: mark first, wordmark after it.
$mark = 38
$g.DrawImage($logo, (New-Object System.Drawing.Rectangle(11, ([int]((57 - $mark) / 2)), $mark, $mark)))

$fontWord = New-Object System.Drawing.Font('Segoe UI Semibold', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brushDark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(23, 23, 26))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Near
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('Synapse', $fontWord, $brushDark, (New-Object System.Drawing.RectangleF(($mark + 18), 0, (150 - $mark - 18), 57)), $sf)

$bmp.Save("$outDir\header.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# ---------- sidebar.bmp : 164x314, full-bleed art on welcome + finish pages ----------
$r = New-Canvas 164 314
$bmp = $r[0]; $g = $r[1]

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point(164, 314)),
  ([System.Drawing.Color]::FromArgb(30, 31, 38)),
  ([System.Drawing.Color]::FromArgb(11, 11, 13)))
$g.FillRectangle($grad, 0, 0, 164, 314)

# soft blue glow behind the mark, matching the app's accent
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(-10, 40, 184, 184)
$halo = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
$halo.CenterColor = [System.Drawing.Color]::FromArgb(36, 42, 58)
$halo.SurroundColors = @([System.Drawing.Color]::FromArgb(15, 15, 18))
$g.FillPath($halo, $glow)

$mark = 96
$g.DrawImage($logo, (New-Object System.Drawing.Rectangle(([int]((164 - $mark) / 2)), 78, $mark, $mark)))

$sfc = New-Object System.Drawing.StringFormat
$sfc.Alignment = [System.Drawing.StringAlignment]::Center

$fontTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brushWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 241, 245))
$g.DrawString('Synapse', $fontTitle, $brushWhite, (New-Object System.Drawing.RectangleF(0, 196, 164, 30)), $sfc)

$fontSub = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brushMuted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(138, 142, 156))
$g.DrawString("Dictation, AI and notes`nunder one hotkey", $fontSub, $brushMuted, (New-Object System.Drawing.RectangleF(0, 228, 164, 40)), $sfc)

$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 170, 255))
$g.FillRectangle($accent, 62, 284, 40, 2)

$bmp.Save("$outDir\sidebar.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()
$logo.Dispose()

Get-ChildItem $outDir | Select-Object Name, Length
