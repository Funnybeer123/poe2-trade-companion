# Synthetic native tests: never moves the cursor, clicks, or captures. Only pure helpers run.
$ErrorActionPreference = 'Stop'
$reader = [Console]::In
try {
  [Console]::SetIn((New-Object System.IO.StringReader "quit`n"))
  . (Join-Path $PSScriptRoot 'win-follower-input-host.ps1')
} finally { [Console]::SetIn($reader) }
if (-not [FollowInput]::Allowed('PathOfExileSteam')) { throw 'Steam process should be allowed' }
if ([FollowInput]::Allowed('NotPathOfExileSteam') -or [FollowInput]::Allowed('')) { throw 'Only exact allowlisted process names may receive input' }
if ([System.Runtime.InteropServices.Marshal]::SizeOf([type][FollowInputEvent]) -ne 40) { throw 'Unexpected x64 INPUT layout' }
$down = [FollowInput]::Button($true); $up = [FollowInput]::Button($false)
if ($down.Type -ne 0 -or $down.Data.Mouse.Flags -ne 0x2 -or $up.Data.Mouse.Flags -ne 0x4) { throw 'Movement must be a left button down/up pair' }
if ($down.Data.Mouse.X -ne 0 -or $down.Data.Mouse.Y -ne 0 -or $down.Data.Mouse.Data -ne 0) { throw 'Button events must not carry movement or wheel data' }
function Expect($x, $y, $w, $h, $age, $max, $error) {
  $check = [FollowInput]::Check($x, $y, $w, $h, $age, $max)
  if ($null -eq $error) { if (-not $check.Ok) { throw "Expected accept for $x,$y age $age but got: $($check.Error)" } }
  elseif ($check.Ok -or $check.Error -ne $error) { throw "Expected '$error' for $x,$y age $age but got ok=$($check.Ok) '$($check.Error)'" }
}
Expect 1280 720 2560 1440 0 120 $null
Expect 1280 1150 2560 1440 40 120 $null            # 430 px below centre: inside the 432 px disc
Expect 1280 1160 2560 1440 40 120 'Click outside the safe movement area'
Expect 60 1300 2560 1440 40 120 'Click outside the safe movement area'   # flask/HUD corner
Expect 2400 100 2560 1440 40 120 'Click outside the safe movement area'  # quest tracker
Expect 1280 720 2560 1440 121 120 'Stale capture'
Expect 1280 720 2560 1440 -5 120 'Stale capture'    # a capture "from the future" is never fresh
Expect 1280 720 2560 1440 10 5000 'Invalid freshness limit'
Expect 10 10 100 100 0 120 'Invalid game view'
Expect -50 500 400 1000 0 120 'Click outside the safe movement area'   # tall narrow view: the disc overhangs the client
function ExpectLoot($x, $y, $error) { $check = [FollowInput]::Check($x, $y, 2560, 1440, 10, 120, 'loot'); if ($null -eq $error) { if (-not $check.Ok) { throw "Loot click $x,$y should be accepted: $($check.Error)" } } elseif ($check.Ok -or $check.Error -ne $error) { throw "Loot click $x,$y expected '$error' but got ok=$($check.Ok) '$($check.Error)'" } }
ExpectLoot 790 185 $null                              # a label near the top of the world view, outside the movement disc
ExpectLoot 1900 1100 $null
ExpectLoot 255 600 'Click outside the loot area'      # party frames
ExpectLoot 2048 600 'Click outside the loot area'     # quest tracker
ExpectLoot 1280 1152 'Click outside the loot area'    # HUD
ExpectLoot 1280 71 'Click outside the loot area'      # top edge, where clipped tooltips sit
if (([FollowInput]::Check(1280, 720, 2560, 1440, 10, 120, 'anywhere')).Error -ne 'Unknown click area') { throw 'Unknown click areas must be refused' }
if (([FollowInput]::Check(790, 185, 2560, 1440, 10, 120, 'move')).Error -ne 'Click outside the safe movement area') { throw 'A movement click must not borrow the loot area' }
Expect 420 500 400 1000 0 120 'Click outside the safe movement area'
if (-not [FollowInput]::Release()) { throw 'Nothing held: release must report success and must not throw' }
$spaceDown = [FollowInput]::Space($true); $spaceUp = [FollowInput]::Space($false)
if ($spaceDown.Type -ne 1 -or $spaceDown.Data.Key.Vk -ne 0x20 -or $spaceDown.Data.Key.Scan -ne 0x39 -or $spaceDown.Data.Key.Flags -ne 0 -or $spaceUp.Data.Key.Flags -ne 2) { throw 'Sprint must be the space key, down then up' }
if (-not [FollowInput]::ReleaseSprint()) { throw 'Nothing held: releasing sprint must report success and send nothing' }
if ([FollowInput]::SprintRenewMs -gt 500) { throw 'The sprint hold must lapse quickly when it is not renewed' }
if (-not [FollowInput]::HumanStillActive($true, 5000)) { throw 'A cursor that moved again is still under manual control' }
if (-not [FollowInput]::HumanStillActive($false, 999)) { throw 'A cursor must rest for a full second before following resumes' }
if ([FollowInput]::HumanStillActive($false, 1000)) { throw 'A rested cursor hands control back' }
$source = Get-Content (Join-Path $PSScriptRoot 'win-follower-input-host.ps1') -Raw
if ($source -notmatch 'SendInput\(2, new \[\] \{ Button\(true\), Button\(false\) \}') { throw 'Movement clicks must be one down/up batch' }
if ($source -notmatch 'catch \{ ReleaseSprint\(\); throw; \}' -or $source -notmatch 'expired = spaceHeld && QpcMs\(\) > spaceDeadline') { throw 'Sprint must let go on any refusal and have a watchdog' }
if ($source -notmatch 'GetAncestor\(WindowFromPoint\(cursor\), 2\) != window') { throw 'The window under the cursor must be hit-tested before clicking' }
foreach ($forbidden in @('CopyFromScreen', 'BitBlt', 'keybd_event', 'SetWindowsHookEx', 'SetForegroundWindow', 'PostMessage')) {
  if ($source -match "\b$forbidden\b") { throw "Movement host must not reference $forbidden" }
}
Write-Output 'Follower input-host synthetic checks passed; no cursor movement, click, or capture.'
