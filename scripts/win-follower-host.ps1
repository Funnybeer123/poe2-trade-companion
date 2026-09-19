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
    throw new Exception("Unknown channel");
  }
  public static int ChannelValue(int r, int g, int b, string channel) { return ChannelValue(r, g, b, ChannelId(channel)); }
  // The id is resolved once per capture: no string compares inside the pixel loop.
  static int ChannelValue(int r, int g, int b, int channel) {
    if (channel == 0) return Math.Min(r, Math.Min(g, b));
    if (channel == 1) return Math.Max(0, g - Math.Max(r, b));
    return Math.Max(0, Math.Min(r - g, g - b));
  }
  // Client coordinates of every pixel in the rectangle whose channel value reaches the threshold,
  // as little-endian UInt16 x,y pairs. Null when there are more than the cap: not a UI marker.
  public static byte[] KeyPoints(Bitmap bitmap, int originX, int originY, Rectangle area, string channelName, int threshold, int cap) {
    int channel = ChannelId(channelName);
    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[data.Stride];
      MemoryStream points = new MemoryStream();
      int found = 0;
      for (int y = area.Top; y < area.Bottom; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, (y - originY) * data.Stride), row, 0, data.Stride);
        for (int x = area.Left, i = (area.Left - originX) * 4; x < area.Right; x++, i += 4) {
          if (ChannelValue(row[i + 2], row[i + 1], row[i], channel) < threshold) continue;
          if (++found > cap) return null;
          points.WriteByte((byte)(x & 255)); points.WriteByte((byte)(x >> 8)); points.WriteByte((byte)(y & 255)); points.WriteByte((byte)(y >> 8));
        }
      }
      return points.ToArray();
    } finally { bitmap.UnlockBits(data); }
  }
  static void RequireInside(Rectangle area, Rectangle bounds) {
    if (area.X < 0 || area.Y < 0 || area.Width < 8 || area.Height < 8 || area.Right > bounds.Width || area.Bottom > bounds.Height) throw new Exception("Recalibrate the game view");
  }
  // One capture of the union of both rectangles; only sparse marker pixels cross the pipe.
  public static string Key(Rectangle area, bool full, string channel, int threshold, Rectangle second, string secondChannel, int secondThreshold) {
    long capturedAt = QpcMs(), started = Clock.ElapsedMilliseconds;
    if (threshold < 20 || threshold > 255 || secondThreshold < 20 || secondThreshold > 255) throw new Exception("Invalid key threshold");
    IntPtr window = Foreground();
    Rectangle bounds = Bounds(window);
    if (full) area = new Rectangle(0, 0, bounds.Width, bounds.Height);
    RequireInside(area, bounds);
    Rectangle union = area;
    if (!second.IsEmpty) { RequireInside(second, bounds); union = Rectangle.Union(area, second); }
    Bitmap bitmap = Capture(bounds, union.X, union.Y, union.Width, union.Height);
    byte[] first = KeyPoints(bitmap, union.X, union.Y, area, channel, threshold, 6000);
    byte[] other = second.IsEmpty ? new byte[0] : KeyPoints(bitmap, union.X, union.Y, second, secondChannel, secondThreshold, 2000);
    if (GetForegroundWindow() != window || Bounds(window) != bounds) throw new Exception("Game focus or view changed during capture");
    return "{\"ok\":true,\"hwnd\":\"" + window.ToInt64() + "\",\"process\":\"" + ProcessName(window) + "\",\"width\":" + bounds.Width + ",\"height\":" + bounds.Height
      + ",\"x\":" + area.X + ",\"y\":" + area.Y + ",\"regionWidth\":" + area.Width + ",\"regionHeight\":" + area.Height
      + ",\"capturedAtQpcMs\":" + capturedAt + ",\"captureMs\":" + (Clock.ElapsedMilliseconds - started)
      + ",\"overflow\":" + (first == null ? "true" : "false") + ",\"points\":\"" + (first == null ? "" : Convert.ToBase64String(first)) + "\""
      + ",\"secondOverflow\":" + (other == null ? "true" : "false") + ",\"secondPoints\":\"" + (other == null ? "" : Convert.ToBase64String(other)) + "\"}";
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
    elseif ($command.op -eq 'key') {
      $area = New-Object System.Drawing.Rectangle ([int]$command.x), ([int]$command.y), ([int]$command.width), ([int]$command.height)
      $second = [System.Drawing.Rectangle]::Empty; $secondChannel = 'orange'; $secondThreshold = 255
      if ($null -ne $command.second) {
        $second = New-Object System.Drawing.Rectangle ([int]$command.second.x), ([int]$command.second.y), ([int]$command.second.width), ([int]$command.second.height)
        $secondChannel = [string]$command.second.channel; $secondThreshold = [int]$command.second.threshold
      }
      $reply = [FollowWin]::Key($area, $command.full -eq $true, [string]$command.channel, [int]$command.threshold, $second, $secondChannel, $secondThreshold)
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
