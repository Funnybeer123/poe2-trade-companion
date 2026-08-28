Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct AssistRect { public int Left; public int Top; public int Right; public int Bottom; }
public struct AssistPoint { public int X; public int Y; }
public class AssistiveWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out AssistRect lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref AssistPoint lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out AssistPoint lpPoint);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
"@

function Get-PoeWindow {
  $named = Get-Process | Where-Object {
    $_.ProcessName -match 'PathOfExile' -and [int64]$_.MainWindowHandle -ne 0
  } | Select-Object -First 1
  if ($named) { return $named }
  Get-Process | Where-Object {
    $_.MainWindowTitle -match 'Path of Exile' -and [int64]$_.MainWindowHandle -ne 0
  } | Select-Object -First 1
}

function Get-ClientScreenRect([IntPtr]$hwnd) {
  $client = New-Object AssistRect
  [void][AssistiveWin]::GetClientRect($hwnd, [ref]$client)
  $tl = New-Object AssistPoint
  $tl.X = 0
  $tl.Y = 0
  [void][AssistiveWin]::ClientToScreen($hwnd, [ref]$tl)
  $br = New-Object AssistPoint
  $br.X = $client.Right
  $br.Y = $client.Bottom
  [void][AssistiveWin]::ClientToScreen($hwnd, [ref]$br)
  return @{
    left = $tl.X
    top = $tl.Y
    width = $br.X - $tl.X
    height = $br.Y - $tl.Y
  }
}

$script:OcrReady = $false
function Initialize-Ocr {
  if ($script:OcrReady) { return $true }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $script:OcrEngine) {
      $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
    }
    $script:OcrReady = ($null -ne $script:OcrEngine)
  } catch {
    $script:OcrReady = $false
  }
  return $script:OcrReady
}

function Await-WinRt($operation, $resultType) {
  $task = $script:AsTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  [void]$task.Wait()
  return $task.Result
}

function Invoke-OcrRegion([int]$left, [int]$top, [int]$width, [int]$height) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $writer.WriteBytes($bytes)
  [void](Await-WinRt ($writer.StoreAsync()) ([UInt32]))
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRt ($script:OcrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $lines += @{
      text = [string]$line.Text
      x = [int]($left + $minX)
      y = [int]($top + $minY)
      w = [int]($maxX - $minX)
      h = [int]($maxY - $minY)
    }
  }
  return @{ text = [string]$result.Text; lines = $lines }
}

function Resolve-PinnedPoeWindow {
  if ($script:PinnedPoePid -gt 0 -and $script:PinnedPoeHwnd -ne 0) {
    try {
      $pinned = Get-Process -Id $script:PinnedPoePid -ErrorAction Stop
      $pinned.Refresh()
      if ([int64]$pinned.MainWindowHandle -eq $script:PinnedPoeHwnd) {
        return $pinned
      }
    } catch {}
    return $null
  }
  $found = Get-PoeWindow
  if ($found) {
    $script:PinnedPoePid = [int]$found.Id
    $script:PinnedPoeHwnd = [int64]$found.MainWindowHandle
  }
  return $found
}

