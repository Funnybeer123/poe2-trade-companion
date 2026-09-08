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
$mouseEvents = [CombatWin]::TapEvents('MOUSE5')
if ($mouseEvents.Length -ne 2 -or $mouseEvents[0].Type -ne 0 -or $mouseEvents[1].Type -ne 0) { throw 'Mouse5 must emit a pair of mouse events' }
if ($mouseEvents[0].Data.Mouse.Data -ne 2 -or $mouseEvents[1].Data.Mouse.Data -ne 2) { throw 'Mouse5 must target XBUTTON2' }
if ($mouseEvents[0].Data.Mouse.Flags -ne 0x80 -or $mouseEvents[1].Data.Mouse.Flags -ne 0x100) { throw 'Mouse5 requires XDOWN then XUP, without movement' }
if ($mouseEvents[0].Data.Mouse.X -ne 0 -or $mouseEvents[0].Data.Mouse.Y -ne 0) { throw 'Mouse5 must not reposition the cursor' }
if ([CombatWin]::BindingCode('MOUSE5') -ne 6) { throw 'Mouse5 held-state guard must check VK_XBUTTON2' }
$healthEvents = [CombatWin]::TapEvents('1')
if ($healthEvents[0].Type -ne 1 -or $healthEvents[0].Data.Key.Vk -ne 0x31 -or $healthEvents[1].Data.Key.Flags -ne 2) { throw 'Health binding must retain keyboard 1 down/up' }
$digitEvents = [CombatWin]::TapEvents('5')
if ($digitEvents[0].Type -ne 1 -or $digitEvents[0].Data.Key.Vk -ne 0x35) { throw 'Keyboard 5 must remain distinct from Mouse5' }
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
