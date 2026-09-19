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
$large = New-Object System.Drawing.Bitmap 1920, 1080
try {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 10; $i++) { $null = [FollowWin]::Whiteness($large) }
  $clock.Stop()
  Write-Output ('Native whiteness extraction: {0:N1} ms per 1920x1080 frame (10 iterations; excludes screen capture and transfer).' -f ($clock.Elapsed.TotalMilliseconds / 10))
} finally { $large.Dispose() }
Write-Output 'Follower native synthetic checks passed; no desktop capture and no OS input.'
