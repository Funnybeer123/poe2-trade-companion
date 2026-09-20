# Movement-click worker for Follow & Loot. It never captures the screen. Every request
# originates in GameInputController via FollowerInputSink; this host re-checks the target
# window, the window under the cursor, capture freshness and manual control natively before any
# click, and sends button down and up as one OS batch so nothing can stay held.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
public struct FollowInputRect { public int Left, Top, Right, Bottom; }
public struct FollowInputPoint { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct FollowMouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] public struct FollowKey { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] public struct FollowUnion { [FieldOffset(0)] public FollowMouse Mouse; [FieldOffset(0)] public FollowKey Key; }
[StructLayout(LayoutKind.Sequential)] public struct FollowInputEvent { public uint Type; public FollowUnion Data; }
public sealed class FollowClickCheck { public bool Ok; public string Error; }
public static class FollowInput {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out FollowInputRect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref FollowInputPoint point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out FollowInputPoint point);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, FollowInputEvent[] inputs, int size);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int mode);
  // Sleep(12) rounds up to the 15.6 ms system tick unless a 1 ms timer period is requested.
  [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
  [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(FollowInputPoint point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  static bool leftHeld;
  static bool placed;
  static FollowInputPoint placedAt;
  static bool humanSeen;
  static FollowInputPoint humanAt;
  static long humanSince;
  public static long QpcMs() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
  public static bool Allowed(string name) {
    foreach (string allowed in new [] { "PathOfExile", "PathOfExile_x64", "PathOfExileSteam", "PathOfExile_x64Steam", "PathOfExileEGS", "PathOfExile_x64EGS" }) {
      if (String.Equals(name, allowed, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }
  static string ProcessName(IntPtr window) {
    uint pid; GetWindowThreadProcessId(window, out pid);
    using (Process process = Process.GetProcessById((int)pid)) { return process.ProcessName; }
  }
  static Rectangle Bounds(IntPtr window) {
    FollowInputRect rect; FollowInputPoint point = new FollowInputPoint();
    if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref point) || rect.Right < 1 || rect.Bottom < 1) throw new Exception("Game window unavailable");
    return new Rectangle(point.X, point.Y, rect.Right, rect.Bottom);
  }
  static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
  static void ThrowIfHumanInput() {
    foreach (int key in new [] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if (Down(key)) throw new Exception("Modifier key held");
    foreach (int button in new [] { 0x01, 0x02, 0x04 }) if (Down(button)) throw new Exception("Mouse button held - manual control");
  }
  // Pure request validation, shared by the live path and the synthetic tests.
  public static FollowClickCheck Check(int x, int y, int viewWidth, int viewHeight, long ageMs, int maxAgeMs) { return Check(x, y, viewWidth, viewHeight, ageMs, maxAgeMs, "move"); }
  public static FollowClickCheck Check(int x, int y, int viewWidth, int viewHeight, long ageMs, int maxAgeMs, string area) {
    FollowClickCheck result = new FollowClickCheck();
    if (viewWidth < 320 || viewHeight < 240) { result.Error = "Invalid game view"; return result; }
    if (maxAgeMs < 1 || maxAgeMs > 150) { result.Error = "Invalid freshness limit"; return result; }
    if (ageMs < 0 || ageMs > maxAgeMs) { result.Error = "Stale capture"; return result; }
    if (area == "loot") {
      // Loot labels can be anywhere in the world view: the same rectangle as lootArea() in src/core/followerLoot.ts,
      // clear of the HUD, party frames, chat input and quest tracker.
      if (x < Math.Round(viewWidth * 0.10) || y < Math.Round(viewHeight * 0.05) || x >= Math.Round(viewWidth * 0.80) || y >= Math.Round(viewHeight * 0.80)) { result.Error = "Click outside the loot area"; return result; }
      result.Ok = true; return result;
    }
    if (area == "party") {
      // The party frame's "travel to party member" swirl, measured at x 11..38, y 322..349 on a 2560x1440 client for
      // the first member. The box is deliberately tight, so a mis-aimed click can reach nothing else in the UI:
      // 3.5% of width is the column measured clear of everything else (x 0..90 at 2560) and is a third of the way to
      // the loot area's 10% edge, nowhere near the movement disc, which starts at w/2 - 0.30h; 16%..50% of height
      // leaves 6 points of headroom above the first entry (22.4%) for UI-scale drift and 371 px below its button at
      // 1440p for a few more members stacking downward, while staying well above the chat panel and the flask row.
      if (x < 0 || y < Math.Round(viewHeight * 0.16) || x >= Math.Round(viewWidth * 0.035) || y >= Math.Round(viewHeight * 0.50)) { result.Error = "Click outside the party frame area"; return result; }
      result.Ok = true; return result;
    }
    if (area != "move") { result.Error = "Unknown click area"; return result; }
    // Movement clicks stay inside the client and inside a central disc, clear of the HUD, panels and screen edges.
    double dx = x - viewWidth / 2.0, dy = y - viewHeight / 2.0, limit = viewHeight * 0.30;
    if (x < 0 || y < 0 || x >= viewWidth || y >= viewHeight || dx * dx + dy * dy > limit * limit) { result.Error = "Click outside the safe movement area"; return result; }
    result.Ok = true; return result;
  }
  // Pure manual-takeover rule: after a human moved the mouse, stay away until the cursor has rested.
  public static bool HumanStillActive(bool movedSinceSeen, long restedMs) { return movedSinceSeen || restedMs < 1000; }
  public static FollowInputEvent Button(bool down) {
    FollowInputEvent input = new FollowInputEvent(); input.Type = 0; input.Data.Mouse.Flags = down ? 0x0002u : 0x0004u; return input;
  }
  // True when nothing is held afterwards. The flag is cleared only when Windows accepted the release.
  public static bool Release() {
    if (!leftHeld) return true;
    int size = Marshal.SizeOf(typeof(FollowInputEvent));
    for (int attempt = 0; attempt < 3; attempt++) {
      if (SendInput(1, new [] { Button(false) }, size) == 1) { leftHeld = false; return true; }
      Thread.Sleep(5);
    }
    return false;
  }
  // Sprint is a held key, so it has a dead-man's switch: unless the loop renews it every few captures, a
  // background thread lets go. It is also released on any refusal, on "release", and when this worker ends.
  static readonly object sprintGate = new object();
  static bool spaceHeld;
  static long spaceDeadline;
  static Thread sprintWatchdog;
  public const int SprintRenewMs = 350;
  public static FollowInputEvent Space(bool down) {
    FollowInputEvent input = new FollowInputEvent(); input.Type = 1; input.Data.Key.Vk = 0x20; input.Data.Key.Scan = 0x39; input.Data.Key.Flags = down ? 0u : 2u; return input;
  }
  public static bool ReleaseSprint() {
    lock (sprintGate) {
      if (!spaceHeld) return true;
      int size = Marshal.SizeOf(typeof(FollowInputEvent));
      for (int attempt = 0; attempt < 3; attempt++) { if (SendInput(1, new [] { Space(false) }, size) == 1) { spaceHeld = false; return true; } Thread.Sleep(5); }
      return false;
    }
  }
  static void EnsureWatchdog() {
    if (sprintWatchdog != null) return;
    // Check and release under one lock, so a renew cannot land between them and be undone.
    sprintWatchdog = new Thread(() => { while (true) { Thread.Sleep(40); bool expired; lock (sprintGate) { expired = spaceHeld && QpcMs() > spaceDeadline; if (expired) ReleaseSprint(); } } });
    sprintWatchdog.IsBackground = true; sprintWatchdog.Name = "Follower sprint watchdog"; sprintWatchdog.Start();
  }
  // Renews the hold; every guard a click has applies, and failing any of them lets go. Space goes down only on a
  // controller-emitted start: a renew of a hold that lapsed fails instead of pressing again, unaudited.
  public static void Sprint(string expectedHwnd, int viewWidth, int viewHeight, long capturedAtQpcMs, int maxAgeMs, bool start) {
    try {
      if (!start) lock (sprintGate) { if (!spaceHeld) throw new Exception("Sprint lapsed"); }
      FollowClickCheck check = Check(viewWidth / 2, viewHeight / 2, viewWidth, viewHeight, QpcMs() - capturedAtQpcMs, maxAgeMs, "move");
      if (!check.Ok) throw new Exception(check.Error);
      IntPtr window = GetForegroundWindow();
      if (window == IntPtr.Zero || !Allowed(ProcessName(window))) throw new Exception("Focus Path of Exile 2 to continue");
      if (window.ToInt64().ToString() != expectedHwnd) throw new Exception("Game window changed");
      Rectangle bounds = Bounds(window);
      if (bounds.Width != viewWidth || bounds.Height != viewHeight) throw new Exception("Game view changed");
      ThrowIfHumanInput();
      if (humanSeen) throw new Exception("Manual mouse movement");
      EnsureWatchdog();
      lock (sprintGate) {
        if (!spaceHeld) {
          if (!start) throw new Exception("Sprint lapsed");
          // Only while we hold nothing: the key state also reports our own injected hold. Our later space-up would cut a human's hold short.
          if (Down(0x20)) throw new Exception("Space held - manual control");
          if (SendInput(1, new [] { Space(true) }, Marshal.SizeOf(typeof(FollowInputEvent))) != 1) throw new Exception("Windows rejected sprint input");
          spaceHeld = true;
        }
        spaceDeadline = QpcMs() + SprintRenewMs;
      }
    } catch { ReleaseSprint(); throw; }
  }
  static void NoteHuman(FollowInputPoint cursor) { placed = false; humanSeen = true; humanAt = cursor; humanSince = QpcMs(); }
  // Any refusal means the follower is not in control, so the held key goes up with it, not a watchdog period later.
  public static void MoveClick(int x, int y, string expectedHwnd, int viewWidth, int viewHeight, long capturedAtQpcMs, int maxAgeMs, string area) {
    try { GuardedClick(x, y, expectedHwnd, viewWidth, viewHeight, capturedAtQpcMs, maxAgeMs, area); } catch { ReleaseSprint(); throw; }
  }
  static void GuardedClick(int x, int y, string expectedHwnd, int viewWidth, int viewHeight, long capturedAtQpcMs, int maxAgeMs, string area) {
    FollowClickCheck check = Check(x, y, viewWidth, viewHeight, QpcMs() - capturedAtQpcMs, maxAgeMs, area);
    if (!check.Ok) throw new Exception(check.Error);
    if (!Release()) throw new Exception("A movement button release was rejected earlier");
    if (GetSystemMetrics(23) != 0) throw new Exception("Swapped mouse buttons are not supported: turn off 'Switch primary and secondary buttons' to follow");
    IntPtr window = GetForegroundWindow();
    if (window == IntPtr.Zero || !Allowed(ProcessName(window))) throw new Exception("Focus Path of Exile 2 to continue");
    if (window.ToInt64().ToString() != expectedHwnd) throw new Exception("Game window changed");
    Rectangle bounds = Bounds(window);
    if (bounds.Width != viewWidth || bounds.Height != viewHeight) throw new Exception("Game view changed");
    ThrowIfHumanInput();
    FollowInputPoint cursor;
    if (!GetCursorPos(out cursor)) throw new Exception("Cursor position unavailable");
    if (humanSeen) {
      bool moved = Math.Abs(cursor.X - humanAt.X) > 2 || Math.Abs(cursor.Y - humanAt.Y) > 2;
      if (moved) { humanAt = cursor; humanSince = QpcMs(); }
      if (HumanStillActive(moved, QpcMs() - humanSince)) throw new Exception("Manual mouse movement");
      humanSeen = false;
    } else if (placed && (Math.Abs(cursor.X - placedAt.X) > 24 || Math.Abs(cursor.Y - placedAt.Y) > 24)) {
      // Someone moved the mouse since our last click: they have priority until the cursor rests.
      NoteHuman(cursor);
      throw new Exception("Manual mouse movement");
    }
    FollowInputPoint target = new FollowInputPoint(); target.X = bounds.X + x; target.Y = bounds.Y + y;
    if (!SetCursorPos(target.X, target.Y)) throw new Exception("Windows rejected cursor movement");
    placed = true; placedAt = target;
    Thread.Sleep(12);
    // The pause lets the game see the cursor. Re-check focus, view, cursor, the window under the cursor,
    // freshness, and human keys and buttons: all of them can change while we sleep.
    if (GetForegroundWindow() != window || Bounds(window) != bounds) throw new Exception("Game focus or view changed before click");
    if (!GetCursorPos(out cursor) || Math.Abs(cursor.X - target.X) > 2 || Math.Abs(cursor.Y - target.Y) > 2) { NoteHuman(cursor); throw new Exception("Manual mouse movement"); }
    if (GetAncestor(WindowFromPoint(cursor), 2) != window) throw new Exception("Game is covered at the click point");
    if (QpcMs() - capturedAtQpcMs > maxAgeMs) throw new Exception("Stale capture");
    ThrowIfHumanInput();
    // Down and up in one OS batch: nothing is held if this worker dies, and a human press cannot land between them.
    int size = Marshal.SizeOf(typeof(FollowInputEvent));
    uint sent = SendInput(2, new [] { Button(true), Button(false) }, size);
    if (sent == 1) { leftHeld = true; if (!Release()) throw new Exception("Windows rejected the movement button release"); throw new Exception("Windows split the movement click"); }
    if (sent != 2) throw new Exception("Windows rejected movement input");
  }}
'@
try { [void][FollowInput]::SetProcessDpiAwareness(2) } catch {}
try { [void][FollowInput]::timeBeginPeriod(1) } catch {}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -eq 'quit') { break }
  try {
    $command = $line | ConvertFrom-Json
    if ($command.op -eq 'ping') { $reply = @{ ok = $true } }
    elseif ($command.op -eq 'release') { $sprintReleased = [FollowInput]::ReleaseSprint(); $reply = @{ ok = ([FollowInput]::Release() -and $sprintReleased) } }
    elseif ($command.op -eq 'sprint') {
      if ($command.hold -eq $true) { [FollowInput]::Sprint([string]$command.expectedHwnd, [int]$command.viewWidth, [int]$command.viewHeight, [long]$command.capturedAtQpcMs, [int]$command.maxAgeMs, ($command.start -eq $true)); $reply = @{ ok = $true; held = $true } }
      else { $reply = @{ ok = [FollowInput]::ReleaseSprint(); held = $false } }
    }
    elseif ($command.op -eq 'moveclick') {
      $started = [FollowInput]::QpcMs()
      [FollowInput]::MoveClick([int]$command.x, [int]$command.y, [string]$command.expectedHwnd, [int]$command.viewWidth, [int]$command.viewHeight, [long]$command.capturedAtQpcMs, [int]$command.maxAgeMs, $(if ($null -eq $command.area) { 'move' } else { [string]$command.area }))
      $done = [FollowInput]::QpcMs()
      $reply = @{ ok = $true; inputMs = ($done - $started); captureToInputMs = ($done - [long]$command.capturedAtQpcMs) }
    } else { throw 'Unknown follower input operation' }
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
    $reply = @{ ok = $false; error = $message }
  }
  [Console]::WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
} } finally { [void][FollowInput]::ReleaseSprint(); [void][FollowInput]::Release(); try { [void][FollowInput]::timeEndPeriod(1) } catch {} }
