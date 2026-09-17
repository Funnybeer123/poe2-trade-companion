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
# Only the pure edge state is exercised below: never Configure the native monitor.
if ([CombatTriggerMonitor]::TriggerCode('R') -ne 82 -or [CombatTriggerMonitor]::TriggerCode('5') -ne 53 -or [CombatTriggerMonitor]::TriggerCode('') -ne 0) { throw 'Trigger binding validation failed' }
foreach ($invalidTrigger in @('MOUSE5', 'CTRL+R', 'rr', 'r')) {
  $rejected = $false
  try { $null = [CombatTriggerMonitor]::TriggerCode($invalidTrigger) } catch { $rejected = $true }
  if (-not $rejected) { throw 'Non-letter/digit trigger should be rejected' }
}
$trigger = New-Object CombatTriggerState
$trigger.Configure(82, $false)
$trigger.Observe(84, $true, $false, [IntPtr]111, 10)
$trigger.Observe(82, $true, $true, [IntPtr]111, 20)
$snapshot = $trigger.Consume(25)
if ($snapshot.Down -or $null -ne $snapshot.Trigger) { throw 'Other bindings and injected presses must be ignored' }
$trigger.Observe(82, $true, $false, [IntPtr]111, 30)
$trigger.Observe(82, $true, $false, [IntPtr]222, 40)
$snapshot = $trigger.Consume(50)
if (-not $snapshot.Down -or $snapshot.Trigger.Id -ne 1 -or $snapshot.Trigger.Hwnd -ne '111' -or $snapshot.Trigger.AgeMs -ne 20) { throw 'First physical edge must retain its original window and age across autorepeat' }
if ($null -ne $trigger.Consume(51).Trigger) { throw 'An edge must be consumed exactly once, including when its sample later fails' }
$trigger.Observe(82, $false, $true, [IntPtr]111, 60)
$trigger.Observe(82, $true, $false, [IntPtr]111, 70)
$snapshot = $trigger.Consume(80)
if (-not $snapshot.Down -or $null -ne $snapshot.Trigger) { throw 'Injected keyup must not release the physical-held latch' }
$trigger.Observe(82, $false, $false, [IntPtr]999, 90)
if ($trigger.Consume(91).Down) { throw 'Physical release outside the game must clear the held latch' }
$trigger.Observe(82, $true, $false, [IntPtr]222, 100)
$trigger.Observe(82, $false, $false, [IntPtr]222, 101)
$snapshot = $trigger.Consume(110)
if ($snapshot.Down -or $snapshot.Trigger.Id -ne 2 -or $snapshot.Trigger.Hwnd -ne '222') { throw 'A short press/release between samples must remain observable' }
$trigger.Configure(82, $true)
$trigger.Observe(82, $true, $false, [IntPtr]111, 120)
$snapshot = $trigger.Consume(130)
if (-not $snapshot.Down -or $null -ne $snapshot.Trigger) { throw 'Enabling while held must wait for release and a new press' }
$trigger.Observe(82, $false, $false, [IntPtr]111, 140)
$trigger.Observe(82, $true, $false, [IntPtr]111, 150)
$snapshot = $trigger.Consume(160)
if ($snapshot.Trigger.Id -ne 3) { throw 'Trigger ids must remain monotonic across configuration changes' }
$trigger.Configure(0, $false)
$trigger.Observe(82, $true, $false, [IntPtr]111, 170)
$snapshot = $trigger.Consume(180)
if ($snapshot.Down -or $null -ne $snapshot.Trigger) { throw 'Disabled triggers must not latch events' }
$trigger.Configure(82, $false)
$trigger.Observe(82, $true, $false, [IntPtr]111, 190)
$trigger.Observe(82, $false, $false, [IntPtr]111, 191)
$trigger.Observe(82, $true, $false, [IntPtr]222, 200)
$snapshot = $trigger.Consume(450)
if ($snapshot.Trigger.Id -ne 5 -or $snapshot.Trigger.Hwnd -ne '222' -or $snapshot.Trigger.AgeMs -ne 250 -or $null -ne $trigger.Consume(451).Trigger) { throw 'A burst retains only the latest edge, without queuing later casts' }
$trigger.Observe(82, $false, $false, [IntPtr]222, 460)
$trigger.Observe(82, $true, $false, [IntPtr]::Zero, 470) # Modified R: ineligible window at physical edge.
$trigger.Observe(82, $true, $false, [IntPtr]222, 480) # Modifier released while R remains held.
$snapshot = $trigger.Consume(490)
if (-not $snapshot.Down -or $snapshot.Trigger.Id -ne 6 -or $snapshot.Trigger.Hwnd -ne '0') { throw 'Releasing modifiers must not turn an ineligible physical edge into a plain-R trigger' }
$trigger.Observe(82, $false, $false, [IntPtr]222, 500)
$trigger.Observe(82, $true, $false, [IntPtr]222, 510)
if ($trigger.Consume(520).Trigger.Id -ne 7) { throw 'A new plain-R press after releasing modified R must remain eligible' }
$trigger.Observe(82, $false, $false, [IntPtr]222, 530)
$trigger.Observe(82, $true, $false, [IntPtr]222, 540) # A press while the final T action is still busy.
$barrier = $trigger.Consume(550) # completeTriggerCycle discards this edge.
if (-not $barrier.Down -or $barrier.Trigger.Id -ne 8) { throw 'Cycle completion must drain a late busy trigger while preserving its held state' }
$trigger.Observe(82, $true, $false, [IntPtr]222, 560)
$snapshot = $trigger.Consume(570)
if (-not $snapshot.Down -or $null -ne $snapshot.Trigger) { throw 'A held-key repeat after the completion barrier must not start another cycle' }
$emptySamples = [CombatWin]::SampleRegions([System.Drawing.Rectangle]::Empty, [int[]]@())
if ($emptySamples.Length -ne 0) { throw 'Empty regions must return without allocating or capturing a bitmap' }
Write-Output 'Physical-trigger edge checks passed; no hook installed and no OS input emitted.'
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
