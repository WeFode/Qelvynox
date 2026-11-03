Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'icons\icon512.png'))
$targets = @(@{Name='store-promo-440x280.png'; W=440; H=280}, @{Name='store-marquee-1400x560.png'; W=1400; H=560})
foreach ($t in $targets) {
  $bmp = New-Object System.Drawing.Bitmap($t.W, $t.H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $rect = New-Object System.Drawing.Rectangle(0, 0, $t.W, $t.H)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, ([System.Drawing.Color]::FromArgb(29,43,75)), ([System.Drawing.Color]::FromArgb(10,15,29)), 30)
  $g.FillRectangle($brush, $rect)
  $scale = $t.H / 280.0
  $g.DrawImage($icon, [int](35*$scale), [int](80*$scale), [int](100*$scale), [int](100*$scale))
  $font = New-Object System.Drawing.Font('Segoe UI', [single](26*$scale), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sub = New-Object System.Drawing.Font('Segoe UI', [single](12*$scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240,243,255))
  $blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(173,194,255))
  $g.DrawString('Qelvynox', $font, $white, [single](155*$scale), [single](94*$scale))
  $g.DrawString('NAVIGATE  /  SEARCH  /  EXPORT', $sub, $blue, [single](156*$scale), [single](136*$scale))
  $bmp.Save((Join-Path $root ('icons\'+$t.Name)), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $brush.Dispose(); $font.Dispose(); $sub.Dispose(); $white.Dispose(); $blue.Dispose(); $bmp.Dispose()
  Write-Host "Created $($t.Name): $($t.W)x$($t.H)"
}
$icon.Dispose()
