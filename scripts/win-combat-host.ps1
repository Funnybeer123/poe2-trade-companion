# Persistent, small-region capture worker. All input requests originate in
# GameInputController via CombatInputSink; sampling and preview emit no input.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public struct CombatRect { public int Left, Top, Right, Bottom; }
public struct CombatPoint { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct CombatKey { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] public struct CombatMouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] public struct CombatUnion { [FieldOffset(0)] public CombatKey Key; [FieldOffset(0)] public CombatMouse Mouse; }
[StructLayout(LayoutKind.Sequential)] public struct CombatInput { public uint Type; public CombatUnion Data; }
public static class CombatWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out CombatRect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref CombatPoint point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, CombatInput[] inputs, int size);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int mode);
  static long sampledAt;
  static IntPtr sampledWindow;
  static Rectangle sampledRect;
  static Bitmap frameBuffer;
  static Graphics frameGraphics;
  public static readonly Stopwatch Clock = Stopwatch.StartNew();
  public static string ProcessName(IntPtr window) {
    uint pid; GetWindowThreadProcessId(window, out pid);
    using (Process process = Process.GetProcessById((int)pid)) { return process.ProcessName; }
  }
  public static bool Allowed(string name) {
    foreach (string allowed in new [] { "PathOfExile", "PathOfExile_x64", "PathOfExileSteam", "PathOfExile_x64Steam", "PathOfExileEGS", "PathOfExile_x64EGS" }) {
      if (String.Equals(name, allowed, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }
  public static bool ModifiersDown() {
    foreach (int key in new [] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
    return false;
  }
  public static Rectangle Bounds(IntPtr window) {
    CombatRect rect; CombatPoint point = new CombatPoint();
    if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref point) || rect.Right < 1 || rect.Bottom < 1) throw new Exception("Game window unavailable");
    return new Rectangle(point.X, point.Y, rect.Right, rect.Bottom);
  }
  public static IntPtr Foreground() {
    IntPtr window = GetForegroundWindow();
    if (window == IntPtr.Zero || !Allowed(ProcessName(window))) throw new Exception("Focus Path of Exile 2 to continue");
    return window;
  }
  public static void BeginSample(IntPtr window, Rectangle bounds) {
    // Start time, not end time: slow captures cannot produce fresh input.
    sampledAt = Clock.ElapsedMilliseconds; sampledWindow = window; sampledRect = bounds;
  }
  public static byte[][] SampleRegions(Rectangle bounds, int[] regions) {
    if (regions.Length == 0 || regions.Length % 6 != 0 || regions.Length > 24) throw new Exception("Invalid HUD regions");
    Rectangle union = Rectangle.Empty;
    for (int i = 0; i < regions.Length; i += 6) {
      int x = regions[i], y = regions[i + 1], width = regions[i + 2], height = regions[i + 3];
      if (x < 0 || y < 0 || width < 3 || height < 3 || width > 1024 || height > 1024 || x + width > bounds.Width || y + height > bounds.Height) throw new Exception("Recalibrate HUD regions");
      Rectangle region = new Rectangle(x, y, width, height);
      union = i == 0 ? region : Rectangle.Union(union, region);
    }
    if (frameBuffer == null || frameBuffer.Size != union.Size) {
      if (frameGraphics != null) frameGraphics.Dispose();
      if (frameBuffer != null) frameBuffer.Dispose();
      frameBuffer = new Bitmap(union.Width, union.Height, PixelFormat.Format32bppArgb);
      frameGraphics = Graphics.FromImage(frameBuffer);
    }
    // One compositor read for the HUD band; reuse its bitmap across frames.
    frameGraphics.CopyFromScreen(bounds.X + union.X, bounds.Y + union.Y, 0, 0, union.Size, CopyPixelOperation.SourceCopy);
    byte[][] result = new byte[regions.Length / 6][];
    for (int i = 0; i < regions.Length; i += 6) result[i / 6] = SampleBitmap(frameBuffer, regions[i + 4], regions[i + 5], regions[i] - union.X, regions[i + 1] - union.Y, regions[i + 2], regions[i + 3]);
    return result;
  }
  public static byte[] SampleBitmap(Bitmap bitmap, int cols, int rows, int x, int y, int width, int height) {
    byte[] rgb = new byte[cols * rows * 3];
    for (int row = 0; row < rows; row++) for (int col = 0; col < cols; col++) {
      Color color = bitmap.GetPixel(x + Math.Min(width - 1, (int)((col + 0.5) * width / cols)), y + Math.Min(height - 1, (int)((row + 0.5) * height / rows)));
      int i = (row * cols + col) * 3; rgb[i] = color.R; rgb[i + 1] = color.G; rgb[i + 2] = color.B;
    }
    return rgb;
  }
  public static string Preview(Rectangle bounds) {
    using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) { graphics.CopyFromScreen(bounds.Location, Point.Empty, bitmap.Size); }
      using (MemoryStream stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); return Convert.ToBase64String(stream.ToArray()); }
    }
  }
  public static void Tap(string key, string expectedWindow) {
    if (key == null || key.Length != 1 || !(key[0] >= 'A' && key[0] <= 'Z' || key[0] >= '0' && key[0] <= '9')) throw new Exception("Unsupported combat key");
    IntPtr window = Foreground();
    if (window.ToInt64().ToString() != expectedWindow || window != sampledWindow) throw new Exception("Game window changed");
    if (Clock.ElapsedMilliseconds - sampledAt > 120 || Bounds(window) != sampledRect) throw new Exception("Stale capture or window moved");
    if (ModifiersDown() || (GetAsyncKeyState(key[0]) & 0x8000) != 0) throw new Exception("Modifier or action key held");
    CombatInput down = new CombatInput(); down.Type = 1; down.Data.Key.Vk = key[0];
    CombatInput up = down; up.Data.Key.Flags = 2;
    // Down/up in one OS batch: no held key if the worker is terminated.
    uint sent = SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(CombatInput)));
    if (sent != 2) {
      SendInput(1, new [] { up }, Marshal.SizeOf(typeof(CombatInput)));
      throw new Exception("Windows rejected combat input");
    }
  }
}
'@
try { [void][CombatWin]::SetProcessDpiAwareness(2) } catch {}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -eq 'quit') { break }
  try {
    $command = $line | ConvertFrom-Json
    if ($command.op -eq 'ping') {
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'tap') {
      [CombatWin]::Tap([string]$command.key, [string]$command.expectedHwnd)
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'preview' -or $command.op -eq 'sample') {
      $window = [CombatWin]::Foreground()
      $bounds = [CombatWin]::Bounds($window)
      if ($command.op -eq 'preview') {
        $reply = @{ ok = $true; image = ('data:image/png;base64,' + [CombatWin]::Preview($bounds)); width = $bounds.Width; height = $bounds.Height }
      } else {
        if ([CombatWin]::ModifiersDown()) { throw 'Release modifier keys to resume' }
        [CombatWin]::BeginSample($window, $bounds)
        $samples = @{}
        $regionValues = New-Object 'System.Collections.Generic.List[int]'
        $regionNames = New-Object 'System.Collections.Generic.List[string]'
        foreach ($name in @('health', 'mana', 'unleash', 'anchor')) {
          $region = $command.regions.$name
          if ($null -eq $region) { continue }
          $cols = 16; $rows = 16
          if ($name -eq 'health' -or $name -eq 'mana') { $cols = 5; $rows = 100 }
          $regionNames.Add($name)
          foreach ($value in @($region.x, $region.y, $region.width, $region.height, $cols, $rows)) { $regionValues.Add([int]$value) }
        }
        $rgb = [CombatWin]::SampleRegions($bounds, $regionValues.ToArray())
        for ($i = 0; $i -lt $regionNames.Count; $i++) { $samples[$regionNames[$i]] = [Convert]::ToBase64String($rgb[$i]) }
        if ([CombatWin]::GetForegroundWindow() -ne $window) { throw 'Game focus changed during capture' }
        $reply = @{ ok = $true; hwnd = $window.ToInt64().ToString(); process = [CombatWin]::ProcessName($window); width = $bounds.Width; height = $bounds.Height; samples = $samples }
      }
    } else { throw 'Unknown combat operation' }
  } catch { $reply = @{ ok = $false; error = $_.Exception.Message } }
  [Console]::WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
