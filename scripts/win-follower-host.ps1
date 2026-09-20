# Capture-only worker for the Follow & Loot observation preview. This script has
# no SendInput, hook, or cursor API: it cannot emit game input by construction.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public struct FollowRect { public int Left, Top, Right, Bottom; }
public struct FollowPoint { public int X, Y; }
public static class FollowWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out FollowRect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref FollowPoint point);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int mode);
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
  public static Rectangle Bounds(IntPtr window) {
    FollowRect rect; FollowPoint point = new FollowPoint();
    if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref point) || rect.Right < 1 || rect.Bottom < 1) throw new Exception("Game window unavailable");
    return new Rectangle(point.X, point.Y, rect.Right, rect.Bottom);
  }
  public static IntPtr Foreground() {
    IntPtr window = GetForegroundWindow();
    if (window == IntPtr.Zero || !Allowed(ProcessName(window))) throw new Exception("Focus Path of Exile 2 to continue");
    return window;
  }
  // min(R,G,B) per pixel: high only for bright, unsaturated pixels such as nameplate text.
  public static byte[] Whiteness(Bitmap bitmap) {
    int width = bitmap.Width, height = bitmap.Height;
    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[data.Stride];
      byte[] result = new byte[width * height];
      for (int y = 0; y < height; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, data.Stride);
        for (int x = 0, i = 0, o = y * width; x < width; x++, i += 4, o++) result[o] = Math.Min(row[i], Math.Min(row[i + 1], row[i + 2]));
      }
      return result;
    } finally { bitmap.UnlockBits(data); }
  }
  static Bitmap Capture(Rectangle bounds, int x, int y, int width, int height) {
    if (x < 0 || y < 0 || width < 8 || height < 8 || x + width > bounds.Width || y + height > bounds.Height) throw new Exception("Recalibrate the game view");
    if (frameBuffer == null || frameBuffer.Width != width || frameBuffer.Height != height) {
      if (frameGraphics != null) frameGraphics.Dispose();
      if (frameBuffer != null) frameBuffer.Dispose();
      frameBuffer = new Bitmap(width, height, PixelFormat.Format32bppArgb);
      frameGraphics = Graphics.FromImage(frameBuffer);
    }
    frameGraphics.CopyFromScreen(bounds.X + x, bounds.Y + y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
    return frameBuffer;
  }
  // Fixture recording: one full-view PNG written straight to disk, so large frames never cross the pipe.
  public static string Record(string file) {
    long started = Clock.ElapsedMilliseconds;
    if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file) || !file.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !Directory.Exists(Path.GetDirectoryName(file)) || File.Exists(file)) throw new Exception("Invalid recording path");
    IntPtr window = Foreground();
    Rectangle bounds = Bounds(window);
    Capture(bounds, 0, 0, bounds.Width, bounds.Height).Save(file, ImageFormat.Png);
    if (GetForegroundWindow() != window || Bounds(window) != bounds) { File.Delete(file); throw new Exception("Game focus or view changed during capture"); }
    return "{\"ok\":true,\"width\":" + bounds.Width + ",\"height\":" + bounds.Height + ",\"captureMs\":" + (Clock.ElapsedMilliseconds - started) + "}";
  }
  // JSON is assembled here: ConvertTo-Json is too slow for multi-megabyte frames.
  public static string Sample(int x, int y, int width, int height, bool full, bool png) {
    long started = Clock.ElapsedMilliseconds;
    IntPtr window = Foreground();
    Rectangle bounds = Bounds(window);
    if (full) { x = 0; y = 0; width = bounds.Width; height = bounds.Height; }
    Bitmap bitmap = Capture(bounds, x, y, width, height);
    string pixels = Convert.ToBase64String(Whiteness(bitmap));
    string image = "";
    if (png) using (MemoryStream stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); image = ",\"image\":\"data:image/png;base64," + Convert.ToBase64String(stream.ToArray()) + "\""; }
    if (GetForegroundWindow() != window || Bounds(window) != bounds) throw new Exception("Game focus or view changed during capture");
    return "{\"ok\":true,\"hwnd\":\"" + window.ToInt64() + "\",\"width\":" + bounds.Width + ",\"height\":" + bounds.Height
      + ",\"x\":" + x + ",\"y\":" + y + ",\"regionWidth\":" + width + ",\"regionHeight\":" + height
      + ",\"captureMs\":" + (Clock.ElapsedMilliseconds - started) + ",\"pixels\":\"" + pixels + "\"" + image + "}";
  }
  // System-wide monotonic milliseconds: comparable across processes on this PC, so the
  // separate input host can refuse clicks that were decided from an old capture.
  public static long QpcMs() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
  // Same formulas as channelValue() in src/core/followerPerception.ts.
  public static int ChannelId(string channel) {
    if (channel == "white") return 0;
    if (channel == "green") return 1;
    if (channel == "orange") return 2;
    if (channel == "blue") return 3;
    if (channel == "outline") return 4;
    if (channel == "mini") return 5;
    if (channel == "terrain") return 6;
    throw new Exception("Unknown channel");
  }
  public static int ChannelValue(int r, int g, int b, string channel) { return ChannelValue(r, g, b, ChannelId(channel)); }
  // The id is resolved once per capture: no string compares inside the pixel loop.
  static int ChannelValue(int r, int g, int b, int channel) {
    if (channel == 0) return Math.Min(r, Math.Min(g, b));
    if (channel == 1) return Math.Max(0, g - Math.Max(r, b));
    if (channel == 2) return Math.Max(0, Math.Min(r - g, g - b));
    if (channel == 3) return Math.Max(0, b - r);
    // The overlay map's walkable-area outline is lavender and its water edges bright blue: blue above both other channels.
    int outline = b >= 90 ? Math.Max(0, b - Math.Max(r, g)) : 0;
    if (channel == 4) return outline;
    // The map's building models are translucent white: bright and nearly neutral. The value is the brightness.
    int max = Math.Max(r, Math.Max(g, b)), mini = max - Math.Min(r, Math.Min(g, b)) <= 22 ? max : 0;
    if (channel == 5) return mini;
    // Terrain: anything the overlay map draws as not walkable, as a yes/no plane.
    return outline >= 14 || mini >= 125 ? 255 : 0;
  }
  // Client coordinates of every pixel in the rectangle whose channel value reaches the threshold,
  // as little-endian UInt16 x,y pairs. Null when there are more than the cap: not a UI marker.
  public static byte[] KeyPoints(Bitmap bitmap, int originX, int originY, Rectangle area, string channelName, int threshold, int cap) {
    return KeyPoints(bitmap, originX, originY, area, channelName, threshold, cap, 1);
  }
  // `grid` > 1 emits one point per occupied grid x grid block, at the block's top-left in client
  // coordinates, instead of every matching pixel.
  //
  // For the terrain plane this is LOSSLESS, not an approximation: TerrainPlanner buckets every wall
  // pixel into a CELL-sized cell by floor((x - window.x) / CELL) and dilates it, so when grid == CELL
  // over the same rectangle the emitted point lands in the very cell its pixels did, and the grid the
  // planner builds is identical.
  //
  // It exists because the cap was silently costing the follower its route. An overflow returns null and
  // the loop discards the WHOLE plan, so the planner failed exactly where walls were densest: measured
  // over 16 recorded frames, 4 overflowed 50,000 (a built-up area 56,264, the worst 113,022) and live
  // runs produced no plan 84-96% of the time, steering by straight line into walls. Per-cell points cut
  // those frames 4.1-16x (56,264 -> 7,312; 113,022 -> 9,123), worst case 18% of the cap.
  public static byte[] KeyPoints(Bitmap bitmap, int originX, int originY, Rectangle area, string channelName, int threshold, int cap, int grid) {
    if (grid < 1 || grid > 64) throw new Exception("Invalid point grid");
    int channel = ChannelId(channelName);
    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[data.Stride];
      MemoryStream points = new MemoryStream();
      int found = 0;
      // One flag per cell column, cleared whenever the scan crosses into the next band of rows: the
      // scan is top-to-bottom, so a band is finished before the next begins and this needs no map.
      bool[] taken = grid > 1 ? new bool[(area.Width + grid - 1) / grid] : null;
      int band = -1;
      for (int y = area.Top; y < area.Bottom; y++) {
        if (grid > 1) { int b = (y - area.Top) / grid; if (b != band) { band = b; Array.Clear(taken, 0, taken.Length); } }
        Marshal.Copy(IntPtr.Add(data.Scan0, (y - originY) * data.Stride), row, 0, data.Stride);
        for (int x = area.Left, i = (area.Left - originX) * 4; x < area.Right; x++, i += 4) {
          if (ChannelValue(row[i + 2], row[i + 1], row[i], channel) < threshold) continue;
          int px = x, py = y;
          if (grid > 1) {
            int c = (x - area.Left) / grid;
            if (taken[c]) continue;
            taken[c] = true;
            px = area.Left + c * grid; py = area.Top + band * grid;
          }
          if (++found > cap) return null;
          points.WriteByte((byte)(px & 255)); points.WriteByte((byte)(px >> 8)); points.WriteByte((byte)(py & 255)); points.WriteByte((byte)(py >> 8));
        }
      }
      return points.ToArray();
    } finally { bitmap.UnlockBits(data); }
  }
  // Horizontal runs of one flat colour: the padding rows of a ground-item label are exactly that, and
  // rendered scenery almost never is. Each run is y, x0, x1 (UInt16 LE, client coordinates) then r, g, b.
  // Runs darker than minBrightness are dropped here: shadows, and the black labels of doors and NPCs.
  public static byte[] FlatRuns(Bitmap bitmap, int originX, int originY, Rectangle area, int minLength, int minBrightness, int cap) {
    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[data.Stride];
      MemoryStream runs = new MemoryStream();
      int found = 0;
      for (int y = area.Top; y < area.Bottom; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, (y - originY) * data.Stride), row, 0, data.Stride);
        int start = area.Left, sr = 0, sg = 0, sb = 0, pr = 0, pg = 0, pb = 0;
        for (int x = area.Left; x <= area.Right; x++) {
          int i = (x - originX) * 4;
          bool inside = x < area.Right;
          int r = inside ? row[i + 2] : -999, g = inside ? row[i + 1] : -999, b = inside ? row[i] : -999;
          bool continues = x > area.Left && inside
            && Math.Abs(r - pr) <= 3 && Math.Abs(g - pg) <= 3 && Math.Abs(b - pb) <= 3
            && Math.Abs(r - sr) <= 48 && Math.Abs(g - sg) <= 48 && Math.Abs(b - sb) <= 48;
          if (!continues) {
            if (x > area.Left && x - start >= minLength && Math.Max(sr, Math.Max(sg, sb)) >= minBrightness) {
              if (++found > cap) return null;
              int end = x - 1;
              runs.WriteByte((byte)(y & 255)); runs.WriteByte((byte)(y >> 8)); runs.WriteByte((byte)(start & 255)); runs.WriteByte((byte)(start >> 8));
              runs.WriteByte((byte)(end & 255)); runs.WriteByte((byte)(end >> 8)); runs.WriteByte((byte)sr); runs.WriteByte((byte)sg); runs.WriteByte((byte)sb);
            }
            start = x; sr = r; sg = g; sb = b;
          }
          pr = r; pg = g; pb = b;
        }
      }
      return runs.ToArray();
    } finally { bitmap.UnlockBits(data); }
  }
  // Hue class of a pixel: 0 for dark or unsaturated pixels (scenery, shadows, black labels), else 1..12 for
  // 30-degree hue buckets offset by 15 degrees. Same integer arithmetic as hueClass() in src/core/followerLoot.ts.
  public static int HueClass(int r, int g, int b) {
    int max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b)), chroma = max - min;
    if (max < 45 || chroma * 100 < 50 * max) return 0;
    int hue = max == r ? 60 * (g - b) / chroma : max == g ? 60 * (b - r) / chroma + 120 : 60 * (r - g) / chroma + 240;
    return ((hue + 375) % 360) / 30 + 1;
  }
  // Runs of one hue class: a translucent label keeps its hue where a light beam or scenery shifts its brightness,
  // so its border, fill and text stay one run where flat-colour runs shatter. Each run is y, x0, x1 (UInt16 LE) and the class.
  public static byte[] HueRuns(Bitmap bitmap, int originX, int originY, Rectangle area, int minLength, int cap) {
    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[data.Stride];
      MemoryStream runs = new MemoryStream();
      int found = 0;
      for (int y = area.Top; y < area.Bottom; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, (y - originY) * data.Stride), row, 0, data.Stride);
        int start = area.Left, current = -1;
        for (int x = area.Left; x <= area.Right; x++) {
          int i = (x - originX) * 4;
          int cls = x < area.Right ? HueClass(row[i + 2], row[i + 1], row[i]) : -2;
          if (cls == current) continue;
          if (current > 0 && x - start >= minLength) {
            if (++found > cap) return null;
            int end = x - 1;
            runs.WriteByte((byte)(y & 255)); runs.WriteByte((byte)(y >> 8)); runs.WriteByte((byte)(start & 255)); runs.WriteByte((byte)(start >> 8));
            runs.WriteByte((byte)(end & 255)); runs.WriteByte((byte)(end >> 8)); runs.WriteByte((byte)current);
          }
          start = x; current = cls;
        }
      }
      return runs.ToArray();
    } finally { bitmap.UnlockBits(data); }
  }
  public static string Runs(Rectangle area, int minLength, int minBrightness) {
    long capturedAt = QpcMs(), started = Clock.ElapsedMilliseconds;
    if (minLength < 24 || minLength > 400 || minBrightness < 0 || minBrightness > 255) throw new Exception("Invalid run limits");
    IntPtr window = Foreground();
    Rectangle bounds = Bounds(window);
    RequireInside(area, bounds);
    Bitmap bitmap = Capture(bounds, area.X, area.Y, area.Width, area.Height);
    byte[] runs = FlatRuns(bitmap, area.X, area.Y, area, minLength, minBrightness, 4000);
    byte[] hues = HueRuns(bitmap, area.X, area.Y, area, minLength, 4000);
    if (GetForegroundWindow() != window || Bounds(window) != bounds) throw new Exception("Game focus or view changed during capture");
    return "{\"ok\":true,\"hwnd\":\"" + window.ToInt64() + "\",\"process\":\"" + ProcessName(window) + "\",\"width\":" + bounds.Width + ",\"height\":" + bounds.Height
      + ",\"capturedAtQpcMs\":" + capturedAt + ",\"captureMs\":" + (Clock.ElapsedMilliseconds - started)
      + ",\"overflow\":" + (runs == null ? "true" : "false") + ",\"runs\":\"" + (runs == null ? "" : Convert.ToBase64String(runs)) + "\""
      + ",\"hueOverflow\":" + (hues == null ? "true" : "false") + ",\"hueRuns\":\"" + (hues == null ? "" : Convert.ToBase64String(hues)) + "\"}";
  }
  static void RequireInside(Rectangle area, Rectangle bounds) {
    if (area.X < 0 || area.Y < 0 || area.Width < 8 || area.Height < 8 || area.Right > bounds.Width || area.Bottom > bounds.Height) throw new Exception("Recalibrate the game view");
  }
  // One capture of the union of both rectangles; only sparse marker pixels cross the pipe.
  public static string Key(Rectangle area, bool full, string channel, int threshold, Rectangle second, string secondChannel, int secondThreshold) { return Key(area, full, channel, threshold, second, secondChannel, secondThreshold, Rectangle.Empty, "blue", 255); }
  public static string Key(Rectangle area, bool full, string channel, int threshold, Rectangle second, string secondChannel, int secondThreshold, Rectangle third, string thirdChannel, int thirdThreshold) { return Key(area, full, channel, threshold, second, secondChannel, secondThreshold, third, thirdChannel, thirdThreshold, 6000); }
  public static string Key(Rectangle area, bool full, string channel, int threshold, Rectangle second, string secondChannel, int secondThreshold, Rectangle third, string thirdChannel, int thirdThreshold, int cap) { return Key(area, full, channel, threshold, second, secondChannel, secondThreshold, third, thirdChannel, thirdThreshold, cap, 1); }
  public static string Key(Rectangle area, bool full, string channel, int threshold, Rectangle second, string secondChannel, int secondThreshold, Rectangle third, string thirdChannel, int thirdThreshold, int cap, int grid) {
    long capturedAt = QpcMs(), started = Clock.ElapsedMilliseconds;
    if (cap < 100 || cap > 60000) throw new Exception("Invalid point cap");
    if (threshold < 10 || threshold > 255 || secondThreshold < 20 || secondThreshold > 255 || thirdThreshold < 20 || thirdThreshold > 255) throw new Exception("Invalid key threshold");
    IntPtr window = Foreground();
    Rectangle bounds = Bounds(window);
    if (full) area = new Rectangle(0, 0, bounds.Width, bounds.Height);
    RequireInside(area, bounds);
    Rectangle union = area;
    if (!second.IsEmpty) { RequireInside(second, bounds); union = Rectangle.Union(area, second); }
    if (!third.IsEmpty) { RequireInside(third, bounds); union = Rectangle.Union(union, third); }
    Bitmap bitmap = Capture(bounds, union.X, union.Y, union.Width, union.Height);
    byte[] first = KeyPoints(bitmap, union.X, union.Y, area, channel, threshold, cap, grid);
    byte[] other = second.IsEmpty ? new byte[0] : KeyPoints(bitmap, union.X, union.Y, second, secondChannel, secondThreshold, 2000);
    byte[] extra = third.IsEmpty ? new byte[0] : KeyPoints(bitmap, union.X, union.Y, third, thirdChannel, thirdThreshold, 8000);
    if (GetForegroundWindow() != window || Bounds(window) != bounds) throw new Exception("Game focus or view changed during capture");
    return "{\"ok\":true,\"hwnd\":\"" + window.ToInt64() + "\",\"process\":\"" + ProcessName(window) + "\",\"width\":" + bounds.Width + ",\"height\":" + bounds.Height
      + ",\"x\":" + area.X + ",\"y\":" + area.Y + ",\"regionWidth\":" + area.Width + ",\"regionHeight\":" + area.Height
      + ",\"capturedAtQpcMs\":" + capturedAt + ",\"captureMs\":" + (Clock.ElapsedMilliseconds - started)
      + ",\"overflow\":" + (first == null ? "true" : "false") + ",\"points\":\"" + (first == null ? "" : Convert.ToBase64String(first)) + "\""
      + ",\"secondOverflow\":" + (other == null ? "true" : "false") + ",\"secondPoints\":\"" + (other == null ? "" : Convert.ToBase64String(other)) + "\""
      + ",\"thirdOverflow\":" + (extra == null ? "true" : "false") + ",\"thirdPoints\":\"" + (extra == null ? "" : Convert.ToBase64String(extra)) + "\"}";
  }
}
'@
try { [void][FollowWin]::SetProcessDpiAwareness(2) } catch {}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -eq 'quit') { break }
  try {
    $command = $line | ConvertFrom-Json
    if ($command.op -eq 'ping') { $reply = '{"ok":true}' }
    elseif ($command.op -eq 'preview') { $reply = [FollowWin]::Sample(0, 0, 0, 0, $true, $true) }
    elseif ($command.op -eq 'sample') { $reply = [FollowWin]::Sample([int]$command.x, [int]$command.y, [int]$command.width, [int]$command.height, $command.full -eq $true, $false) }
    elseif ($command.op -eq 'record') { $reply = [FollowWin]::Record([string]$command.file) }
    elseif ($command.op -eq 'runs') {
      $area = New-Object System.Drawing.Rectangle ([int]$command.x), ([int]$command.y), ([int]$command.width), ([int]$command.height)
      $reply = [FollowWin]::Runs($area, [int]$command.minLength, [int]$command.minBrightness)
    }
    elseif ($command.op -eq 'key' -or $command.op -eq 'terrain') {   # 'terrain' is the same capture under its own name, so logs and tests can tell map reading from marker tracking
      $area = New-Object System.Drawing.Rectangle ([int]$command.x), ([int]$command.y), ([int]$command.width), ([int]$command.height)
      $second = [System.Drawing.Rectangle]::Empty; $secondChannel = 'orange'; $secondThreshold = 255
      if ($null -ne $command.second) {
        $second = New-Object System.Drawing.Rectangle ([int]$command.second.x), ([int]$command.second.y), ([int]$command.second.width), ([int]$command.second.height)
        $secondChannel = [string]$command.second.channel; $secondThreshold = [int]$command.second.threshold
      }
      $third = [System.Drawing.Rectangle]::Empty; $thirdChannel = 'blue'; $thirdThreshold = 255
      if ($null -ne $command.third) {
        $third = New-Object System.Drawing.Rectangle ([int]$command.third.x), ([int]$command.third.y), ([int]$command.third.width), ([int]$command.third.height)
        $thirdChannel = [string]$command.third.channel; $thirdThreshold = [int]$command.third.threshold
      }
      $reply = [FollowWin]::Key($area, $command.full -eq $true, [string]$command.channel, [int]$command.threshold, $second, $secondChannel, $secondThreshold, $third, $thirdChannel, $thirdThreshold, $(if ($null -eq $command.cap) { 6000 } else { [int]$command.cap }), $(if ($null -eq $command.grid) { 1 } else { [int]$command.grid }))
    }
    else { throw 'Unknown follower capture operation' }
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
    $reply = (@{ ok = $false; error = $message } | ConvertTo-Json -Compress)
  }
  [Console]::WriteLine($reply)
  [Console]::Out.Flush()
}
