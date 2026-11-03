# Builds the extension icon set (and a store promo tile) from icons/logo.png.
#   powershell -NoProfile -File dev/build-icons.ps1
#
# The source art is a rounded tile painted on a pure-black canvas with no alpha
# channel, so every size gets an analytically anti-aliased rounded-rect alpha
# punched in - otherwise the toolbar shows a hard black square.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'icons\logo.png'
$out  = Join-Path $root 'icons'

$bmp = New-Object System.Drawing.Bitmap $src
Write-Host "source $($bmp.Width)x$($bmp.Height) $($bmp.PixelFormat)"

# --- artwork bounds (everything that is not the black canvas) ---
$minX = $bmp.Width; $maxX = -1; $minY = $bmp.Height; $maxY = -1
for ($y = 0; $y -lt $bmp.Height; $y += 2) {
  for ($x = 0; $x -lt $bmp.Width; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    if (($c.R + $c.G + $c.B) -gt 24) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1
Write-Host "artwork x=$minX y=$minY w=$bw h=$bh"

function Punch-RoundedAlpha([System.Drawing.Bitmap]$target) {
  $w = $target.Width; $h = $target.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $target.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buf = New-Object byte[] ($data.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $r = [single]($w * 0.225)          # corner radius, matches the source tile
  $aa = [single]1.0                  # 1px anti-aliased falloff
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $w; $x++) {
      $px = $row + $x * 4
      if ($buf[$px + 3] -eq 0) { continue }
      $cx = [Math]::Min([Math]::Max($x + 0.5, $r), $w - $r)
      $cy = [Math]::Min([Math]::Max($y + 0.5, $r), $h - $r)
      $dx = ($x + 0.5) - $cx; $dy = ($y + 0.5) - $cy
      $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
      if ($d -le ($r - $aa)) { continue }
      if ($d -ge ($r + $aa)) { $buf[$px + 3] = 0; continue }
      $buf[$px + 3] = [byte]([Math]::Max(0, [Math]::Min(255, 255 * ($r + $aa - $d) / (2 * $aa))))
    }
  }
  [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $data.Scan0, $buf.Length)
  $target.UnlockBits($data)
}

function Render-Icon([int]$size, [string]$path) {
  $img = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($img)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $size, $size),
               $minX, $minY, $bw, $bh, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  Punch-RoundedAlpha $img
  $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  Write-Host "wrote $([System.IO.Path]::GetFileName($path)) ($size)"
}

Render-Icon 16  (Join-Path $out 'icon16.png')
Render-Icon 32  (Join-Path $out 'icon32.png')
Render-Icon 48  (Join-Path $out 'icon48.png')
Render-Icon 128 (Join-Path $out 'icon128.png')
Render-Icon 512 (Join-Path $out 'icon512.png')

# --- 440x280 store promo tile, on the logo's own navy ---
$tile = New-Object System.Drawing.Bitmap 440, 280, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($tile)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 8, 12, 24))
$rectF = New-Object System.Drawing.RectangleF 0, 0, 440, 280
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(-60, -170, 520, 520)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
$glow.CenterPoint = New-Object System.Drawing.PointF 200, 90
$glow.CenterColor = [System.Drawing.Color]::FromArgb(64, 143, 168, 244)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 143, 168, 244))
$g.FillRectangle($glow, 0, 0, 440, 280)
$glow.Dispose(); $path.Dispose()

$mark = New-Object System.Drawing.Bitmap (Join-Path $out 'icon128.png')
$g.DrawImage($mark, (New-Object System.Drawing.Rectangle 34, 92, 96, 96))
$mark.Dispose()

$brand = [System.Drawing.Font]::new('Segoe UI', 36, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sub   = [System.Drawing.Font]::new('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$wBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 238, 242, 252))
$aBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 156, 176, 236))
# Built from code points: Windows PowerShell reads a .ps1 as ANSI unless it
# carries a BOM, and the tagline is Chinese.
$tagline = 'ChatGPT ' + [char]0x52A0 + [char]0x901F + ' ' + [char]0x00B7 + ' ' +
           [char]0x641C + [char]0x7D22 + ' ' + [char]0x00B7 + ' ' +
           [char]0x5BFC + [char]0x51FA
$g.DrawString('Qelvynox', $brand, $wBrush, 150, 104)
$g.DrawString($tagline, $sub, $aBrush, 152, 158)
$brand.Dispose(); $sub.Dispose(); $wBrush.Dispose(); $aBrush.Dispose()
$g.Dispose()
$tile.Save((Join-Path $out 'promo-440x280.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tile.Dispose()
Write-Host 'wrote promo-440x280.png'
$bmp.Dispose()
