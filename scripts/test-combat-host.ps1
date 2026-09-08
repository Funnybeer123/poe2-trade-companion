# Synthetic native tests: never capture the desktop or send a key.
$ErrorActionPreference = 'Stop'
$reader = [Console]::In
try {
  [Console]::SetIn((New-Object System.IO.StringReader "quit`n"))
  . (Join-Path $PSScriptRoot 'win-combat-host.ps1')
} finally { [Console]::SetIn($reader) }
if (-not [CombatWin]::Allowed('PathOfExileSteam')) { throw 'Steam process should be allowed' }
if ([CombatWin]::Allowed('NotPathOfExileSteam')) { throw 'Process substring must be rejected' }
if ([System.Runtime.InteropServices.Marshal]::SizeOf([type][CombatInput]) -ne 40) { throw 'Unexpected x64 INPUT layout' }
$bitmap = New-Object System.Drawing.Bitmap 5, 100
try {
  for ($row = 0; $row -lt 100; $row++) {
    for ($col = 0; $col -lt 5; $col++) {
      $colour = if ($row -lt 76) { [System.Drawing.Color]::FromArgb(5, 5, 5) } else { [System.Drawing.Color]::FromArgb(160, 15, 20) }
      $bitmap.SetPixel($col, $row, $colour)
    }
  }
  $rgb = [CombatWin]::SampleBitmap($bitmap, 5, 100, 0, 0, 5, 100)
  if ($rgb.Length -ne 1500 -or $rgb[0] -ne 5 -or $rgb[1140] -ne 160 -or $rgb[1499] -ne 20) { throw 'RGB sampling coordinates/order mismatch' }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 1000; $i++) { $null = [CombatWin]::SampleBitmap($bitmap, 5, 100, 0, 0, 5, 100) }
  $clock.Stop()
  Write-Output ('Native RGB extraction: {0:N3} ms per 500-pixel globe (1000 iterations; excludes screen capture and input).' -f ($clock.Elapsed.TotalMilliseconds / 1000))
} finally { $bitmap.Dispose() }
Write-Output 'Combat native synthetic checks passed; no OS input emitted.'
