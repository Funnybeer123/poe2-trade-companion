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
$script:previewClock = 0L
$script:previewChecks = New-Object 'System.Collections.Generic.List[long]'
$previewNow = [Func[long]] { $script:previewClock }
$previewWait = [Action[int]] { param($milliseconds) $script:previewClock += $milliseconds }
$previewStable = [Func[bool]] { $script:previewChecks.Add($script:previewClock); return $true }
if (-not [CombatWin]::WaitForStablePreview($previewStable, $previewNow, $previewWait)) { throw 'Stable preview should settle successfully' }
if ($script:previewClock -ne 750 -or $script:previewChecks[0] -ne 0 -or $script:previewChecks[$script:previewChecks.Count - 1] -ne 750) { throw 'Preview must verify eligibility across the full 750 ms interval, including its end' }
$script:previewClock = 0L
$previewLostFocus = [Func[bool]] { return $script:previewClock -lt 200 }
if ([CombatWin]::WaitForStablePreview($previewLostFocus, $previewNow, $previewWait) -or $script:previewClock -ne 200) { throw 'Focus loss during settling must reject the capture immediately' }
if (-not [CombatWin]::WaitForStablePreview($previewStable, $previewNow, $previewWait) -or $script:previewClock -ne 950) { throw 'A retry must require a fresh full 750 ms of stable focus' }
$script:previewClock = 0L
$previewChangedAtDeadline = [Func[bool]] { return $script:previewClock -lt 750 }
if ([CombatWin]::WaitForStablePreview($previewChangedAtDeadline, $previewNow, $previewWait)) { throw 'A changed window or client rectangle at the deadline must reject the capture' }
Write-Output 'Preview settling checks passed with synthetic time and eligibility; no desktop access or OS input.'
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
