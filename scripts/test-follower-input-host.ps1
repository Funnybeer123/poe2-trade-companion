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
function ExpectParty($x, $y, $error) { $check = [FollowInput]::Check($x, $y, 2560, 1440, 10, 120, 'party'); if ($null -eq $error) { if (-not $check.Ok) { throw "Party click $x,$y should be accepted: $($check.Error)" } } elseif ($check.Ok -or $check.Error -ne $error) { throw "Party click $x,$y expected '$error' but got ok=$($check.Ok) '$($check.Error)'" } }
ExpectParty 25 336 $null                               # centre of the travel button, measured at x 11..38, y 322..349
ExpectParty 11 322 $null
ExpectParty 38 349 $null
ExpectParty 25 640 $null                               # a later party member's button, stacked below the first
ExpectParty 25 229 'Click outside the party frame area'    # above the frame, where the minimap and buffs sit
ExpectParty 25 720 'Click outside the party frame area'    # below the frame, towards the chat panel
ExpectParty 90 336 'Click outside the party frame area'    # right of the measured-clear column
ExpectParty -1 336 'Click outside the party frame area'
ExpectParty 1280 720 'Click outside the party frame area'  # the party area cannot reach the movement disc
function ExpectConfirm($x, $y, $error) { $check = [FollowInput]::Check($x, $y, 2560, 1440, 10, 120, 'confirm'); if ($null -eq $error) { if (-not $check.Ok) { throw "Confirm click $x,$y should be accepted: $($check.Error)" } } elseif ($check.Ok -or $check.Error -ne $error) { throw "Confirm click $x,$y expected '$error' but got ok=$($check.Ok) '$($check.Error)'" } }
ExpectConfirm 1732 764 $null                           # the OK button's centre, measured at x 1595..1870, y 728..800
ExpectConfirm 1595 728 $null
ExpectConfirm 1870 800 $null
ExpectConfirm 948 764 'Click outside the confirm dialog area'   # CANCEL: the one click this area exists to make impossible
ExpectConfirm 1280 720 'Click outside the confirm dialog area'  # the view centre, under the dialog's text
ExpectConfirm 1732 900 'Click outside the confirm dialog area'
ExpectConfirm 1732 600 'Click outside the confirm dialog area'
ExpectConfirm 2048 764 'Click outside the confirm dialog area'
ExpectConfirm 25 336 'Click outside the confirm dialog area'    # never the party frame
if (([FollowInput]::Check(1732, 764, 2560, 1440, 10, 120, 'move')).Error -ne 'Click outside the safe movement area') { throw 'The OK button is 454 px out: a movement click must not reach it' }
if (([FollowInput]::Check(1732, 764, 2560, 1440, 10, 120, 'party')).Error -ne 'Click outside the party frame area') { throw 'A party click must not borrow the confirm area' }
if (([FollowInput]::Check(1732, 764, 2560, 1440, 10, 120, 'confirmation')).Error -ne 'Unknown click area') { throw 'Only the exact area name confirm may click OK' }
if (([FollowInput]::Check(25, 336, 2560, 1440, 10, 120, 'move')).Error -ne 'Click outside the safe movement area') { throw 'A movement click must not borrow the party area' }
if (([FollowInput]::Check(25, 336, 2560, 1440, 10, 120, 'loot')).Error -ne 'Click outside the loot area') { throw 'A loot click must not borrow the party area' }
if (([FollowInput]::Check(25, 336, 2560, 1440, 10, 120, 'partyframe')).Error -ne 'Unknown click area') { throw 'Only the exact area name party may click the travel button' }
if (([FollowInput]::Check(1280, 720, 2560, 1440, 10, 120, 'anywhere')).Error -ne 'Unknown click area') { throw 'Unknown click areas must be refused' }
if (([FollowInput]::Check(790, 185, 2560, 1440, 10, 120, 'move')).Error -ne 'Click outside the safe movement area') { throw 'A movement click must not borrow the loot area' }
Expect 420 500 400 1000 0 120 'Click outside the safe movement area'
if (-not [FollowInput]::Release()) { throw 'Nothing held: release must report success and must not throw' }
$spaceDown = [FollowInput]::Space($true); $spaceUp = [FollowInput]::Space($false)
if ($spaceDown.Type -ne 1 -or $spaceDown.Data.Key.Vk -ne 0x20 -or $spaceDown.Data.Key.Scan -ne 0x39 -or $spaceDown.Data.Key.Flags -ne 0 -or $spaceUp.Data.Key.Flags -ne 2) { throw 'Sprint must be the space key, down then up' }
$escapeDown = [FollowInput]::Escape($true); $escapeUp = [FollowInput]::Escape($false)
if ($escapeDown.Type -ne 1 -or $escapeDown.Data.Key.Vk -ne 0x1B -or $escapeDown.Data.Key.Scan -ne 0x01 -or $escapeDown.Data.Key.Flags -ne 0 -or $escapeUp.Data.Key.Flags -ne 2) { throw 'The tap must be the escape key, down then up' }
if ($escapeUp.Data.Key.Vk -ne 0x1B -or $escapeUp.Data.Key.Scan -ne 0x01) { throw 'The escape up must name the same key as the down' }
if (-not [FollowInput]::ReleaseSprint()) { throw 'Nothing held: releasing sprint must report success and send nothing' }
if ([FollowInput]::SprintRenewMs -gt 500) { throw 'The sprint hold must lapse quickly when it is not renewed' }
# The refusals below are all decided before any window, cursor or key is touched, and nothing is held to release.
function ExpectRefusal($action, $expected) {
  $message = $null
  try { & $action } catch { $message = $_.Exception.Message; if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message } }
  if ($message -ne $expected) { throw "Expected refusal '$expected' but got '$message'" }
}
ExpectRefusal { [FollowInput]::Sprint('0', 2560, 1440, [FollowInput]::QpcMs(), 120, $false) } 'Sprint lapsed'   # a renew never presses
ExpectRefusal { [FollowInput]::MoveClick(1280, 720, '0', 2560, 1440, [FollowInput]::QpcMs() - 1000, 120, 'move') } 'Stale capture'
# An accepted party click cannot be tested here: it would move the cursor and press the button. A refused one is the
# most that can run natively, and the rectangle itself is covered by ExpectParty above and the source checks below.
ExpectRefusal { [FollowInput]::MoveClick(1280, 720, '0', 2560, 1440, [FollowInput]::QpcMs(), 120, 'party') } 'Click outside the party frame area'
# Same for the confirmation's OK button: an accepted click cannot run here, so the refusal at CANCEL's own
# coordinates is what is checked natively, with the rectangle itself covered by ExpectConfirm above.
ExpectRefusal { [FollowInput]::MoveClick(948, 764, '0', 2560, 1440, [FollowInput]::QpcMs(), 120, 'confirm') } 'Click outside the confirm dialog area'
# The escape tap: only the key name and the shared Check() can be exercised here. An accepted tap cannot be tested
# natively - it would press a key in whatever window is focused - so the name refusal and the same staleness and view
# refusals a click gets are what run, and the source checks below cover the batch and the guard order.
ExpectRefusal { [FollowInput]::KeyTap('space', '0', 2560, 1440, [FollowInput]::QpcMs(), 120) } 'Only the escape key may be tapped'
ExpectRefusal { [FollowInput]::KeyTap('Escape', '0', 2560, 1440, [FollowInput]::QpcMs(), 120) } 'Only the escape key may be tapped'
ExpectRefusal { [FollowInput]::KeyTap('escape ', '0', 2560, 1440, [FollowInput]::QpcMs(), 120) } 'Only the escape key may be tapped'
ExpectRefusal { [FollowInput]::KeyTap('', '0', 2560, 1440, [FollowInput]::QpcMs(), 120) } 'Only the escape key may be tapped'
ExpectRefusal { [FollowInput]::KeyTap($null, '0', 2560, 1440, [FollowInput]::QpcMs(), 120) } 'Only the escape key may be tapped'
ExpectRefusal { [FollowInput]::KeyTap('escape', '0', 2560, 1440, [FollowInput]::QpcMs() - 1000, 120) } 'Stale capture'
ExpectRefusal { [FollowInput]::KeyTap('escape', '0', 100, 100, [FollowInput]::QpcMs(), 120) } 'Invalid game view'
ExpectRefusal { [FollowInput]::KeyTap('escape', '0', 2560, 1440, [FollowInput]::QpcMs(), 5000) } 'Invalid freshness limit'
if (-not [FollowInput]::HumanStillActive($true, 5000)) { throw 'A cursor that moved again is still under manual control' }
if (-not [FollowInput]::HumanStillActive($false, 999)) { throw 'A cursor must rest for a full second before following resumes' }
if ([FollowInput]::HumanStillActive($false, 1000)) { throw 'A rested cursor hands control back' }
$source = Get-Content (Join-Path $PSScriptRoot 'win-follower-input-host.ps1') -Raw
if ($source -notmatch 'SendInput\(2, new \[\] \{ Button\(true\), Button\(false\) \}') { throw 'Movement clicks must be one down/up batch' }
if ($source -notmatch 'catch \{ ReleaseSprint\(\); throw; \}' -or $source -notmatch 'expired = spaceHeld && QpcMs\(\) > spaceDeadline') { throw 'Sprint must let go on any refusal and have a watchdog' }
if ($source -notmatch '(?s)if \(!spaceHeld\) \{\s*if \(!start\) throw new Exception\("Sprint lapsed"\);.*?if \(Down\(0x20\)\) throw new Exception\("Space held - manual control"\);.*?Space\(true\)') { throw 'Space may go down only on a start, and never over a human hold' }
if ([regex]::Matches($source, 'Space\(true\)').Count -ne 1) { throw 'There must be exactly one place that presses space' }
if ($source -notmatch 'try \{ GuardedClick\([^)]*\); \} catch \{ ReleaseSprint\(\); throw; \}' -or [regex]::Matches($source, '\bGuardedClick\(').Count -ne 2) { throw 'Every movement-click refusal must let go of sprint' }
if ($source -notmatch '\(\$command\.start -eq \$true\)') { throw 'The sprint op must pass the start flag through' }
if ($source -notmatch 'GetAncestor\(WindowFromPoint\(cursor\), 2\) != window') { throw 'The window under the cursor must be hit-tested before clicking' }
# The party box: tight enough that a mis-aimed click reaches nothing else, and checked before the unknown-area refusal.
if ($source -notmatch 'if \(x < 0 \|\| y < Math\.Round\(viewHeight \* 0\.16\) \|\| x >= Math\.Round\(viewWidth \* 0\.035\) \|\| y >= Math\.Round\(viewHeight \* 0\.50\)\)') { throw 'The party area must be the measured top-left rectangle' }
if ($source -notmatch '(?s)if \(area == "party"\) \{.*?if \(area != "move"\) \{ result\.Error = "Unknown click area"') { throw 'The party area must be matched by exact name, before unknown areas are refused' }
# The confirm box: tight around OK, and structurally unable to hold CANCEL at 0.3703w since it starts at 0.61w.
if ($source -notmatch 'if \(x < Math\.Round\(viewWidth \* 0\.61\) \|\| y < Math\.Round\(viewHeight \* 0\.49\) \|\| x >= Math\.Round\(viewWidth \* 0\.745\) \|\| y >= Math\.Round\(viewHeight \* 0\.57\)\)') { throw 'The confirm area must be the measured box around the OK button' }
if ($source -notmatch '(?s)if \(area == "confirm"\) \{.*?if \(area != "move"\) \{ result\.Error = "Unknown click area"') { throw 'The confirm area must be matched by exact name, before unknown areas are refused' }
# The escape tap: one batch, one place that presses it, the key name refused first, and no pointer touched.
$keyTap = [regex]::Match($source, '(?s)public static void KeyTap\(.*?\} catch \{ ReleaseSprint\(\); throw; \}').Value
if (-not $keyTap) { throw 'The escape tap must be guarded and release sprint on any refusal' }
if ($keyTap -notmatch 'SendInput\(2, new \[\] \{ Escape\(true\), Escape\(false\) \}, size\)') { throw 'An escape tap must be one down/up batch' }
if ([regex]::Matches($source, 'Escape\(true\)').Count -ne 1) { throw 'There must be exactly one place that presses escape' }
if ($keyTap -notmatch '(?s)if \(key != "escape"\) throw new Exception\("Only the escape key may be tapped"\);.*?FollowClickCheck check = Check\(') { throw 'Any other key must be refused before anything else is checked' }
if ($keyTap -notmatch '(?s)FollowClickCheck check = Check\(.*?ThrowIfHumanInput\(\);.*?SendInput\(2,') { throw 'The escape tap must run the same checks a click runs before sending' }
if ($keyTap -match 'SetCursorPos|GetCursorPos|WindowFromPoint|Button\(') { throw 'An escape tap must not move the cursor or touch a mouse button' }
if ($source -notmatch '\[FollowInput\]::KeyTap\(\[string\]\$command\.key, \[string\]\$command\.expectedHwnd, \[int\]\$command\.viewWidth, \[int\]\$command\.viewHeight, \[long\]\$command\.capturedAtQpcMs, \[int\]\$command\.maxAgeMs\)') { throw 'The key op must pass the same guard fields a moveclick passes' }
if ([regex]::Matches($source, '\bKeyTap\(').Count -ne 2) { throw 'KeyTap must be declared once and called from one op' }
foreach ($forbidden in @('CopyFromScreen', 'BitBlt', 'keybd_event', 'SetWindowsHookEx', 'SetForegroundWindow', 'PostMessage')) {
  if ($source -match "\b$forbidden\b") { throw "Movement host must not reference $forbidden" }
}
Write-Output 'Follower input-host synthetic checks passed; no cursor movement, click, or capture.'
