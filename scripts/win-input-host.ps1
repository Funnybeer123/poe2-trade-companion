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

function Test-WaystoneCopyComplete([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $false }
  if ($text -match '(?m)^\s*(?:Twice\s+)?Corrupted\s*$') { return $true }
  if ($text -match '(?m)^\s*Unidentified\s*$') { return $true }
  if ($text -match 'Can be used in a Map Device') { return $true }
  return $false
}

function Test-CurrencyCopyComplete([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $false }
  if ($text -notmatch 'Item Class:\s*(?:Stackable\s+)?Currency') { return $false }
  if ($text -match 'Stack Size:') { return $true }
  return $false
}

function Test-HeldWaystone([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $false }
  return $text -match 'Item Class:\s*Waystones'
}

function Test-HeldExpectedOrb([string]$text, [string]$expect) {
  if ([string]::IsNullOrEmpty($text)) { return $false }
  if (Test-HeldWaystone $text) { return $false }
  if ($text -notmatch 'Item Class:\s*(?:Stackable\s+)?Currency') { return $false }
  if ($expect -and $text -notmatch [regex]::Escape($expect)) { return $false }
  return $true
}

function Test-ItemTextCorrupted([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $false }
  return $text -match '(?m)^\s*(?:Twice\s+)?Corrupted\s*$'
}

function Test-WaystoneTier15([string]$text) {
  if (-not (Test-HeldWaystone $text)) { return $false }
  return $text -match 'Tier 15' -or $text -match 'Waystone Tier:\s*15'
}

