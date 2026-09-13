# Read-only, local Windows OCR. No input synthesis, process memory access, files, or network.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct PriceRect { public int Left, Top, Right, Bottom; }
public struct PricePoint { public int X, Y; }
public static class PriceWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out PriceRect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref PricePoint point);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
"@
[void][PriceWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await-PriceOperation($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(8000)) { throw 'Windows OCR timed out' }
  return $task.Result
}
function Get-PriceTarget([bool]$requireForeground) {
  $fg = [PriceWindow]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  [void][PriceWindow]::GetWindowThreadProcessId($fg, [ref]$foregroundPid)
  $targets = @(Get-Process | Where-Object { $_.ProcessName -match '^PathOfExile(?:Steam|_x64|_x64Steam)?$' -and $_.MainWindowTitle -eq 'Path of Exile 2' -and $_.MainWindowHandle -ne 0 -and -not [PriceWindow]::IsIconic($_.MainWindowHandle) })
  $target = $targets | Where-Object { $_.Id -eq $foregroundPid } | Select-Object -First 1
  if (-not $target -and -not $requireForeground -and $targets.Count -eq 1) { $target = $targets[0] }
  if (-not $target) { throw 'Paused: Path of Exile 2 must be visible and in the foreground.' }
  $rect = New-Object PriceRect; $point = New-Object PricePoint
  if (-not [PriceWindow]::GetClientRect($target.MainWindowHandle, [ref]$rect) -or -not [PriceWindow]::ClientToScreen($target.MainWindowHandle, [ref]$point)) { throw 'Game window could not be verified.' }
  return @{ hwnd = [long]$target.MainWindowHandle; pid = $target.Id; left = $point.X; top = $point.Y; width = $rect.Right; height = $rect.Bottom }
}
function Assert-PriceForeground($target) {
  [uint32]$currentPid = 0
  [void][PriceWindow]::GetWindowThreadProcessId([PriceWindow]::GetForegroundWindow(), [ref]$currentPid)
  if ($currentPid -ne $target.pid) { throw 'Paused: game focus changed.' }
}
function Select-PriceRegion($target) {
  $script:priceSelection = $null; $script:priceStart = $null; $script:priceBox = [System.Drawing.Rectangle]::Empty
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'; $form.TopMost = $true
  $form.Bounds = New-Object System.Drawing.Rectangle $target.left, $target.top, $target.width, $target.height
  $form.BackColor = [System.Drawing.Color]::Black; $form.Opacity = 0.65; $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.KeyPreview = $true; $form.Text = 'Price helper calibration'
  $form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Close() } })
  $form.Add_MouseDown({ if ($_.Button -eq 'Left') { $script:priceStart = $_.Location } })
  $form.Add_MouseMove({
    if ($null -ne $script:priceStart) {
      $script:priceBox = New-Object System.Drawing.Rectangle ([Math]::Min($script:priceStart.X, $_.X)), ([Math]::Min($script:priceStart.Y, $_.Y)), ([Math]::Abs($_.X - $script:priceStart.X)), ([Math]::Abs($_.Y - $script:priceStart.Y))
      $form.Invalidate()
    }
  })
  $form.Add_MouseUp({
    $b = $script:priceBox
    if ($b.Width -ge 20 -and $b.Height -ge 20 -and $b.Width -le 2000 -and $b.Height -le 2000 -and $b.X -ge 0 -and $b.Y -ge 0 -and $b.Right -le $target.width -and $b.Bottom -le $target.height) {
      $script:priceSelection = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; clientWidth = $target.width; clientHeight = $target.height }
      $form.Close()
    } else { $script:priceStart = $null }
  })
  $form.Add_Paint({
    $_.Graphics.DrawString('Drag around the item names and quantities. Esc cancels. Maximum 2000 x 2000.', [System.Drawing.SystemFonts]::MessageBoxFont, [System.Drawing.Brushes]::White, 24, 24)
    $_.Graphics.DrawRectangle([System.Drawing.Pens]::LimeGreen, $script:priceBox)
  })
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 60000
  $timer.Add_Tick({ $form.Close() }); $timer.Start()
  try { [void]$form.ShowDialog(); return $script:priceSelection } finally { $timer.Dispose(); $form.Dispose() }
}
function Read-PriceRegion($target, $region) {
  if ($null -eq $region) { throw 'Calibrate the list region first.' }
  foreach ($key in @('x','y','width','height','clientWidth','clientHeight')) {
    $n = $region.$key
    if ($null -eq $n -or $n -is [string] -or [double]$n -ne [Math]::Truncate([double]$n)) { throw 'Invalid capture region.' }
  }
  if ($region.clientWidth -ne $target.width -or $region.clientHeight -ne $target.height) { throw 'Game resolution changed. Recalibrate the list region.' }
  if ($region.x -lt 0 -or $region.y -lt 0 -or $region.width -lt 20 -or $region.height -lt 20 -or $region.width -gt 2000 -or $region.height -gt 2000 -or ($region.x + $region.width) -gt $target.width -or ($region.y + $region.height) -gt $target.height) { throw 'Capture region is outside the game.' }
  if (([PriceWindow]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0 -or (([PriceWindow]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0 -and ([PriceWindow]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0)) { return @{ ok = $true; dismissed = $true } }
  if ($null -eq $script:priceOcrEngine) {
    $script:priceOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
    if ($null -eq $script:priceOcrEngine) { throw 'Install the English Windows OCR language feature to scan English item names.' }
  }
  $bitmap = $graphics = $memory = $stream = $writer = $software = $null
  try {
    $bitmap = New-Object System.Drawing.Bitmap ([int]$region.width), ([int]$region.height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    Assert-PriceForeground $target
    $graphics.CopyFromScreen(($target.left + $region.x), ($target.top + $region.y), 0, 0, $bitmap.Size)
    Assert-PriceForeground $target
    $memory = New-Object System.IO.MemoryStream
    $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
    $writer.WriteBytes($memory.ToArray())
    [void](Await-PriceOperation ($writer.StoreAsync()) ([UInt32]))
    $decoder = Await-PriceOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await-PriceOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-PriceOperation ($script:priceOcrEngine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    Assert-PriceForeground $target
    $lines = @($result.Lines | Select-Object -First 100 | ForEach-Object {
      $y = ($_.Words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
      $height = ($_.Words | ForEach-Object { $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
      @{ text = [string]$_.Text; y = [int]$y; height = [int]$height }
    })
    return @{ ok = $true; target = $target; lines = $lines }
  } finally {
    foreach ($resource in @($software, $writer, $stream, $memory, $graphics, $bitmap)) { if ($null -ne $resource) { $resource.Dispose() } }
  }
}
while ($null -ne ($commandLine = [Console]::ReadLine())) {
  if ($commandLine -eq 'quit') { break }
  try {
    if ($commandLine.Length -gt 4096) { throw 'Request too large.' }
    $request = $commandLine | ConvertFrom-Json
    switch ($request.op) {
      'calibrate' { $target = Get-PriceTarget $false; $selected = Select-PriceRegion $target; $reply = @{ ok = ($null -ne $selected); region = $selected; error = 'Calibration cancelled.' } }
      'read' { $target = Get-PriceTarget $true; $reply = Read-PriceRegion $target $request.region }
      'status' { $target = Get-PriceTarget $true; $reply = @{ ok = $true; target = $target } }
      default { throw 'Unsupported read-only operation.' }
    }
  } catch { $reply = @{ ok = $false; error = [string]$_.Exception.Message } }
  [Console]::WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
}