function Focus-Poe([IntPtr]$hwnd) {
  [void][AssistiveWin]::ShowWindow($hwnd, 9)
  $fg = [AssistiveWin]::GetForegroundWindow()
  $current = [AssistiveWin]::GetCurrentThreadId()
  $foreThread = [AssistiveWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $poeThread = [AssistiveWin]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
  if ($foreThread -ne $current) {
    [void][AssistiveWin]::AttachThreadInput($current, $foreThread, $true)
  }
  if ($poeThread -ne $current) {
    [void][AssistiveWin]::AttachThreadInput($current, $poeThread, $true)
  }
  [void][AssistiveWin]::BringWindowToTop($hwnd)
  [void][AssistiveWin]::SetForegroundWindow($hwnd)
  $topmost = [IntPtr](-1)
  $notop = [IntPtr](-2)
  [void][AssistiveWin]::SetWindowPos($hwnd, $topmost, 0, 0, 0, 0, 0x0003)
  Start-Sleep -Milliseconds 15
  [void][AssistiveWin]::SetWindowPos($hwnd, $notop, 0, 0, 0, 0, 0x0003)
  if ($poeThread -ne $current) {
    [void][AssistiveWin]::AttachThreadInput($current, $poeThread, $false)
  }
  if ($foreThread -ne $current) {
    [void][AssistiveWin]::AttachThreadInput($current, $foreThread, $false)
  }
  Start-Sleep -Milliseconds 20
  return [AssistiveWin]::GetForegroundWindow() -eq $hwnd
}

function Get-Monitors {
  Add-Type -AssemblyName System.Windows.Forms
  $i = 0
  @([System.Windows.Forms.Screen]::AllScreens) | ForEach-Object {
    $b = $_.Bounds
    $item = @{
      id = $i
      label = $(if ($_.Primary) { "Monitor $($i + 1) (primary) $($b.Width)x$($b.Height)" } else { "Monitor $($i + 1) $($b.Width)x$($b.Height)" })
      device = [string]$_.DeviceName
      primary = [bool]$_.Primary
      left = [int]$b.X
      top = [int]$b.Y
      width = [int]$b.Width
      height = [int]$b.Height
    }
    $i += 1
    $item
  }
}

function Find-MonitorForRect($r) {
  $mons = @(Get-Monitors)
  if ($mons.Count -eq 0) { return $null }
  $cx = [int]$r.left + [math]::Floor([int]$r.width / 2)
  $cy = [int]$r.top + [math]::Floor([int]$r.height / 2)
  foreach ($m in $mons) {
    if ($cx -ge $m.left -and $cx -lt ($m.left + $m.width) -and $cy -ge $m.top -and $cy -lt ($m.top + $m.height)) {
      return $m
    }
  }
  foreach ($m in $mons) {
    if ([int]$r.left -ge $m.left -and [int]$r.left -lt ($m.left + $m.width) -and [int]$r.top -ge $m.top -and [int]$r.top -lt ($m.top + $m.height)) {
      return $m
    }
  }
  $primary = $mons | Where-Object { $_.primary } | Select-Object -First 1
  if ($primary) { return $primary }
  return $mons[0]
}

function Resolve-Client($r, $mw, $mh, $ox, $oy, $forceMonitor) {
  if ($null -eq $ox) { $ox = 0 }
  if ($null -eq $oy) { $oy = 0 }
  if ($forceMonitor -and $mw -gt 0 -and $mh -gt 0) {
    return @{ left = [int]$ox; top = [int]$oy; width = [int]$mw; height = [int]$mh }
  }
  if ($mw -ge 3800 -and $mh -ge 2100 -and $r.width -ge 1800 -and $r.width -le 2000) {
    return @{ left = [int]$ox; top = [int]$oy; width = [int]$mw; height = [int]$mh }
  }
  if ([math]::Abs($r.left - $ox) -le 2 -and [math]::Abs($r.top - $oy) -le 2 -and $r.width -ge ($mw - 4) -and $r.height -ge ($mh - 4)) {
    return @{ left = [int]$ox; top = [int]$oy; width = [int]$mw; height = [int]$mh }
  }
  return $r
}

function Window-Meta([IntPtr]$hwnd, $cmd) {
  $raw = Get-ClientScreenRect $hwnd
  $hit = Find-MonitorForRect $raw
  $force = [bool]$cmd.forceMonitor
  if ($force -and $cmd.monitorWidth) {
    $mw = [int]$cmd.monitorWidth
    $mh = [int]$cmd.monitorHeight
    $ox = [int]$cmd.monitorLeft
    $oy = [int]$cmd.monitorTop
  } elseif ($hit) {
    $mw = [int]$hit.width
    $mh = [int]$hit.height
    $ox = [int]$hit.left
    $oy = [int]$hit.top
  } else {
    $mw = [AssistiveWin]::GetSystemMetrics(0)
    $mh = [AssistiveWin]::GetSystemMetrics(1)
    $ox = 0
    $oy = 0
  }
  $r = Resolve-Client $raw $mw $mh $ox $oy $force
  $dpi = 96
  try { $dpi = [AssistiveWin]::GetDpiForWindow($hwnd) } catch {}
  $fullscreen = ([math]::Abs($r.left - $ox) -le 2 -and [math]::Abs($r.top - $oy) -le 2 -and $r.width -ge ($mw - 4) -and $r.height -ge ($mh - 4))
  $label = if ($hit) { [string]$hit.label } else { "unknown display" }
  return @{
    left = $r.left
    top = $r.top
    width = $r.width
    height = $r.height
    monitorWidth = $mw
    monitorHeight = $mh
    monitorLeft = $ox
    monitorTop = $oy
    monitorLabel = $label
    dpi = $dpi
    displayMode = $(if ($fullscreen) { "fullscreen" } else { "windowed" })
  }
}

function Emit($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
  [Console]::Out.Flush()
}

function Hide-ClickMark {
  if ($script:MarkForm) {
    try { $script:MarkForm.Close() } catch {}
    try { $script:MarkForm.Dispose() } catch {}
    $script:MarkForm = $null
  }
}

function Show-ClickMark([int]$x, [int]$y) {
  Hide-ClickMark
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $size = 48
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Size = New-Object System.Drawing.Size $size, $size
  $form.Location = New-Object System.Drawing.Point ($x - [int]($size / 2)), ($y - [int]($size / 2))
  $form.BackColor = [System.Drawing.Color]::Magenta
  $form.TransparencyKey = [System.Drawing.Color]::Magenta
  $form.Add_Paint({
    param($sender, $e)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 3
    $e.Graphics.DrawLine($pen, 24, 2, 24, 46)
    $e.Graphics.DrawLine($pen, 2, 24, 46, 24)
    $e.Graphics.DrawEllipse($pen, 16, 16, 16, 16)
    $pen.Dispose()
  })
  $form.Show()
  $ex = [AssistiveWin]::GetWindowLong($form.Handle, -20)
  [void][AssistiveWin]::SetWindowLong($form.Handle, -20, $ex -bor 0x80000 -bor 0x20 -bor 0x08000000 -bor 0x8)
  [void][AssistiveWin]::SetWindowPos($form.Handle, [IntPtr](-1), $form.Left, $form.Top, $form.Width, $form.Height, 0x0010)
  $script:MarkForm = $form
}

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [void][AssistiveWin]::SetProcessDpiAwareness(2) } catch {}
$script:PinnedPoePid = 0
$script:PinnedPoeHwnd = [int64]0

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "quit") { break }
  try {
    $cmd = $line | ConvertFrom-Json
  } catch {
    Emit @{ ok = $false; error = "bad-json" }
    continue
  }
  $op = [string]$cmd.op
  if ($op -eq "monitors") {
    Emit @{ ok = $true; monitors = @(Get-Monitors) }
    continue
  }
  $hadPinnedWindow = $script:PinnedPoeHwnd -ne 0
  $proc = Resolve-PinnedPoeWindow
  if (-not $proc) {
    Emit @{ ok = $false; error = $(if ($hadPinnedWindow) { "target-window-lost" } else { "no-poe-window" }) }
    continue
  }
  $hwnd = [IntPtr]$script:PinnedPoeHwnd
  if ($cmd.expectedHwnd -and [int64]$cmd.expectedHwnd -ne $script:PinnedPoeHwnd) {
    Emit @{ ok = $false; error = "target-window-changed"; hwnd = $script:PinnedPoeHwnd }
    continue
  }
  if ($op -eq "rect" -or $op -eq "focus") {
    $focused = $true
    if ($op -eq "focus") {
      $focused = Focus-Poe $hwnd
    }
    $meta = Window-Meta $hwnd $cmd
    $fg = [AssistiveWin]::GetForegroundWindow()
    Emit @{
      ok = $true
      focused = $focused
      left = $meta.left
      top = $meta.top
      width = $meta.width
      height = $meta.height
      monitorWidth = $meta.monitorWidth
      monitorHeight = $meta.monitorHeight
      monitorLeft = $meta.monitorLeft
      monitorTop = $meta.monitorTop
      monitorLabel = $meta.monitorLabel
      dpi = $meta.dpi
      displayMode = $meta.displayMode
      process = $proc.ProcessName
      title = [string]$proc.MainWindowTitle
      hwnd = $script:PinnedPoeHwnd
      foregroundIsPoe = ($fg -eq $hwnd)
    }
    continue
  }
  if ($op -eq "waitkey") {
    # Block until a numpad key (0-9) is pressed while PoE is foreground, or
    # until timeoutMs elapses. Edge-triggered: the key must be seen released
    # first so held keys do not retrigger.
    $timeoutMs = [int]$cmd.timeoutMs
    if ($timeoutMs -le 0) { $timeoutMs = 30000 }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    $armed = @{}
    for ($vk = 0x60; $vk -le 0x69; $vk++) { $armed[$vk] = $false }
    $hit = -1
    while ([DateTime]::UtcNow -lt $deadline) {
      $fg = ([AssistiveWin]::GetForegroundWindow() -eq $hwnd)
      for ($vk = 0x60; $vk -le 0x69; $vk++) {
        $down = ([AssistiveWin]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
        if (-not $down) { $armed[$vk] = $true }
        elseif ($armed[$vk] -and $fg) { $hit = $vk - 0x60; break }
      }
      if ($hit -ge 0) { break }
      Start-Sleep -Milliseconds 35
    }
    if ($hit -ge 0) {
      Emit @{ ok = $true; key = $hit }
    } else {
      Emit @{ ok = $false; error = "timeout" }
    }
    continue
  }
  if ($op -eq "wheel") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $steps = [int]$cmd.steps
    if ($steps -eq 0) { $steps = 1 }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 16
    $direction = if ($steps -gt 0) { 120 } else { -120 }
    for ($i = 0; $i -lt [Math]::Abs($steps); $i++) {
      [AssistiveWin]::mouse_event(0x0800, 0, 0, [uint32]($direction -band 0xFFFFFFFF), [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
    }
    Emit @{ ok = $true; x = $x; y = $y; steps = $steps }
    continue
  }
  if ($op -eq "ocr") {
    if (-not (Initialize-Ocr)) {
      Emit @{ ok = $false; error = "ocr-unavailable" }
      continue
    }
    $meta = Window-Meta $hwnd $cmd
    $ox = if ($null -ne $cmd.left) { [int]$cmd.left } else { [int]$meta.left }
    $oy = if ($null -ne $cmd.top) { [int]$cmd.top } else { [int]$meta.top }
    $ow = if ($null -ne $cmd.width) { [int]$cmd.width } else { [int]$meta.width }
    $oh = if ($null -ne $cmd.height) { [int]$cmd.height } else { [int]$meta.height }
    if ($ow -lt 4 -or $oh -lt 4) {
      Emit @{ ok = $false; error = "ocr-region-too-small" }
      continue
    }
    try {
      $ocr = Invoke-OcrRegion $ox $oy $ow $oh
      Emit @{ ok = $true; text = $ocr.text; lines = @($ocr.lines) }
    } catch {
      Emit @{ ok = $false; error = "ocr-failed"; detail = [string]$_.Exception.Message }
    }
    continue
  }
  if ($op -eq "capture") {
    if ([bool]$cmd.requireForeground -and [AssistiveWin]::GetForegroundWindow() -ne $hwnd) {
      Emit @{ ok = $false; error = "focus-lost"; focused = $false }
      continue
    }
    $path = [string]$cmd.path
    if (-not $path) {
      Emit @{ ok = $false; error = "missing-path" }
      continue
    }
    $meta = Window-Meta $hwnd $cmd
    $r = @{ left = $meta.left; top = $meta.top; width = $meta.width; height = $meta.height }
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap ([int]$r.width), ([int]$r.height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$r.left, [int]$r.top, 0, 0, $bmp.Size)
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $previewPath = [string]$cmd.previewPath
    if ($previewPath) {
      $previewDir = Split-Path -Parent $previewPath
      if ($previewDir -and -not (Test-Path $previewDir)) {
        New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
      }
      $bmp.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $g.Dispose()
    $bmp.Dispose()
    Emit @{ ok = $true; path = $path; previewPath = $previewPath; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $false }
    continue
  }
  $requireForeground = [bool]$cmd.requireForeground
  if ($requireForeground) {
    $focused = ([AssistiveWin]::GetForegroundWindow() -eq $hwnd)
    if (-not $focused) {
      Emit @{ ok = $false; error = "focus-lost"; focused = $false }
      continue
    }
  } else {
    $focused = Focus-Poe $hwnd
    if (-not $focused) {
      Emit @{ ok = $false; error = "focus-failed"; focused = $false }
      continue
    }
  }
  $meta = Window-Meta $hwnd $cmd
  $r = @{ left = $meta.left; top = $meta.top; width = $meta.width; height = $meta.height }
  if ($op -eq "ctrlburst") {
    $points = @($cmd.points)
    if ($points.Count -lt 1) {
      Emit @{ ok = $false; error = "missing-points" }
      continue
    }
    $pad = 8
    $valid = @()
    $rejected = $false
    foreach ($p in $points) {
      $x = [int]$p.x
      $y = [int]$p.y
      if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        $rejected = $true
        break
      }
      $valid += @{ x = $x; y = $y }
    }
    if ($rejected) { continue }
    $shift = [bool]$cmd.shift
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    }
    [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
    $focusLost = $false
    $emitted = 0
    foreach ($p in $valid) {
      if ($requireForeground -and [AssistiveWin]::GetForegroundWindow() -ne $hwnd) {
        $focusLost = $true
        break
      }
      [void][AssistiveWin]::SetCursorPos([int]$p.x, [int]$p.y)
      Start-Sleep -Milliseconds 12
      [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 8
      [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      $emitted += 1
      Start-Sleep -Milliseconds 12
    }
    Start-Sleep -Milliseconds 40
    [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
    if ($focusLost) {
      Emit @{ ok = $false; error = "focus-lost"; focused = $false; count = $emitted }
    } else {
      Emit @{ ok = $true; focused = $focused; count = $emitted }
    }
    continue
  }
  if ($op -eq "move") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $pad = 8
    if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
      Emit @{ ok = $false; error = "move-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
      continue
    }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 80
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y }
    continue
  }
  if ($op -eq "rightclick") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $pad = 8
    if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
      Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
      continue
    }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 16
    [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
    [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y }
    continue
  }
  if ($op -eq "click" -or $op -eq "ctrlclick" -or $op -eq "shiftctrlclick") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $pad = 8
    if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
      Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
      continue
    }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 12
    $ctrl = $op -eq "ctrlclick" -or $op -eq "shiftctrlclick"
    $shift = $op -eq "shiftctrlclick" -or [bool]$cmd.shift
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    }
    if ($ctrl) {
      [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 8
    }
    [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
    [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($ctrl) {
      Start-Sleep -Milliseconds 6
      [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    }
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y }
    continue
  }
  if ($op -eq "drag") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $x2 = [int]$cmd.x2
    $y2 = [int]$cmd.y2
    $pad = 8
    if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad) -or $x2 -lt ($r.left + $pad) -or $x2 -gt ($r.left + $r.width - $pad) -or $y2 -lt ($r.top + $pad) -or $y2 -gt ($r.top + $r.height - $pad)) {
      Emit @{ ok = $false; error = "drag-outside-client"; x = $x; y = $y; x2 = $x2; y2 = $y2; focused = $focused }
      continue
    }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 18
    [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [void][AssistiveWin]::SetCursorPos($x2, $y2)
    Start-Sleep -Milliseconds 22
    [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y; x2 = $x2; y2 = $y2 }
    continue
  }
  if ($op -eq "clipboard") {
    $text = ""
    try {
      $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    } catch {
      $text = ""
    }
    if ($null -eq $text) { $text = "" }
    Emit @{ ok = $true; text = [string]$text }
    continue
  }
  if ($op -eq "setclipboard") {
    try {
      Set-Clipboard -Value ([string]$cmd.text)
      Emit @{ ok = $true }
    } catch {
      Emit @{ ok = $false; error = "set-clipboard-failed" }
    }
    continue
  }
  if ($op -eq "mark") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Show-ClickMark $x $y
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y }
    continue
  }
  if ($op -eq "hidemark") {
    Hide-ClickMark
    Emit @{ ok = $true }
    continue
  }
  if ($op -eq "waitclick") {
    $timeout = 25000
    if ($cmd.timeoutMs) { $timeout = [int]$cmd.timeoutMs }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
    while ([AssistiveWin]::GetAsyncKeyState(1) -lt 0) {
      if ($script:MarkForm) { [System.Windows.Forms.Application]::DoEvents() }
      Start-Sleep -Milliseconds 20
      if ([DateTime]::UtcNow -gt $deadline) { break }
    }
    $got = $false
    $pt = New-Object AssistPoint
    $pad = 8
    while ([DateTime]::UtcNow -le $deadline) {
      if ($script:MarkForm) { [System.Windows.Forms.Application]::DoEvents() }
      if ([AssistiveWin]::GetAsyncKeyState(1) -lt 0) {
        [void][AssistiveWin]::GetCursorPos([ref]$pt)
        if ($pt.X -ge ($r.left + $pad) -and $pt.X -le ($r.left + $r.width - $pad) -and $pt.Y -ge ($r.top + $pad) -and $pt.Y -le ($r.top + $r.height - $pad)) {
          $got = $true
          break
        }
        while ([AssistiveWin]::GetAsyncKeyState(1) -lt 0 -and [DateTime]::UtcNow -le $deadline) {
          if ($script:MarkForm) { [System.Windows.Forms.Application]::DoEvents() }
          Start-Sleep -Milliseconds 20
        }
      }
      Start-Sleep -Milliseconds 20
    }
    Hide-ClickMark
    if ($got) {
      Emit @{ ok = $true; focused = $focused; x = $pt.X; y = $pt.Y }
    } else {
      Emit @{ ok = $false; error = "waitclick-timeout"; focused = $focused }
    }
    continue
  }
  if ($op -eq "hotkey") {
    $keys = [string]$cmd.keys
    if ($keys -eq "ctrlc") {
      [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
      [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    } elseif ($keys -eq "ctrla") {
      [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 12
      [AssistiveWin]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 12
      [AssistiveWin]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero)
      [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    } elseif ($keys -eq "backspace") {
      [AssistiveWin]::keybd_event(0x08, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 16
      [AssistiveWin]::keybd_event(0x08, 0, 2, [UIntPtr]::Zero)
    } elseif ($keys -eq "i") {
      [AssistiveWin]::keybd_event(0x49, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::keybd_event(0x49, 0, 2, [UIntPtr]::Zero)
    } elseif ($keys -eq "escape") {
      [AssistiveWin]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
    } elseif ($keys -eq "enter") {
      [AssistiveWin]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
    } else {
      Emit @{ ok = $false; error = "unsupported-hotkey"; focused = $focused }
      continue
    }
    Emit @{ ok = $true; focused = $focused }
    continue
  }
  if ($op -eq "type") {
    $text = [string]$cmd.text
    foreach ($ch in $text.ToCharArray()) {
      if ($ch -eq ' ') {
        [AssistiveWin]::keybd_event(0x20, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event(0x20, 0, 2, [UIntPtr]::Zero)
      } elseif ($ch -ge 'A' -and $ch -le 'Z') {
        [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
        [AssistiveWin]::keybd_event([byte][char]$ch, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event([byte][char]$ch, 0, 2, [UIntPtr]::Zero)
        [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
      } elseif ($ch -ge 'a' -and $ch -le 'z') {
        $vk = [byte][int][char]([char]::ToUpper($ch))
        [AssistiveWin]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
      } elseif ($ch -ge '0' -and $ch -le '9') {
        [AssistiveWin]::keybd_event([byte][char]$ch, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event([byte][char]$ch, 0, 2, [UIntPtr]::Zero)
      } else {
        continue
      }
      Start-Sleep -Milliseconds 10
    }
    Emit @{ ok = $true; focused = $focused }
    continue
  }
  Emit @{ ok = $false; error = "unknown-op" }
}