function Copy-HoveredItemText([int]$x, [int]$y, [int]$hoverMs, [int]$waitMs, [string]$sentinel, [bool]$fast) {
  if ($hoverMs -le 0) { $hoverMs = 50 }
  if ($waitMs -le 0) { $waitMs = 160 }
  if (-not $sentinel) { $sentinel = "poe2-copy-sentinel" }
  [void][AssistiveWin]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds $hoverMs
  try { Set-Clipboard -Value $sentinel -ErrorAction SilentlyContinue } catch {}
  [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 8
  [AssistiveWin]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 8
  [AssistiveWin]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
  [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  $text = $sentinel
  $stable = ""
  $stableHits = 0
  $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($fast) { Start-Sleep -Milliseconds 10 } else { Start-Sleep -Milliseconds 16 }
    $got = $sentinel
    try { $got = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $got = $sentinel }
    if ($null -eq $got) { $got = "" }
    if ($got -eq $sentinel -or $got -eq "") { continue }
    $text = $got
    if ($fast) { break }
    if ($got -eq $stable) { $stableHits += 1 } else { $stable = $got; $stableHits = 1 }
    if ((Test-WaystoneCopyComplete $got) -and $stableHits -ge 1) { break }
    if ((Test-CurrencyCopyComplete $got) -and $stableHits -ge 1) { break }
    if ($stableHits -ge 2 -and $got.Length -gt 80) { break }
  }
  if ($text -eq $sentinel) { return "" }
  return [string]$text
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

function Invoke-OcrRegion([int]$left, [int]$top, [int]$width, [int]$height, [int]$scale = 1, [bool]$invert = $false, [int]$textThreshold = 0, [bool]$neutralContext = $false) {
  Add-Type -AssemblyName System.Drawing
  $grab = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($grab)
  $g.CopyFromScreen($left, $top, 0, 0, $grab.Size)
  $g.Dispose()
  if ($textThreshold -ge 40 -and $textThreshold -le 240) {
    if (-not ("StashOcrTextMask" -as [type])) {
      Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System.Drawing;
public static class StashOcrTextMask {
  public static void Apply(Bitmap bitmap, int threshold) {
    for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
      Color c = bitmap.GetPixel(x, y);
      bitmap.SetPixel(x, y, System.Math.Max(c.R, System.Math.Max(c.G, c.B)) >= threshold ? Color.Black : Color.White);
    }
  }
}
"@
    }
    [StashOcrTextMask]::Apply($grab, $textThreshold)
  }
  if ($invert) {
    $flipped = New-Object System.Drawing.Bitmap $width, $height
    $flipGraphics = [System.Drawing.Graphics]::FromImage($flipped)
    $matrix = New-Object System.Drawing.Imaging.ColorMatrix
    $matrix.Matrix00 = -1; $matrix.Matrix11 = -1; $matrix.Matrix22 = -1
    $matrix.Matrix40 = 1; $matrix.Matrix41 = 1; $matrix.Matrix42 = 1
    $attributes = New-Object System.Drawing.Imaging.ImageAttributes
    $attributes.SetColorMatrix($matrix)
    $flipGraphics.DrawImage($grab, (New-Object System.Drawing.Rectangle 0, 0, $width, $height), 0, 0, $width, $height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
    $attributes.Dispose(); $flipGraphics.Dispose(); $grab.Dispose()
    $grab = $flipped
  }
  $padX = 0; $padY = 0
  if ($neutralContext) {
    # Windows OCR often drops lone letters. Neutral neighbouring words supply
    # line context; only boxes wholly inside the actual screen crop survive.
    $padX = 110; $padY = 40
    $padded = New-Object System.Drawing.Bitmap ($width + 2 * $padX), ($height + 2 * $padY)
    $contextGraphics = [System.Drawing.Graphics]::FromImage($padded)
    $contextGraphics.Clear([System.Drawing.Color]::White)
    $contextGraphics.DrawImageUnscaled($grab, $padX, $padY)
    $font = New-Object System.Drawing.Font 'Arial', 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $anchorY = $padY + [Math]::Max(0, ($height - 35) / 2)
    $contextGraphics.DrawString('tab', $font, [System.Drawing.Brushes]::Black, 24, $anchorY)
    $contextGraphics.DrawString('tab', $font, [System.Drawing.Brushes]::Black, ($padX + $width + 24), $anchorY)
    $font.Dispose(); $contextGraphics.Dispose(); $grab.Dispose()
    $grab = $padded
  }
  $bmp = $grab
  if ($scale -gt 1) {
    # Upscale before recognition: small glyphs (the tooltip's "1x" amount)
    # never OCR at native size but read fine at 2x. Coordinates are mapped
    # back to screen space below.
    $bmp = New-Object System.Drawing.Bitmap ($grab.Width * $scale), ($grab.Height * $scale)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($grab, 0, 0, ($grab.Width * $scale), ($grab.Height * $scale))
    $g2.Dispose()
    $grab.Dispose()
  }
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
    $wordBoxes = @()
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($neutralContext -and ($r.X -lt ($padX * $scale) -or ($r.X + $r.Width) -gt (($padX + $width) * $scale) -or $r.Y -lt ($padY * $scale) -or ($r.Y + $r.Height) -gt (($padY + $height) * $scale))) { continue }
      $wordBoxes += @{
        text = [string]$word.Text
        x = [int]($left + ($r.X / $scale) - $padX)
        y = [int]($top + ($r.Y / $scale) - $padY)
        w = [int]($r.Width / $scale)
        h = [int]($r.Height / $scale)
      }
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($wordBoxes.Count -eq 0) { continue }
    $lines += @{
      text = if ($neutralContext) { [string](($wordBoxes | ForEach-Object { $_.text }) -join ' ') } else { [string]$line.Text }
      x = [int]($left + ($minX / $scale) - $padX)
      y = [int]($top + ($minY / $scale) - $padY)
      w = [int](($maxX - $minX) / $scale)
      h = [int](($maxY - $minY) / $scale)
      words = $wordBoxes
    }
  }
  return @{ text = if ($neutralContext) { [string](($lines | ForEach-Object { $_.text }) -join ' ') } else { [string]$result.Text }; lines = $lines }
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
  # Apply layered/click-through/NO-ACTIVATE styles BEFORE showing: showing an
  # activatable window steals focus from the fullscreen game for a moment,
  # which closes its panels and makes follow-up clicks land outside the game.
  $null = $form.Handle
  $ex = [AssistiveWin]::GetWindowLong($form.Handle, -20)
  [void][AssistiveWin]::SetWindowLong($form.Handle, -20, $ex -bor 0x80000 -bor 0x20 -bor 0x08000000 -bor 0x8)
  $form.Show()
  [void][AssistiveWin]::SetWindowPos($form.Handle, [IntPtr](-1), $form.Left, $form.Top, $form.Width, $form.Height, 0x0010)
  $script:MarkForm = $form
}

function Show-Marks($rects) {
  Hide-ClickMark
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point $screen.X, $screen.Y
  $form.Size = New-Object System.Drawing.Size $screen.Width, $screen.Height
  $form.BackColor = [System.Drawing.Color]::Magenta
  $form.TransparencyKey = [System.Drawing.Color]::Magenta
  $local = @($rects)
  $form.Add_Paint({
    param($sender, $e)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 3
    $redPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 3
    $font = New-Object System.Drawing.Font "Consolas", 14, ([System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Yellow)
    $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 10, 10, 10))
    $li = 0
    foreach ($r in $local) {
      $p = if ([string]$r.kind -eq "click") { $redPen } else { $pen }
      $e.Graphics.DrawRectangle($p, [int]$r.x, [int]$r.y, [int]$r.w, [int]$r.h)
      if ($r.label) {
        # Solid backing plate + per-label vertical offset so text never stacks.
        $tx = [int]$r.x
        $ty = [int]$r.y - 30 - ($li * 30)
        if ($ty -lt 4) { $ty = [int]$r.y + [int]$r.h + 6 + ($li * 30) }
        $size = $e.Graphics.MeasureString([string]$r.label, $font)
        $e.Graphics.FillRectangle($back, $tx - 4, $ty - 2, $size.Width + 8, $size.Height + 4)
        $e.Graphics.DrawString([string]$r.label, $font, $brush, $tx, $ty)
        $li += 1
      }
    }
    $pen.Dispose(); $redPen.Dispose(); $font.Dispose(); $brush.Dispose(); $back.Dispose()
  })
  # Styles BEFORE Show() — see Show-ClickMark: an activatable overlay steals
  # focus from the game and closes its panels.
  $null = $form.Handle
  $ex = [AssistiveWin]::GetWindowLong($form.Handle, -20)
  [void][AssistiveWin]::SetWindowLong($form.Handle, -20, $ex -bor 0x80000 -bor 0x20 -bor 0x08000000 -bor 0x8)
  $form.Show()
  [void][AssistiveWin]::SetWindowPos($form.Handle, [IntPtr](-1), $form.Left, $form.Top, $form.Width, $form.Height, 0x0010)
  [System.Windows.Forms.Application]::DoEvents()
  $script:MarkForm = $form
}

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [void][AssistiveWin]::SetProcessDpiAwareness(2) } catch {}
$script:PinnedPoePid = 0
$script:PinnedPoeHwnd = [int64]0

