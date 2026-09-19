# Synthetic native tests: never capture the desktop. The host has no input API.
$ErrorActionPreference = 'Stop'
$reader = [Console]::In
try {
  [Console]::SetIn((New-Object System.IO.StringReader "quit`n"))
  . (Join-Path $PSScriptRoot 'win-follower-host.ps1')
} finally { [Console]::SetIn($reader) }
if (-not [FollowWin]::Allowed('PathOfExileSteam')) { throw 'Steam process should be allowed' }
if ([FollowWin]::Allowed('NotPathOfExileSteam')) { throw 'Process substring must be rejected' }
$source = Get-Content (Join-Path $PSScriptRoot 'win-follower-host.ps1') -Raw
foreach ($forbidden in @('SendInput', 'SetCursorPos', 'SetWindowsHookEx', 'mouse_event', 'keybd_event', 'PostMessage')) {
  if ($source -match "\b$forbidden\s*\(") { throw "Capture-only host must not reference $forbidden" }
}
$bitmap = New-Object System.Drawing.Bitmap 3, 2
try {
  $bitmap.SetPixel(0, 0, [System.Drawing.Color]::FromArgb(250, 240, 230))
  $bitmap.SetPixel(1, 0, [System.Drawing.Color]::FromArgb(255, 0, 0))
  $bitmap.SetPixel(2, 0, [System.Drawing.Color]::FromArgb(10, 200, 200))
  $bitmap.SetPixel(0, 1, [System.Drawing.Color]::FromArgb(0, 0, 0))
  $bitmap.SetPixel(1, 1, [System.Drawing.Color]::FromArgb(128, 129, 130))
  $bitmap.SetPixel(2, 1, [System.Drawing.Color]::FromArgb(255, 255, 255))
  $white = [FollowWin]::Whiteness($bitmap)
  if (($white -join ',') -ne '230,0,10,0,128,255') { throw "Whiteness order/values mismatch: $($white -join ',')" }
} finally { $bitmap.Dispose() }
# Channel formulas must match channelValue() in src/core/followerPerception.ts.
if ([FollowWin]::ChannelValue(60, 210, 80, 'green') -ne 130 -or [FollowWin]::ChannelValue(250, 250, 250, 'green') -ne 0 -or [FollowWin]::ChannelValue(200, 90, 20, 'green') -ne 0) { throw 'Green channel mismatch' }
if ([FollowWin]::ChannelValue(62, 127, 165, 'blue') -ne 103 -or [FollowWin]::ChannelValue(200, 150, 100, 'blue') -ne 0) { throw 'Blue channel mismatch' }
if ([FollowWin]::ChannelValue(230, 120, 30, 'orange') -ne 90 -or [FollowWin]::ChannelValue(200, 30, 30, 'orange') -ne 0 -or [FollowWin]::ChannelValue(60, 210, 80, 'orange') -ne 0) { throw 'Orange channel mismatch' }
$keyed = New-Object System.Drawing.Bitmap 20, 12, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $green = [System.Drawing.Color]::FromArgb(60, 210, 80)
  $keyed.SetPixel(3, 2, $green); $keyed.SetPixel(19, 11, $green); $keyed.SetPixel(0, 0, $green); $keyed.SetPixel(5, 5, [System.Drawing.Color]::FromArgb(250, 250, 250))
  # The bitmap is a capture whose top-left is client (100,50); only the inner area is scanned.
  $area = New-Object System.Drawing.Rectangle 101, 51, 19, 11
  $bytes = [FollowWin]::KeyPoints($keyed, 100, 50, $area, 'green', 80, 100)
  $pairs = for ($i = 0; $i -lt $bytes.Length; $i += 4) { '{0},{1}' -f ([BitConverter]::ToUInt16($bytes, $i)), ([BitConverter]::ToUInt16($bytes, $i + 2)) }
  if (($pairs -join ' ') -ne '103,52 119,61') { throw "Key points must be client coordinates inside the area only: $($pairs -join ' ')" }
  if ($null -ne [FollowWin]::KeyPoints($keyed, 100, 50, $area, 'green', 80, 1)) { throw 'Exceeding the point cap must return null, not a truncated list' }
} finally { $keyed.Dispose() }
$large = New-Object System.Drawing.Bitmap 1920, 1080
try {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 10; $i++) { $null = [FollowWin]::Whiteness($large) }
  $clock.Stop()
  Write-Output ('Native whiteness extraction: {0:N1} ms per 1920x1080 frame (10 iterations; excludes screen capture and transfer).' -f ($clock.Elapsed.TotalMilliseconds / 10))
} finally { $large.Dispose() }
Write-Output 'Follower native synthetic checks passed; no desktop capture and no OS input.'
$big = New-Object System.Drawing.Bitmap 2560, 1440, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 10; $i++) { $null = [FollowWin]::KeyPoints($big, 0, 0, (New-Object System.Drawing.Rectangle 0, 0, 2560, 1440), 'green', 80, 6000) }
  $clock.Stop()
  Write-Output ('Native key-pixel scan: {0:N1} ms per 2560x1440 frame (10 iterations; excludes screen capture).' -f ($clock.Elapsed.TotalMilliseconds / 10))
} finally { $big.Dispose() }
$labels = New-Object System.Drawing.Bitmap 200, 40, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $g = [System.Drawing.Graphics]::FromImage($labels); $g.Clear([System.Drawing.Color]::FromArgb(90, 70, 50))
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238, 180, 97))), 20, 5, 100, 3)   # flat orange, 100 px
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(12, 8, 5))), 20, 20, 100, 3)      # flat but dark: a door label
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238, 180, 97))), 150, 30, 30, 3)  # flat orange, too short
  $g.Dispose()
  # The scenery colour is flat too in this synthetic bitmap, so use a bright floor that only the orange passes.
  $bytes = [FollowWin]::FlatRuns($labels, 1000, 500, (New-Object System.Drawing.Rectangle 1000, 500, 200, 40), 48, 150, 100)
  $found = for ($i = 0; $i -lt $bytes.Length; $i += 9) { '{0}:{1}-{2}:{3},{4},{5}' -f [BitConverter]::ToUInt16($bytes, $i), [BitConverter]::ToUInt16($bytes, $i + 2), [BitConverter]::ToUInt16($bytes, $i + 4), $bytes[$i + 6], $bytes[$i + 7], $bytes[$i + 8] }
  if (($found -join ' ') -ne '505:1020-1119:238,180,97 506:1020-1119:238,180,97 507:1020-1119:238,180,97') { throw "Flat runs must be client coordinates of long, bright, flat rows only: $($found -join ' ')" }
  if ($null -ne [FollowWin]::FlatRuns($labels, 1000, 500, (New-Object System.Drawing.Rectangle 1000, 500, 200, 40), 48, 150, 2)) { throw 'Exceeding the run cap must return null' }
} finally { $labels.Dispose() }
$world = New-Object System.Drawing.Bitmap 1792, 1080, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 10; $i++) { $null = [FollowWin]::FlatRuns($world, 0, 0, (New-Object System.Drawing.Rectangle 0, 0, 1792, 1080), 48, 45, 4000) }
  $clock.Stop()
  Write-Output ('Native flat-run scan: {0:N1} ms per 1792x1080 world area (10 iterations; excludes screen capture).' -f ($clock.Elapsed.TotalMilliseconds / 10))
} finally { $world.Dispose() }
# Hue classes measured on real labels: yellow border, the same border brightened by a drop beam, olive fill, orange fill, dark-blue fill; and what must be class 0.
$expectHue = @{ '213,213,2' = 3; '237,212,75' = 3; '76,72,16' = 3; '238,180,97' = 2; '30,17,66' = 10; '130,99,77' = 0; '12,8,5' = 0; '250,250,250' = 0; '60,56,79' = 0 }
foreach ($rgb in $expectHue.Keys) { $p = $rgb -split ','; $got = [FollowWin]::HueClass([int]$p[0], [int]$p[1], [int]$p[2]); if ($got -ne $expectHue[$rgb]) { throw "Hue class of $rgb should be $($expectHue[$rgb]) but was $got" } }
$hued = New-Object System.Drawing.Bitmap 200, 12, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $g = [System.Drawing.Graphics]::FromImage($hued); $g.Clear([System.Drawing.Color]::FromArgb(130, 99, 77))
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(213, 213, 2))), 20, 3, 60, 2)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(237, 212, 75))), 80, 3, 40, 2)   # same hue, brighter: one run with the above
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 17, 66))), 120, 3, 60, 2)    # another hue: its own run
  $g.Dispose()
  $bytes = [FollowWin]::HueRuns($hued, 500, 300, (New-Object System.Drawing.Rectangle 500, 300, 200, 12), 48, 100)
  $found = for ($i = 0; $i -lt $bytes.Length; $i += 7) { '{0}:{1}-{2}:{3}' -f [BitConverter]::ToUInt16($bytes, $i), [BitConverter]::ToUInt16($bytes, $i + 2), [BitConverter]::ToUInt16($bytes, $i + 4), $bytes[$i + 6] }
  if (($found -join ' ') -ne '303:520-619:3 303:620-679:10 304:520-619:3 304:620-679:10') { throw "Hue runs mismatch: $($found -join ' ')" }
} finally { $hued.Dispose() }