# Unshifted OEM virtual-key codes (US layout) so `type` can send the punctuation
# that appears in stash tab names instead of silently dropping it.
$OemKeys = @{
  ([char]'-') = [byte]0xBD
  ([char]'=') = [byte]0xBB
  ([char]'[') = [byte]0xDB
  ([char]']') = [byte]0xDD
  ([char]';') = [byte]0xBA
  ([char]"'") = [byte]0xDE
  ([char]',') = [byte]0xBC
  ([char]'.') = [byte]0xBE
  ([char]'/') = [byte]0xBF
  ([char]'\') = [byte]0xDC
  ([char]'`') = [byte]0xC0
}

# Shifted characters (US layout): shift is held around the base virtual key.
# Stash search queries need ", :, (, ), | at minimum.
$ShiftKeys = @{
  ([char]'"') = [byte]0xDE
  ([char]':') = [byte]0xBA
  ([char]'(') = [byte]0x39
  ([char]')') = [byte]0x30
  ([char]'|') = [byte]0xDC
  ([char]'?') = [byte]0xBF
  ([char]'~') = [byte]0xC0
  ([char]'_') = [byte]0xBD
  ([char]'+') = [byte]0xBB
  ([char]'!') = [byte]0x31
  ([char]'#') = [byte]0x33
  ([char]'$') = [byte]0x34
  ([char]'%') = [byte]0x35
  ([char]'&') = [byte]0x37
  ([char]'*') = [byte]0x38
  ([char]'<') = [byte]0xBC
  ([char]'>') = [byte]0xBE
  ([char]'{') = [byte]0xDB
  ([char]'}') = [byte]0xDD
}

# Read the next command WITHOUT starving the overlay: a blocking ReadLine
# leaves the full-screen mark form's message queue unserviced, and Windows
# declares a window "Not Responding" after ~5s of that — exactly what a
# step-mode bullseye waiting on Numpad 8 does (WER AppHangB1, 2026-09-02).
# The read runs as a task; while it is pending the form gets DoEvents.
# NOT [Console]::In.ReadLineAsync(): PowerShell 5.1 wraps Console.In in a
# SyncTextReader whose "async" methods run inline and block. A StreamReader
# over the raw stdin stream reads on the thread pool for real.
$script:StdinReader = New-Object System.IO.StreamReader(
  [Console]::OpenStandardInput(),
  (New-Object System.Text.UTF8Encoding($false))
)
function Read-CommandLine {
  $task = $script:StdinReader.ReadLineAsync()
  while (-not $task.Wait(15)) {
    if ($script:MarkForm) {
      try { [System.Windows.Forms.Application]::DoEvents() } catch {}
    }
  }
  return $task.Result
}

while ($true) {
  $line = Read-CommandLine
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
  if ($op -eq "cursor") {
    # Report the current mouse position without touching anything. Used by
    # calibration tools that treat the user's own pointer as the measuring
    # instrument ("hover the corner, press a key").
    $pt = New-Object AssistPoint
    [void][AssistiveWin]::GetCursorPos([ref]$pt)
    Emit @{ ok = $true; x = $pt.X; y = $pt.Y }
    continue
  }
  if ($op -eq "waitkey") {
    # Block until a numpad key (0-9) is pressed while PoE is foreground, or
    # until timeoutMs elapses. Edge-triggered: the key must be seen released
    # first so held keys do not retrigger.
    $timeoutMs = [int]$cmd.timeoutMs
    if ($timeoutMs -le 0) { $timeoutMs = 30000 }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    # Numpad 0-9 report as 0-9; Numpad + (0x6B) as 10; Numpad - (0x6D) as 11.
    $keys = @(0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6B,0x6D)
    $armed = @{}
    foreach ($vk in $keys) { $armed[$vk] = $false }
    $hit = -1
    while ([DateTime]::UtcNow -lt $deadline) {
      $fg = ([AssistiveWin]::GetForegroundWindow() -eq $hwnd)
      foreach ($vk in $keys) {
        $down = ([AssistiveWin]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
        if (-not $down) { $armed[$vk] = $true }
        elseif ($armed[$vk] -and $fg) {
          if ($vk -eq 0x6B) { $hit = 10 } elseif ($vk -eq 0x6D) { $hit = 11 } else { $hit = $vk - 0x60 }
          break
        }
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
    # holdAlt: the game only renders interactable nameplates while the
    # highlight key is held — hold Alt across the capture so world labels
    # (Stash, NPCs, portals) exist for the OCR to read.
    $holdAlt = [bool]$cmd.holdAlt
    if ($holdAlt) {
      [AssistiveWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 180
    }
    $scale = if ($null -ne $cmd.scale) { [int]$cmd.scale } else { 1 }
    if ($scale -lt 1) { $scale = 1 }
    if ($scale -gt 4) { $scale = 4 }
    try {
      $ocr = Invoke-OcrRegion $ox $oy $ow $oh $scale ([bool]$cmd.invert) ([int]$cmd.textThreshold) ([bool]$cmd.neutralContext)
      Emit @{ ok = $true; text = $ocr.text; lines = @($ocr.lines) }
    } catch {
      Emit @{ ok = $false; error = "ocr-failed"; detail = [string]$_.Exception.Message }
    } finally {
      if ($holdAlt) {
        [AssistiveWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      }
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
  if ($op -eq "pixwait") {
    # Pixel change-detection over a screen region: optionally wait for the
    # region to CHANGE from its baseline (waitChangeMs), then for it to hold
    # STABLE (stableMs of consecutive identical hashes). Replaces fixed
    # navigation sleeps — a tab switch repaints the grid strip in ~200-400ms,
    # so callers return as soon as the game has actually acted instead of
    # sleeping a worst-case 1000ms every time.
    $px = [int]$cmd.left; $py = [int]$cmd.top
    $pw = [int]$cmd.width; $ph = [int]$cmd.height
    if ($pw -lt 4 -or $ph -lt 4) {
      Emit @{ ok = $false; error = "pixwait-region-too-small" }
      continue
    }
    $waitChangeMs = [int]$cmd.waitChangeMs
    $stableMs = [int]$cmd.stableMs
    $intervalMs = if ($cmd.intervalMs) { [int]$cmd.intervalMs } else { 70 }
    Add-Type -AssemblyName System.Drawing
    $pbmp = New-Object System.Drawing.Bitmap $pw, $ph
    $pg = [System.Drawing.Graphics]::FromImage($pbmp)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $grab = {
      $pg.CopyFromScreen($px, $py, 0, 0, $pbmp.Size)
      $rect = New-Object System.Drawing.Rectangle 0, 0, $pw, $ph
      $data = $pbmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $pbmp.PixelFormat)
      try {
        $bytes = New-Object byte[] ([Math]::Abs($data.Stride) * $ph)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        return [Convert]::ToBase64String($md5.ComputeHash($bytes))
      } finally {
        $pbmp.UnlockBits($data)
      }
    }
    $started = [DateTime]::UtcNow
    $baseline = & $grab
    $changed = $false
    if ($waitChangeMs -gt 0) {
      $deadline = $started.AddMilliseconds($waitChangeMs)
      while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds $intervalMs
        if ((& $grab) -ne $baseline) { $changed = $true; break }
      }
    }
    if ($stableMs -gt 0) {
      # Total stability budget: don't spin forever on an animating region.
      $stableDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1500, $stableMs * 4))
      $last = & $grab
      $stableSince = [DateTime]::UtcNow
      while ([DateTime]::UtcNow -lt $stableDeadline) {
        Start-Sleep -Milliseconds $intervalMs
        $now = & $grab
        if ($now -ne $last) {
          $last = $now
          $stableSince = [DateTime]::UtcNow
        } elseif (([DateTime]::UtcNow - $stableSince).TotalMilliseconds -ge $stableMs) {
          break
        }
      }
    }
    $pg.Dispose(); $pbmp.Dispose(); $md5.Dispose()
    Emit @{ ok = $true; changed = $changed; ms = [int](([DateTime]::UtcNow - $started).TotalMilliseconds) }
    continue
  }
  if ($op -eq "copysweep") {
    # Batched hover + Ctrl+C item reads: one request sweeps many cells with a
    # single clipboard save/restore and adaptive polling (returns as soon as
    # the copy lands). This is the sorter's identification hot path — per-op
    # IPC round trips per cell made scans 3-4x slower.
    $points = @($cmd.points)
    if ($points.Count -lt 1) {
      Emit @{ ok = $false; error = "missing-points" }
      continue
    }
    $hover = if ($cmd.hoverMs) { [int]$cmd.hoverMs } else { 55 }
    $waitMs = if ($cmd.copyWaitMs) { [int]$cmd.copyWaitMs } else { 160 }
    $fast = $true
    if ($null -ne $cmd.fast) { $fast = [bool]$cmd.fast }
    $sentinel = [string]$cmd.sentinel
    if (-not $sentinel) { $sentinel = "poe2-copysweep-sentinel" }
    $orig = ""
    try { $orig = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $orig = "" }
    if ($null -eq $orig) { $orig = "" }
    $texts = New-Object System.Collections.ArrayList
    foreach ($p in $points) {
      $text = Copy-HoveredItemText ([int]$p.x) ([int]$p.y) $hover $waitMs $sentinel $fast
      [void]$texts.Add([string]$text)
    }
    try { Set-Clipboard -Value $orig -ErrorAction SilentlyContinue } catch {}
    Emit @{ ok = $true; texts = @($texts); count = $texts.Count }
    continue
  }
  if ($op -eq "clickburst") {
    # Plain left-click burst with an OPTIONAL shift hold across the whole
    # burst (identify chains need shift HELD, not tapped per click — a
    # per-click shift press/release cancels the game's repeat-use mode).
    # gapMs paces the clicks for actions the game must process in between.
    $points = @($cmd.points)
    if ($points.Count -lt 1) {
      Emit @{ ok = $false; error = "missing-points" }
      continue
    }
    $gap = if ($cmd.gapMs) { [int]$cmd.gapMs } else { 25 }
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
      Start-Sleep -Milliseconds 20
    }
    $focusLost = $false
    $emitted = 0
    foreach ($p in $valid) {
      if ($requireForeground -and [AssistiveWin]::GetForegroundWindow() -ne $hwnd) {
        $focusLost = $true
        break
      }
      [void][AssistiveWin]::SetCursorPos([int]$p.x, [int]$p.y)
      Start-Sleep -Milliseconds 14
      [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 8
      [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      $emitted += 1
      Start-Sleep -Milliseconds $gap
    }
    if ($shift) {
      Start-Sleep -Milliseconds 30
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
    if ($focusLost) {
      Emit @{ ok = $false; error = "focus-lost"; focused = $false; count = $emitted }
    } else {
      Emit @{ ok = $true; focused = $focused; count = $emitted }
    }
    continue
  }
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
    $shift = [bool]$cmd.shift
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    }
    [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
    [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    if ($shift) {
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
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
  if ($op -eq "shiftburst") {
    $x = [int]$cmd.x
    $y = [int]$cmd.y
    $count = [int]$cmd.count
    if ($count -lt 1) { $count = 1 }
    if ($count -gt 8) { $count = 8 }
    $gap = [int]$cmd.gapMs
    if ($gap -lt 80) { $gap = 200 }
    $pad = 8
    $pickupX = $cmd.pickupX
    $pickupY = $cmd.pickupY
    $hasPickup = $null -ne $pickupX -and $null -ne $pickupY
    if ($hasPickup) {
      $px = [int]$pickupX
      $py = [int]$pickupY
      if ($px -lt ($r.left + $pad) -or $px -gt ($r.left + $r.width - $pad) -or $py -lt ($r.top + $pad) -or $py -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $px; y = $py; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        continue
      }
    }
    if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
      Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
      continue
    }
    # Hold Shift before any click so PoE keeps the currency on the cursor.
    [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    if ($hasPickup) {
      [void][AssistiveWin]::SetCursorPos([int]$pickupX, [int]$pickupY)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 8
      [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
    }
    [void][AssistiveWin]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 20
    $emitted = 0
    for ($i = 0; $i -lt $count; $i++) {
      [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 10
      [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      $emitted += 1
      Start-Sleep -Milliseconds $gap
    }
    [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    Emit @{ ok = $true; focused = $focused; x = $x; y = $y; count = $emitted }
    continue
  }
  if ($op -eq "orbbatch") {
    # One right-click starts use-mode. Shift stays down so later bag stacks
    # feed — do NOT restock mid-batch (that puts the orb away, and the next
    # well click picks up the waystone). After every slam, Ctrl+C that well.
    # If the well is empty, Ctrl+C an empty bag cell: a waystone there means
    # we picked the map up and must stop before touching another pile.
    $points = @($cmd.points)
    $gap = [int]$cmd.gapMs
    if ($gap -le 0) { $gap = 65 }
    if ($gap -lt 50) { $gap = 50 }
    $pickupMs = [int]$cmd.pickupMs
    if ($pickupMs -le 0) { $pickupMs = 120 }
    $useShift = $true
    if ($null -ne $cmd.shift) { $useShift = [bool]$cmd.shift }
    $expect = [string]$cmd.expect
    $probeX = 0
    $probeY = 0
    if ($null -ne $cmd.probeX) { $probeX = [int]$cmd.probeX }
    if ($null -ne $cmd.probeY) { $probeY = [int]$cmd.probeY }
    $hasProbe = ($probeX -gt 0 -and $probeY -gt 0)
    $pad = 8
    if ($points.Count -lt 1) {
      Emit @{ ok = $true; focused = $focused; count = 0; emptyCursor = $false; heldWaystone = $false; verified = 0 }
      continue
    }
    $pickups = New-Object System.Collections.Generic.List[object]
    if ($null -ne $cmd.pickups) {
      foreach ($u in @($cmd.pickups)) {
        $pickups.Add(@{ x = [int]$u.x; y = [int]$u.y; count = [int]$u.count })
      }
    } elseif ($null -ne $cmd.pickupX -and $null -ne $cmd.pickupY) {
      $pickups.Add(@{ x = [int]$cmd.pickupX; y = [int]$cmd.pickupY; count = [int]$points.Count })
    } else {
      Emit @{ ok = $false; error = "orbbatch-pickup-required" }
      continue
    }
    $blocked = $false
    foreach ($u in $pickups) {
      if ($u.x -lt ($r.left + $pad) -or $u.x -gt ($r.left + $r.width - $pad) -or $u.y -lt ($r.top + $pad) -or $u.y -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $u.x; y = $u.y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        $blocked = $true
        break
      }
    }
    if ($blocked) { continue }
    $valid = New-Object System.Collections.Generic.List[object]
    foreach ($p in $points) {
      $x = [int]$p.x
      $y = [int]$p.y
      if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        $blocked = $true
        break
      }
      $valid.Add(@{ x = $x; y = $y })
    }
    if ($blocked) { continue }
    if ($hasProbe) {
      if ($probeX -lt ($r.left + $pad) -or $probeX -gt ($r.left + $r.width - $pad) -or $probeY -lt ($r.top + $pad) -or $probeY -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $probeX; y = $probeY; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        continue
      }
    }
    if ($useShift) {
      [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 12
    }
    $emitted = 0
    $heldWaystone = $false
    $emptyCursor = $false
    $verified = 0
    $sentinel = "poe2-orbbatch-well"
    $u = $pickups[0]
    [void][AssistiveWin]::SetCursorPos([int]$u.x, [int]$u.y)
    Start-Sleep -Milliseconds 24
    [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $pickupMs
    $lastPickup = $u
    foreach ($pair in $valid) {
      [void][AssistiveWin]::SetCursorPos([int]$pair.x, [int]$pair.y)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 10
      [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds $gap
      $copied = Copy-HoveredItemText ([int]$pair.x) ([int]$pair.y) 40 180 $sentinel $false
      if (Test-HeldWaystone $copied) {
        $emitted += 1
        $verified += 1
        continue
      }
      if ($hasProbe) {
        $held = Copy-HoveredItemText $probeX $probeY 40 180 "poe2-orbbatch-probe" $false
        if (Test-HeldWaystone $held) {
          $heldWaystone = $true
          break
        }
      }
      $emitted += 1
    }
    $putBackDone = $false
    if ([bool]$cmd.putBack -and $null -ne $lastPickup -and -not $heldWaystone) {
      [void][AssistiveWin]::SetCursorPos([int]$lastPickup.x, [int]$lastPickup.y)
      Start-Sleep -Milliseconds 20
      [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 10
      [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      $putBackDone = $true
    }
    if ($useShift) {
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
    Emit @{ ok = $true; focused = $focused; count = $emitted; emptyCursor = $emptyCursor; heldWaystone = $heldWaystone; verified = $verified; putBack = $putBackDone }
    continue
  }
  if ($op -eq "vaalburst") {
    # One Vaal pickup, Shift held for the whole burst. After each click, wait
    # for a complete Ctrl+C. Corrupted T15 = stay. Complete uncorrupted T15 =
    # the click missed — retry that well. Empty / not-T15 = ejected onto the
    # cursor. Do not restock mid-burst (that puts the Vaal away).
    $points = @($cmd.points)
    $pickups = New-Object System.Collections.Generic.List[object]
    if ($null -ne $cmd.pickups) {
      foreach ($u in @($cmd.pickups)) {
        $pickups.Add(@{ x = [int]$u.x; y = [int]$u.y; count = [int]$u.count })
      }
    }
    $gap = [int]$cmd.gapMs
    if ($gap -le 0) { $gap = 70 }
    $hover = [int]$cmd.hoverMs
    if ($hover -le 0) { $hover = 70 }
    $waitMs = [int]$cmd.copyWaitMs
    if ($waitMs -le 0) { $waitMs = 280 }
    $pickupMs = [int]$cmd.pickupMs
    if ($pickupMs -le 0) { $pickupMs = 120 }
    $retries = [int]$cmd.retries
    if ($retries -le 0) { $retries = 3 }
    $probeX = 0
    $probeY = 0
    if ($null -ne $cmd.probeX) { $probeX = [int]$cmd.probeX }
    if ($null -ne $cmd.probeY) { $probeY = [int]$cmd.probeY }
    $hasProbe = ($probeX -gt 0 -and $probeY -gt 0)
    $pad = 8
    if ($points.Count -lt 1 -or $pickups.Count -lt 1) {
      Emit @{ ok = $true; focused = $focused; applied = 0; ejected = $false; failed = $false; stillClean = $false; pickupIndex = 0; stackLeft = 0 }
      continue
    }
    $valid = New-Object System.Collections.Generic.List[object]
    $blocked = $false
    foreach ($p in $points) {
      $x = [int]$p.x
      $y = [int]$p.y
      if ($x -lt ($r.left + $pad) -or $x -gt ($r.left + $r.width - $pad) -or $y -lt ($r.top + $pad) -or $y -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $x; y = $y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        $blocked = $true
        break
      }
      $valid.Add(@{ x = $x; y = $y })
    }
    if ($blocked) { continue }
    foreach ($u in $pickups) {
      if ($u.x -lt ($r.left + $pad) -or $u.x -gt ($r.left + $r.width - $pad) -or $u.y -lt ($r.top + $pad) -or $u.y -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $u.x; y = $u.y; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        $blocked = $true
        break
      }
    }
    if ($blocked) { continue }
    if ($hasProbe) {
      if ($probeX -lt ($r.left + $pad) -or $probeX -gt ($r.left + $r.width - $pad) -or $probeY -lt ($r.top + $pad) -or $probeY -gt ($r.top + $r.height - $pad)) {
        Emit @{ ok = $false; error = "click-outside-client"; x = $probeX; y = $probeY; left = $r.left; top = $r.top; width = $r.width; height = $r.height; focused = $focused }
        continue
      }
    }
    $applied = 0
    $ejected = $false
    $stillClean = $false
    $pIdx = 0
    $u = $pickups[0]
    $stackLeft = [int]$u.count
    $shiftDown = $false
    $sentinel = "poe2-vaalburst"
    [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    $shiftDown = $true
    Start-Sleep -Milliseconds 12
    [void][AssistiveWin]::SetCursorPos([int]$u.x, [int]$u.y)
    Start-Sleep -Milliseconds 24
    [AssistiveWin]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [AssistiveWin]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $pickupMs
    :wells foreach ($well in $valid) {
      $ok = $false
      for ($try = 0; $try -lt $retries; $try++) {
        [void][AssistiveWin]::SetCursorPos([int]$well.x, [int]$well.y)
        Start-Sleep -Milliseconds 20
        [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 10
        [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        $stackLeft -= 1
        Start-Sleep -Milliseconds $gap
        $copied = Copy-HoveredItemText ([int]$well.x) ([int]$well.y) $hover $waitMs $sentinel $false
        if ((Test-WaystoneTier15 $copied) -and (Test-ItemTextCorrupted $copied)) {
          $ok = $true
          break
        }
        if ((Test-WaystoneTier15 $copied) -and (Test-WaystoneCopyComplete $copied)) {
          continue
        }
        if (Test-WaystoneTier15 $copied) {
          continue
        }
        $ejected = $true
        $applied += 1
        break wells
      }
      if ($ok) {
        $applied += 1
        continue
      }
      $stillClean = $true
      break
    }
    if ($shiftDown) {
      [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
    }
    Emit @{ ok = $true; focused = $focused; applied = $applied; ejected = $ejected; failed = $stillClean; stillClean = $stillClean; pickupIndex = $pIdx; stackLeft = $stackLeft }
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
  if ($op -eq "record") {
    # Observe the USER for a short window: emit button-edge events (with cursor
    # position and ctrl/shift state) plus coarse cursor movement samples.
    # Sends no input of its own — pure teaching-by-demonstration capture.
    $ms = [int]$cmd.ms
    if ($ms -le 0) { $ms = 1000 }
    $start = [DateTime]::UtcNow
    $deadline = $start.AddMilliseconds($ms)
    $events = New-Object System.Collections.ArrayList
    $pt = New-Object AssistPoint
    $prevL = ([AssistiveWin]::GetAsyncKeyState(1) -band 0x8000) -ne 0
    $prevR = ([AssistiveWin]::GetAsyncKeyState(2) -band 0x8000) -ne 0
    $lastMoveX = -9999; $lastMoveY = -9999; $lastMoveAt = $start
    while ([DateTime]::UtcNow -le $deadline) {
      $l = ([AssistiveWin]::GetAsyncKeyState(1) -band 0x8000) -ne 0
      $r = ([AssistiveWin]::GetAsyncKeyState(2) -band 0x8000) -ne 0
      $now = [DateTime]::UtcNow
      if ($l -ne $prevL -or $r -ne $prevR) {
        [void][AssistiveWin]::GetCursorPos([ref]$pt)
        $ctrl = ([AssistiveWin]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
        $shift = ([AssistiveWin]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0
        [void]$events.Add(@{
          t = [int]($now - $start).TotalMilliseconds
          kind = $(if ($l -ne $prevL) { if ($l) { "ldown" } else { "lup" } } else { if ($r) { "rdown" } else { "rup" } })
          x = $pt.X; y = $pt.Y; ctrl = $ctrl; shift = $shift
        })
        $prevL = $l; $prevR = $r
      } elseif (($now - $lastMoveAt).TotalMilliseconds -ge 150) {
        [void][AssistiveWin]::GetCursorPos([ref]$pt)
        if ([math]::Abs($pt.X - $lastMoveX) -gt 30 -or [math]::Abs($pt.Y - $lastMoveY) -gt 30) {
          [void]$events.Add(@{ t = [int]($now - $start).TotalMilliseconds; kind = "move"; x = $pt.X; y = $pt.Y })
          $lastMoveX = $pt.X; $lastMoveY = $pt.Y
        }
        $lastMoveAt = $now
      }
      Start-Sleep -Milliseconds 8
    }
    Emit @{ ok = $true; events = @($events) }
    continue
  }
  if ($op -eq "marks") {
    # Debug overlay: draw labelled rectangles (lime = found, red = click
    # targets) on a click-through topmost layer until the next hidemark.
    try {
      Show-Marks @($cmd.rects)
      Emit @{ ok = $true; count = @($cmd.rects).Count }
    } catch {
      Emit @{ ok = $false; error = "marks:$($_.Exception.Message)" }
    }
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
      } elseif ($OemKeys.ContainsKey($ch)) {
        # Punctuation the game accepts in tab names; unshifted OEM keys on a US layout.
        $vk = $OemKeys[$ch]
        [AssistiveWin]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
      } elseif ($ShiftKeys.ContainsKey($ch)) {
        # Shifted punctuation — needed for stash search queries ("class: ...").
        $vk = $ShiftKeys[$ch]
        [AssistiveWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
        [AssistiveWin]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 8
        [AssistiveWin]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
        [AssistiveWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
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
