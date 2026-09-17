param([int]$ParentProcessId = 0, [string]$StopFile = '', [switch]$SelfTest, [switch]$OfflineOcr)
$ErrorActionPreference = 'Stop'
# JSON transport must preserve OCR Unicode; the console code page can map bullets
# to literal control bytes, producing invalid JSON on the Node side.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# The interlock and monitor are native threads: blocked JSON/OCR/clipboard work
# in PowerShell cannot delay stop or release. Only an explicit focus command activates a window.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

public struct BagPoint { public int X, Y; }
public struct BagRect { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct BagCursorInfo {
  public int Size, Flags; public IntPtr Handle; public BagPoint Position;
}
[StructLayout(LayoutKind.Sequential)] public struct BagIconInfo {
  [MarshalAs(UnmanagedType.Bool)] public bool Icon;
  public int HotspotX, HotspotY; public IntPtr Mask, Color;
}
[StructLayout(LayoutKind.Sequential)] public struct BagBitmap {
  public int Type, Width, Height, WidthBytes; public short Planes, BitsPixel; public IntPtr Bits;
}
public sealed class BagCursorSnapshot {
  public int x, y, hotspotX, hotspotY, width, height;
  public bool visible; public long handle; public string sha256, path, rgbaBase64;
}
public static class BagNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out BagRect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref BagPoint p);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref BagCursorInfo info);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out BagIconInfo info);
  [DllImport("user32.dll")] public static extern IntPtr CopyIcon(IntPtr icon);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int w, int h, uint step, IntPtr brush, uint flags);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr obj, int size, out BagBitmap bitmap);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  public static readonly Func<uint> ClipboardSequenceReader = GetClipboardSequenceNumber;
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int level);
  public static bool AllowedName(string name) {
    switch (name.ToLowerInvariant()) {
      case "pathofexile": case "pathofexile_x64": case "pathofexilesteam":
      case "pathofexile_x64steam": case "pathofexileegs": case "pathofexile_x64egs": return true;
      default: return false;
    }
  }
  public static bool AllowedTarget(long target) {
    return GetForegroundWindow().ToInt64() == target && AllowedWindow(target);
  }
  public static bool AllowedWindow(long target) {
    IntPtr h = new IntPtr(target); uint pid;
    if (target == 0 || !IsWindow(h)) return false;
    GetWindowThreadProcessId(h, out pid);
    try { using (Process p = Process.GetProcessById((int)pid)) return AllowedName(p.ProcessName); }
    catch { return false; }
  }
  public static bool InsideTarget(long target, int x, int y) {
    BagRect r; BagPoint p = new BagPoint();
    return GetClientRect(new IntPtr(target), out r) && ClientToScreen(new IntPtr(target), ref p)
      && x >= p.X && x < p.X + r.Right && y >= p.Y && y < p.Y + r.Bottom;
  }
  public static string Hash(byte[] bytes) {
    using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
  }
  public static void PrepareOcr(Bitmap bitmap, int threshold, bool invert) {
    if (threshold != 0 && (threshold < 40 || threshold > 240)) throw new InvalidOperationException("ocr-threshold-invalid");
    if (threshold == 0 && !invert) return;
    for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
      Color pixel = bitmap.GetPixel(x, y);
      int r = pixel.R, g = pixel.G, b = pixel.B;
      if (threshold > 0) r = g = b = Math.Max(r, Math.Max(g, b)) >= threshold ? 0 : 255;
      if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
      bitmap.SetPixel(x, y, Color.FromArgb(255, r, g, b));
    }
  }
  public static byte[] Rgba(Bitmap bitmap) {
    byte[] pixels = new byte[bitmap.Width * bitmap.Height * 4];
    for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
      Color pixel = bitmap.GetPixel(x, y); int index = (y * bitmap.Width + x) * 4;
      pixels[index] = pixel.R; pixels[index + 1] = pixel.G; pixels[index + 2] = pixel.B; pixels[index + 3] = pixel.A;
    }
    return pixels;
  }
  public static BagCursorSnapshot Pointer() {
    BagCursorInfo cursor = new BagCursorInfo(); cursor.Size = Marshal.SizeOf(cursor);
    if (!GetCursorInfo(ref cursor)) throw new InvalidOperationException("cursor-observation-failed");
    return new BagCursorSnapshot {
      x = cursor.Position.X, y = cursor.Position.Y, visible = (cursor.Flags & 1) != 0, handle = cursor.Handle.ToInt64()
    };
  }
  public static void RequireSamePointer(BagCursorSnapshot before, BagCursorSnapshot after) {
    if (before == null || after == null || before.x != after.x || before.y != after.y || before.handle != after.handle || before.visible != after.visible)
      throw new InvalidOperationException("cursor-changed-during-capture");
  }
  public static BagCursorSnapshot Cursor(string output) {
    BagCursorSnapshot snapshot = Pointer();
    if (snapshot.handle == 0) return snapshot;
    IntPtr copy = CopyIcon(new IntPtr(snapshot.handle)); if (copy == IntPtr.Zero) throw new InvalidOperationException("cursor-copy-failed");
    BagIconInfo info = new BagIconInfo();
    try {
      if (!GetIconInfo(copy, out info)) throw new InvalidOperationException("cursor-icon-info-failed");
      snapshot.hotspotX = info.HotspotX; snapshot.hotspotY = info.HotspotY;
      BagBitmap bits;
      if (GetObject(info.Color != IntPtr.Zero ? info.Color : info.Mask, Marshal.SizeOf(typeof(BagBitmap)), out bits) == 0)
        throw new InvalidOperationException("cursor-bitmap-info-failed");
      snapshot.width = bits.Width; snapshot.height = info.Color != IntPtr.Zero ? bits.Height : bits.Height / 2;
      if (snapshot.width <= 0 || snapshot.height <= 0 || snapshot.width > 512 || snapshot.height > 512)
        throw new InvalidOperationException("cursor-dimensions-invalid");
      using (Bitmap bitmap = new Bitmap(snapshot.width, snapshot.height, PixelFormat.Format32bppArgb)) {
        using (Graphics graphics = Graphics.FromImage(bitmap)) {
          graphics.Clear(Color.Transparent); IntPtr dc = graphics.GetHdc();
          try { if (!DrawIconEx(dc, 0, 0, copy, snapshot.width, snapshot.height, 0, IntPtr.Zero, 3)) throw new InvalidOperationException("cursor-render-failed"); }
          finally { graphics.ReleaseHdc(dc); }
        }
        // Legacy monochrome cursors carry no alpha. Their AND mask supplies it.
        bool anyAlpha = false;
        for (int y = 0; y < bitmap.Height && !anyAlpha; y++) for (int x = 0; x < bitmap.Width; x++)
          if (bitmap.GetPixel(x, y).A != 0) { anyAlpha = true; break; }
        if (!anyAlpha && info.Mask != IntPtr.Zero) {
          using (Bitmap mask = Image.FromHbitmap(info.Mask)) {
            for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
              Color rgb = bitmap.GetPixel(x, y); bool opaque = mask.GetPixel(x, y).R < 128;
              bitmap.SetPixel(x, y, Color.FromArgb(opaque ? 255 : 0, rgb.R, rgb.G, rgb.B));
            }
          }
        }
        using (MemoryStream memory = new MemoryStream()) {
          snapshot.rgbaBase64 = Convert.ToBase64String(Rgba(bitmap));
          bitmap.Save(memory, ImageFormat.Png); byte[] bytes = memory.ToArray(); snapshot.sha256 = Hash(bytes);
          if (!String.IsNullOrEmpty(output)) { File.WriteAllBytes(output, bytes); snapshot.path = output; }
        }
      }
    } finally {
      if (info.Mask != IntPtr.Zero) DeleteObject(info.Mask);
      if (info.Color != IntPtr.Zero) DeleteObject(info.Color);
      DestroyIcon(copy);
    }
    return snapshot;
  }
}

public sealed class BagInterlock : IDisposable {
  private readonly object gate = new object();
  private readonly Func<bool> parentAlive;
  private readonly Func<long, bool> targetAllowed;
  private readonly Func<int, bool> keyDown;
  private readonly Action<int, bool> keyEvent;
  private readonly Action<bool, bool> buttonEvent;
  private readonly Action<int, int> moveEvent;
  private readonly Action<int> delay;
  private readonly Func<bool> externalStop;
  private Action acknowledgeStop;
  private Func<long, bool> focusAllowed, focusEvent;
  private Func<BagPoint> pointerPosition;
  private readonly HashSet<int> heldKeys = new HashSet<int>();
  private bool leftHeld, rightHeld, pauseDown;
  private volatile bool disposed, monitorReady;
  private Thread monitor;
  public volatile bool Stopped, Paused;
  public string StopReason { get; private set; }
  public bool MonitorReady { get { return monitorReady; } }
  public BagInterlock(Func<bool> parentAlive, Func<long, bool> targetAllowed, Func<int, bool> keyDown,
      Action<int, bool> keyEvent, Action<bool, bool> buttonEvent, Action<int, int> moveEvent, Action<int> delay, Func<bool> externalStop = null) {
    this.parentAlive = parentAlive; this.targetAllowed = targetAllowed; this.keyDown = keyDown;
    this.keyEvent = keyEvent; this.buttonEvent = buttonEvent; this.moveEvent = moveEvent; this.delay = delay;
    this.externalStop = externalStop;
  }
  public static BagInterlock Start(int parentPid, string stopFile) {
    if (parentPid <= 0) throw new InvalidOperationException("parent-process-required");
    Process parent = Process.GetProcessById(parentPid);
    IntPtr parentHandle = parent.Handle; // Acquire now, pinning this process identity before monitoring.
    BagInterlock host = new BagInterlock(
      delegate { try { return !parent.HasExited; } catch { return false; } }, BagNative.AllowedTarget,
      delegate(int key) { return (BagNative.GetAsyncKeyState(key) & 0x8000) != 0; },
      delegate(int key, bool down) { BagNative.keybd_event((byte)key, 0, down ? 0u : 2u, UIntPtr.Zero); },
      delegate(bool right, bool down) { BagNative.mouse_event(right ? (down ? 8u : 16u) : (down ? 2u : 4u), 0, 0, 0, UIntPtr.Zero); },
      delegate(int x, int y) { if (!BagNative.SetCursorPos(x, y)) throw new InvalidOperationException("cursor-move-failed"); }, Thread.Sleep,
      delegate { return !String.IsNullOrEmpty(stopFile) && File.Exists(stopFile); });
    if (!String.IsNullOrEmpty(stopFile)) host.acknowledgeStop = delegate { File.WriteAllText(stopFile + ".ack", "released"); };
    host.focusAllowed = BagNative.AllowedWindow;
    host.focusEvent = delegate(long target) { return BagNative.SetForegroundWindow(new IntPtr(target)); };
    host.pointerPosition = delegate { BagCursorSnapshot pointer = BagNative.Pointer(); return new BagPoint { X = pointer.x, Y = pointer.y }; };
    host.monitor = new Thread(delegate() {
      try { host.Poll(); host.monitorReady = true; while (!host.disposed) { host.Poll(); Thread.Sleep(5); } }
      catch { host.Stop("native-monitor-failed"); }
      finally { parent.Dispose(); }
    });
    host.monitor.IsBackground = true; host.monitor.Start();
    if (!SpinWait.SpinUntil(delegate { return host.MonitorReady; }, 1000)) throw new InvalidOperationException("native-monitor-not-ready");
    return host;
  }
  private void ReleaseUnderLock() {
    foreach (int key in heldKeys) keyEvent(key, false);
    heldKeys.Clear();
    if (leftHeld) { buttonEvent(false, false); leftHeld = false; }
    if (rightHeld) { buttonEvent(true, false); rightHeld = false; }
  }
  public void Stop(string reason) { lock (gate) { Stopped = true; StopReason = reason; ReleaseUnderLock(); } }
  public void Poll() {
    lock (gate) {
      if (!parentAlive()) { Stop("parent-exited"); return; }
      if (externalStop != null && externalStop()) {
        Stop("host-cancelled");
        if (acknowledgeStop != null) { acknowledgeStop(); acknowledgeStop = null; }
        return;
      }
      if (keyDown(0x60) || keyDown(0x2D) || (keyDown(0x11) && keyDown(0x10) && keyDown(0x1B))) { Stop("emergency-stop"); return; }
      bool pause = keyDown(0x65) || keyDown(0x0C);
      if (pause && !pauseDown && !Stopped) { Paused = !Paused; if (Paused) ReleaseUnderLock(); }
      pauseDown = pause;
    }
  }
  public void Guard(long target) {
    lock (gate) {
      GuardControls();
      if (target == 0 || !targetAllowed(target)) throw new InvalidOperationException("focus-or-process-rejected");
    }
  }
  private void GuardControls() {
    Poll();
    if (Stopped) throw new InvalidOperationException("native-stopped:" + StopReason);
    if (Paused) throw new InvalidOperationException("native-paused");
    foreach (int key in new int[] { 0x10, 0x11, 0x12 })
      if (!heldKeys.Contains(key) && keyDown(key)) throw new InvalidOperationException("user-modifier-held");
    if ((!leftHeld && keyDown(1)) || (!rightHeld && keyDown(2)) || keyDown(4)) throw new InvalidOperationException("user-button-held");
  }
  public void Focus(long target) {
    lock (gate) {
      GuardControls();
      if (focusAllowed == null || focusEvent == null || target == 0 || !focusAllowed(target)) throw new InvalidOperationException("focus-process-rejected");
      if (!focusEvent(target)) throw new InvalidOperationException("focus-request-rejected");
    }
    // Windows can accept activation before the foreground transition completes.
    // Wait for that transition without injecting another input or focusing twice.
    for (int waited = 0; waited <= 250; waited += 5) {
      lock (gate) {
        GuardControls();
        if (!focusAllowed(target)) throw new InvalidOperationException("focus-process-rejected");
        if (targetAllowed(target)) return;
      }
      if (waited < 250) delay(5);
    }
    throw new InvalidOperationException("focus-not-acquired");
  }
  public void Wait(long target, int milliseconds) {
    if (milliseconds < 0 || milliseconds > 250) throw new InvalidOperationException("native-wait-out-of-range");
    Stopwatch clock = Stopwatch.StartNew();
    for (int waited = 0; waited < milliseconds;) {
      Guard(target); int slice = Math.Min(5, milliseconds - waited); delay(slice);
      // Windows may round a 5 ms sleep up to a scheduler tick. Count actual
      // elapsed time rather than multiplying that oversleep across every slice.
      waited = Math.Max(waited + slice, (int)clock.ElapsedMilliseconds);
    }
    Guard(target);
  }
  public void Move(long target, int x, int y) { lock (gate) { Guard(target); moveEvent(x, y); } }
  private void RequireCopyPosition(int? expectedX, int? expectedY) {
    if (expectedX.HasValue != expectedY.HasValue) throw new InvalidOperationException("expected-cursor-pair-required");
    if (!expectedX.HasValue) return;
    if (pointerPosition == null) throw new InvalidOperationException("cursor-position-verifier-unavailable");
    BagPoint current = pointerPosition();
    if (Math.Abs((long)current.X - expectedX.Value) > 1 || Math.Abs((long)current.Y - expectedY.Value) > 1)
      throw new InvalidOperationException("copy-cursor-position-changed");
  }
  public void Hotkey(long target, int[] keys, int? expectedX = null, int? expectedY = null) {
    if (keys == null || keys.Length < 1 || keys.Length > 4) throw new InvalidOperationException("invalid-key-chord");
    HashSet<int> unique = new HashSet<int>();
    foreach (int key in keys) if (key < 1 || key > 255 || !unique.Add(key)) throw new InvalidOperationException("invalid-key-chord");
    try {
      foreach (int key in keys) {
        lock (gate) {
          Guard(target);
          RequireCopyPosition(expectedX, expectedY);
          if (keyDown(key)) throw new InvalidOperationException("key-already-held");
          heldKeys.Add(key); keyEvent(key, true);
        }
      }
      Stopwatch clock = Stopwatch.StartNew();
      for (int waited = 0; waited < 20;) {
        Wait(target, 5);
        lock (gate) RequireCopyPosition(expectedX, expectedY);
        waited = Math.Max(waited + 5, (int)clock.ElapsedMilliseconds);
      }
    } finally { lock (gate) ReleaseUnderLock(); }
  }
  public void Click(long target, bool right) { Click(target, right, 0); }
  public void Click(long target, bool right, int modifier) {
    if (modifier != 0 && modifier != 17 && modifier != 18) throw new InvalidOperationException("invalid-click-modifier");
    try {
      lock (gate) {
        Guard(target);
        if (keyDown(0x10) || keyDown(0x11) || keyDown(0x12)) throw new InvalidOperationException("modifier-already-held");
        if (keyDown(right ? 2 : 1)) throw new InvalidOperationException("button-already-held");
        if (modifier != 0) { heldKeys.Add(modifier); keyEvent(modifier, true); }
      }
      // Let the game observe the modifier before mouse-down, and keep it held
      // until after mouse-up. Releasing it first turns Ctrl-click into pickup.
      if (modifier != 0) Wait(target, 40);
      lock (gate) {
        Guard(target);
        if (right) rightHeld = true; else leftHeld = true;
        buttonEvent(right, true);
      }
      Wait(target, 30);
      lock (gate) {
        if (right && rightHeld) { buttonEvent(true, false); rightHeld = false; }
        if (!right && leftHeld) { buttonEvent(false, false); leftHeld = false; }
      }
      if (modifier != 0) Wait(target, 30);
    } finally { lock (gate) ReleaseUnderLock(); }
  }
  /* Fast bag workflow. Both helpers keep the per-event guard: every move, key and
   * button edge re-checks stop, pause, focus, process and user-held input, and the
   * owned Shift/buttons are released on every exit path, including a native stop. */
  public volatile int ChainCompleted;
  public int ReadWaitedMs;
  public void ClickChain(long target, int[] xs, int[] ys, bool right, bool shift, int settleMs, int gapMs) {
    ClickChain(target, xs, ys, right, shift ? 16 : 0, settleMs, gapMs);
  }
  public void ClickChain(long target, int[] xs, int[] ys, bool right, int modifier, int settleMs, int gapMs) {
    if (modifier != 0 && modifier != 16 && modifier != 17) throw new InvalidOperationException("invalid-chain-modifier");
    if (xs == null || ys == null || xs.Length != ys.Length || xs.Length < 1 || xs.Length > 60) throw new InvalidOperationException("invalid-click-chain");
    if (settleMs < 0 || settleMs > 250 || gapMs < 0 || gapMs > 250) throw new InvalidOperationException("click-chain-timing-out-of-range");
    ChainCompleted = 0;
    try {
      lock (gate) {
        Guard(target);
        if (keyDown(0x10) || keyDown(0x11) || keyDown(0x12)) throw new InvalidOperationException("modifier-already-held");
        if (keyDown(1) || keyDown(2)) throw new InvalidOperationException("button-already-held");
        if (modifier != 0) { heldKeys.Add(modifier); keyEvent(modifier, true); }
      }
      if (modifier != 0) Wait(target, 30);
      for (int i = 0; i < xs.Length; i++) {
        lock (gate) { Guard(target); moveEvent(xs[i], ys[i]); }
        Wait(target, settleMs);
        lock (gate) {
          Guard(target); RequireCopyPosition(xs[i], ys[i]);
          if (modifier != 0 && !heldKeys.Contains(modifier)) throw new InvalidOperationException("owned-modifier-lost");
          if (right) rightHeld = true; else leftHeld = true;
          buttonEvent(right, true);
        }
        Wait(target, 20);
        lock (gate) {
          if (right && rightHeld) { buttonEvent(true, false); rightHeld = false; }
          if (!right && leftHeld) { buttonEvent(false, false); leftHeld = false; }
        }
        ChainCompleted = i + 1;
        Wait(target, gapMs);
      }
    } finally { lock (gate) ReleaseUnderLock(); }
  }
  /* One hover + copy chord bound to its pointer position. Returns true only when the
   * clipboard sequence advanced after the chord; an unchanged sequence is "no copy",
   * which a caller must treat as unread unless separate pixel evidence proves empty. */
  public bool ReadItem(long target, int x, int y, int hoverMs, int timeoutMs, int[] keys, Func<uint> clipboardSequence) {
    if (hoverMs < 0 || hoverMs > 250 || timeoutMs < 10 || timeoutMs > 500) throw new InvalidOperationException("read-item-timing-out-of-range");
    if (clipboardSequence == null) throw new InvalidOperationException("clipboard-sequence-unavailable");
    ReadWaitedMs = 0;
    lock (gate) { Guard(target); moveEvent(x, y); }
    Wait(target, hoverMs);
    uint before = clipboardSequence();
    Hotkey(target, keys, x, y);
    Stopwatch clock = Stopwatch.StartNew();
    for (int waited = 0; waited <= timeoutMs;) {
      if (clipboardSequence() != before) { ReadWaitedMs = waited; return true; }
      Guard(target); delay(5);
      waited = Math.Max(waited + 5, (int)clock.ElapsedMilliseconds);
    }
    ReadWaitedMs = timeoutMs;
    return false;
  }
  public void Dispose() {
    Stop("host-closed"); disposed = true;
    if (monitor != null && monitor != Thread.CurrentThread) monitor.Join(1000);
  }
  public static string[] SelfTest() {
    List<string> passed = new List<string>();
    foreach (string mode in new string[] { "stop", "insert-stop", "ctrl-shift-esc", "external-stop", "pause", "parent", "focus", "throw" }) {
      int ticks = 0; bool alive = true, focused = true; HashSet<int> down = new HashSet<int>(); List<string> events = new List<string>();
      BagInterlock test = new BagInterlock(delegate { return alive; }, delegate(long target) { return target == 123 && focused; },
        delegate(int key) { return down.Contains(key); },
        delegate(int key, bool pressed) { events.Add("key:" + key + ":" + pressed); },
        delegate(bool right, bool pressed) { events.Add("button:" + right + ":" + pressed); }, delegate(int x, int y) { events.Add("move"); },
        delegate(int ms) { ticks++; if (mode == "stop") down.Add(0x60); if (mode == "insert-stop") down.Add(0x2D); if (mode == "pause") down.Add(0x65);
          if (mode == "ctrl-shift-esc") { down.Add(0x11); down.Add(0x10); down.Add(0x1B); }
          if (mode == "parent") alive = false; if (mode == "focus") focused = false; if (mode == "throw") throw new InvalidOperationException("injected"); },
        delegate { return mode == "external-stop" && ticks > 0; });
      bool rejected = false;
      try { test.Hotkey(123, new int[] { 17, 18, 67 }); } catch (InvalidOperationException) { rejected = true; }
      if (!rejected || ticks != 1 || events.Count != 6) throw new Exception("selftest-chord-" + mode);
      foreach (int key in new int[] { 17, 18, 67 }) if (!events.Contains("key:" + key + ":False")) throw new Exception("selftest-release-" + mode);
      test.Dispose(); passed.Add("chord-release-on-" + mode);
    }
    foreach (bool right in new bool[] { false, true }) {
      bool stop = false; List<bool> events = new List<bool>();
      BagInterlock test = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123; }, delegate(int k) { return stop && k == 0x60; },
        delegate(int k, bool d) { throw new Exception("unexpected-key"); }, delegate(bool r, bool d) { if (r != right) throw new Exception("wrong-button"); events.Add(d); },
        delegate(int x, int y) { }, delegate(int ms) { stop = true; });
      try { test.Click(123, right); throw new Exception("selftest-click-not-cancelled"); } catch (InvalidOperationException) { }
      if (events.Count != 2 || !events[0] || events[1]) throw new Exception("selftest-button-release");
      test.Dispose(); passed.Add(right ? "right-release-on-stop" : "left-release-on-stop");
    }
    foreach (int modifier in new int[] { 17, 18 }) {
      foreach (string fault in new string[] { "none", "stop", "focus", "throw" }) {
        bool interrupted = false; List<string> events = new List<string>();
        BagInterlock modified = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123 && !(interrupted && fault == "focus"); },
          delegate(int k) { return interrupted && fault == "stop" && k == 0x60; },
          delegate(int k, bool d) { events.Add("key:" + k + ":" + d); }, delegate(bool r, bool d) { events.Add("click:" + d); },
          delegate(int x, int y) { }, delegate(int ms) { interrupted = true; if (fault == "throw") throw new InvalidOperationException("injected"); });
        bool failed = false;
        try { modified.Click(123, false, modifier); } catch (InvalidOperationException) { failed = true; }
        if (failed != (fault != "none") || events.Count != (fault == "none" ? 4 : 2) || events[0] != "key:" + modifier + ":True" ||
          !events.Contains("key:" + modifier + ":False") || (fault == "none" && (events[1] != "click:True" || events[2] != "click:False"))) throw new Exception("selftest-modified-click-" + fault);
        modified.Dispose();
      }
    }
    passed.Add("modified-click-release");
    foreach (int chainModifier in new int[] { 16, 17 }) {
    foreach (string fault in new string[] { "none", "stop", "focus", "drift" }) {
      int waits = 0; bool interrupted = false; BagPoint at = new BagPoint(); List<string> events = new List<string>();
      BagInterlock chain = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123 && !(interrupted && fault == "focus"); },
        delegate(int k) { return interrupted && fault == "stop" && k == 0x60; },
        delegate(int k, bool d) { events.Add("key:" + k + ":" + d); }, delegate(bool r, bool d) { events.Add("click:" + r + ":" + d); },
        delegate(int x, int y) { at.X = x; at.Y = y; events.Add("move:" + x + "," + y); if (fault == "drift" && x == 30) at.X += 5; },
        delegate(int ms) { waits++; if (waits == 12) interrupted = true; });
      chain.pointerPosition = delegate { return at; };
      bool failed = false;
      try { chain.ClickChain(123, new int[] { 10, 30, 50 }, new int[] { 20, 40, 60 }, false, chainModifier, 10, 10); } catch (InvalidOperationException) { failed = true; }
      int downs = events.FindAll(delegate(string e) { return e == "click:False:True"; }).Count, ups = events.FindAll(delegate(string e) { return e == "click:False:False"; }).Count;
      if (failed != (fault != "none") || events[0] != "key:" + chainModifier + ":True" || !events.Contains("key:" + chainModifier + ":False") || downs != ups ||
        events.FindAll(delegate(string e) { return e == "key:" + chainModifier + ":True"; }).Count != 1 || (fault == "none" && (downs != 3 || chain.ChainCompleted != 3)) ||
        (fault != "none" && chain.ChainCompleted >= 3) || events[events.Count - 1].EndsWith(":True")) throw new Exception("selftest-click-chain-" + fault);
      chain.Dispose();
    }
    }
    passed.Add("shift-chain-release-and-count");
    foreach (string mode in new string[] { "copied", "silent", "stop" }) {
      uint sequence = 7; int ticks = 0; BagPoint at = new BagPoint(); List<string> events = new List<string>();
      BagInterlock reader = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123; },
        delegate(int k) { return mode == "stop" && ticks > 3 && k == 0x60; },
        delegate(int k, bool d) { events.Add(k + ":" + d); if (mode == "copied" && k == 67 && d) sequence++; },
        delegate(bool r, bool d) { throw new Exception("read-emitted-click"); }, delegate(int x, int y) { at.X = x; at.Y = y; }, delegate(int ms) { ticks++; });
      reader.pointerPosition = delegate { return at; };
      bool copied = false, failed = false;
      try { copied = reader.ReadItem(123, 100, 200, 20, 40, new int[] { 17, 18, 67 }, delegate { return sequence; }); } catch (InvalidOperationException) { failed = true; }
      if (copied != (mode == "copied") || failed != (mode == "stop") || events.FindAll(delegate(string e) { return e.EndsWith(":True"); }).Count !=
        events.FindAll(delegate(string e) { return e.EndsWith(":False"); }).Count) throw new Exception("selftest-read-item-" + mode);
      reader.Dispose();
    }
    passed.Add("read-item-sequence-bound");
    int schedulerSleeps = 0;
    BagInterlock scheduler = new BagInterlock(delegate { return true; }, delegate(long h) { return true; }, delegate(int k) { return false; },
      delegate(int k, bool d) { }, delegate(bool r, bool d) { }, delegate(int x, int y) { },
      delegate(int ms) { schedulerSleeps++; Thread.Sleep(25); });
    scheduler.Wait(123, 20);
    if (schedulerSleeps != 1) throw new Exception("selftest-scheduler-oversleep-multiplied");
    scheduler.pointerPosition = delegate { return new BagPoint { X = 100, Y = 200 }; };
    schedulerSleeps = 0;
    scheduler.Hotkey(123, new int[] { 17, 18, 67 }, 100, 200);
    if (schedulerSleeps != 1) throw new Exception("selftest-chord-oversleep-multiplied");
    schedulerSleeps = 0;
    if (scheduler.ReadItem(123, 100, 200, 0, 20, new int[] { 17, 18, 67 }, delegate { return 1u; }) || schedulerSleeps != 2)
      throw new Exception("selftest-read-timeout-oversleep-multiplied");
    scheduler.Dispose(); passed.Add("elapsed-scheduler-waits");
    int emitted = 0; bool pauseHeld = false;
    BagInterlock guarded = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123; }, delegate(int k) { return pauseHeld && k == 0x65; },
      delegate(int k, bool d) { emitted++; }, delegate(bool r, bool d) { emitted++; }, delegate(int x, int y) { emitted++; }, delegate(int ms) { });
    foreach (long hwnd in new long[] { 0, 124 }) try { guarded.Move(hwnd, 1, 1); throw new Exception("selftest-focus-not-rejected"); } catch (InvalidOperationException) { }
    pauseHeld = true; guarded.Poll(); guarded.Poll();
    if (!guarded.Paused) throw new Exception("selftest-pause-edge");
    try { guarded.Move(123, 1, 1); throw new Exception("selftest-pause-not-rejected"); } catch (InvalidOperationException) { }
    pauseHeld = false; guarded.Poll(); pauseHeld = true; guarded.Poll();
    if (guarded.Paused || emitted != 0) throw new Exception("selftest-resume-edge");
    guarded.Stop("test"); pauseHeld = false; guarded.Poll(); pauseHeld = true; guarded.Poll();
    if (!guarded.Stopped) throw new Exception("selftest-stop-not-latched");
    guarded.Dispose(); passed.Add("focus-required"); passed.Add("pause-edge-and-no-input"); passed.Add("stop-latched");
    foreach (int held in new int[] { 1, 2, 4, 16, 17, 18 }) {
      int count = 0;
      BagInterlock interference = new BagInterlock(delegate { return true; }, delegate(long h) { return true; }, delegate(int k) { return k == held; },
        delegate(int k, bool d) { count++; }, delegate(bool r, bool d) { count++; }, delegate(int x, int y) { count++; }, delegate(int ms) { });
      try { interference.Move(123, 1, 1); throw new Exception("selftest-interference-move"); } catch (InvalidOperationException) { }
      try { interference.Click(123, false); throw new Exception("selftest-interference-click"); } catch (InvalidOperationException) { }
      try { interference.Hotkey(123, new int[] { 17, 67 }); throw new Exception("selftest-interference-chord"); } catch (InvalidOperationException) { }
      if (count != 0) throw new Exception("selftest-interference-emitted-input");
      interference.Dispose();
    }
    passed.Add("user-modifiers-and-buttons-reject-input");
    bool focusApplied = false; int focusCount = 0;
    BagInterlock focusTest = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123 && focusApplied; }, delegate(int k) { return false; },
      delegate(int k, bool d) { throw new Exception("focus-emitted-key"); }, delegate(bool r, bool d) { throw new Exception("focus-emitted-click"); },
      delegate(int x, int y) { throw new Exception("focus-emitted-move"); }, delegate(int ms) { });
    focusTest.focusAllowed = delegate(long h) { return h == 123; };
    focusTest.focusEvent = delegate(long h) { focusCount++; focusApplied = true; return true; };
    try { focusTest.Focus(124); throw new Exception("selftest-focus-wrong-window"); } catch (InvalidOperationException) { }
    focusTest.Focus(123);
    if (focusCount != 1) throw new Exception("selftest-focus-count");
    focusTest.Stop("test");
    try { focusTest.Focus(123); throw new Exception("selftest-focus-after-stop"); } catch (InvalidOperationException) { }
    if (focusCount != 1) throw new Exception("selftest-focus-after-stop-emitted");
    focusTest.Dispose(); passed.Add("explicit-focus-guarded");
    int focusTicks = 0; bool delayedFocus = false, focusSucceeds = true;
    BagInterlock focusWait = new BagInterlock(delegate { return true; }, delegate(long h) { return delayedFocus; }, delegate(int k) { return false; },
      delegate(int k, bool d) { throw new Exception("focus-wait-emitted-key"); }, delegate(bool r, bool d) { throw new Exception("focus-wait-emitted-click"); },
      delegate(int x, int y) { throw new Exception("focus-wait-emitted-move"); }, delegate(int ms) { focusTicks++; if (focusSucceeds && focusTicks == 2) delayedFocus = true; });
    focusWait.focusAllowed = delegate(long h) { return h == 123; }; focusWait.focusEvent = delegate(long h) { return true; };
    focusWait.Focus(123);
    if (focusTicks != 2) throw new Exception("selftest-deferred-focus");
    delayedFocus = false; focusSucceeds = false; focusTicks = 0;
    try { focusWait.Focus(123); throw new Exception("selftest-focus-timeout-absent"); } catch (InvalidOperationException ex) {
      if (ex.Message != "focus-not-acquired") throw;
    }
    if (focusTicks != 50) throw new Exception("selftest-focus-timeout-bounds");
    focusWait.Dispose(); passed.Add("explicit-focus-deferred-and-bounded");
    using (Bitmap pixels = new Bitmap(2, 1, PixelFormat.Format32bppArgb)) {
      pixels.SetPixel(0, 0, Color.FromArgb(128, 12, 34, 56)); pixels.SetPixel(1, 0, Color.FromArgb(0, 78, 90, 123));
      byte[] roundtrip = Convert.FromBase64String(Convert.ToBase64String(BagNative.Rgba(pixels)));
      if (roundtrip.Length != 8 || roundtrip[0] != 12 || roundtrip[1] != 34 || roundtrip[2] != 56 || roundtrip[3] != 128
          || roundtrip[4] != 78 || roundtrip[5] != 90 || roundtrip[6] != 123 || roundtrip[7] != 0) throw new Exception("selftest-rgba-roundtrip");
      if (BagNative.Hash(roundtrip) != BagNative.Hash(BagNative.Rgba(pixels))) throw new Exception("selftest-rgba-hash");
    }
    passed.Add("cursor-rgba-lossless");
    BagCursorSnapshot originalPointer = new BagCursorSnapshot { x = 10, y = 20, handle = 30, visible = true };
    BagNative.RequireSamePointer(originalPointer, new BagCursorSnapshot { x = 10, y = 20, handle = 30, visible = true });
    foreach (BagCursorSnapshot changed in new BagCursorSnapshot[] {
      new BagCursorSnapshot { x = 11, y = 20, handle = 30, visible = true },
      new BagCursorSnapshot { x = 10, y = 21, handle = 30, visible = true },
      new BagCursorSnapshot { x = 10, y = 20, handle = 31, visible = true },
      new BagCursorSnapshot { x = 10, y = 20, handle = 30, visible = false }
    }) {
      try { BagNative.RequireSamePointer(originalPointer, changed); throw new Exception("selftest-pointer-mutation-accepted"); }
      catch (InvalidOperationException ex) { if (ex.Message != "cursor-changed-during-capture") throw; }
    }
    passed.Add("cursor-frame-binding");
    BagPoint copyPoint = new BagPoint { X = 100, Y = 200 }; bool driftBeforeC = true;
    List<string> copyEvents = new List<string>();
    BagInterlock copyGuard = new BagInterlock(delegate { return true; }, delegate(long h) { return h == 123; }, delegate(int k) { return false; },
      delegate(int key, bool down) { copyEvents.Add(key + ":" + down); if (driftBeforeC && down && key == 18) copyPoint.X += 2; },
      delegate(bool r, bool d) { throw new Exception("copy-emitted-mouse"); }, delegate(int x, int y) { throw new Exception("copy-moved-pointer"); }, delegate(int ms) { });
    copyGuard.pointerPosition = delegate { return copyPoint; };
    try { copyGuard.Hotkey(123, new int[] { 17, 18, 67 }, 100, 200); throw new Exception("selftest-copy-drift-accepted"); }
    catch (InvalidOperationException ex) { if (ex.Message != "copy-cursor-position-changed") throw; }
    if (copyEvents.Count != 4 || copyEvents.Contains("67:True") || !copyEvents.Contains("17:False") || !copyEvents.Contains("18:False")) throw new Exception("selftest-copy-drift-release");
    copyEvents.Clear(); driftBeforeC = false; copyPoint.X = 101; copyPoint.Y = 201;
    copyGuard.Hotkey(123, new int[] { 17, 18, 67 }, 100, 200);
    if (copyEvents.Count != 6 || !copyEvents.Contains("67:True")) throw new Exception("selftest-copy-tolerance");
    copyEvents.Clear();
    try { copyGuard.Hotkey(123, new int[] { 17, 67 }, 100, null); throw new Exception("selftest-copy-partial-pair"); }
    catch (InvalidOperationException ex) { if (ex.Message != "expected-cursor-pair-required") throw; }
    if (copyEvents.Count != 0) throw new Exception("selftest-copy-partial-input");
    copyGuard.Dispose(); passed.Add("copy-position-bound-before-c");
    if (BagNative.AllowedName("notepad") || BagNative.AllowedName("PathOfExileMalware") || !BagNative.AllowedName("PathOfExileSteam")) throw new Exception("selftest-allowlist");
    passed.Add("exact-process-allowlist"); return passed.ToArray();
  }
}
'@

function Emit-Bag($value) {
  [Console]::WriteLine(($value | ConvertTo-Json -Depth 12 -Compress))
  [Console]::Out.Flush()
}

if ($SelfTest) {
  Emit-Bag @{ ok = $true; tests = @([BagInterlock]::SelfTest()); nativeInput = $false }
  exit 0
}

$script:BagOfflineOcr = [bool]$OfflineOcr
if (-not $OfflineOcr) {
  try { [void][BagNative]::SetProcessDpiAwareness(2) } catch {}
  $actualParentProcessId = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  if ($ParentProcessId -le 0) { $ParentProcessId = $actualParentProcessId }
  if ($ParentProcessId -ne $actualParentProcessId) { throw 'parent-process-mismatch' }
  $script:BagGuard = [BagInterlock]::Start($ParentProcessId, $StopFile)
}
$script:BagHwnd = [long]0
$script:BagPid = 0

function Get-BagWindow {
  if ($script:BagHwnd -ne 0) {
    $target = Get-Process -Id $script:BagPid -ErrorAction Stop
    $target.Refresh()
    if ([long]$target.MainWindowHandle -ne $script:BagHwnd -or -not [BagNative]::AllowedName($target.ProcessName)) { throw 'target-window-changed' }
    return $target
  }
  $targets = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and [BagNative]::AllowedName($_.ProcessName) })
  $active = [BagNative]::GetForegroundWindow()
  $target = $targets | Where-Object { $_.MainWindowHandle -eq $active } | Select-Object -First 1
  if (-not $target -and $targets.Count -eq 1) { $target = $targets[0] }
  if (-not $target) { throw 'target-window-missing-or-ambiguous' }
  $script:BagHwnd = [long]$target.MainWindowHandle
  $script:BagPid = [int]$target.Id
  return $target
}

function Get-BagRect {
  $target = Get-BagWindow
  $rect = New-Object BagRect
  $point = New-Object BagPoint
  if (-not [BagNative]::GetClientRect($target.MainWindowHandle, [ref]$rect) -or -not [BagNative]::ClientToScreen($target.MainWindowHandle, [ref]$point)) { throw 'client-rect-unavailable' }
  $focused = ([BagNative]::GetForegroundWindow() -eq $target.MainWindowHandle)
  return @{ hwnd = [string]$script:BagHwnd; pid = $script:BagPid; process = [string]$target.ProcessName; processName = [string]$target.ProcessName;
    foreground = $focused; foregroundIsPoe = $focused; left = $point.X; top = $point.Y; width = $rect.Right; height = $rect.Bottom }
}

function Assert-BagMutation($command, [bool]$focusOnly = $false) {
  if (-not $command.expectedHwnd -or [long]$command.expectedHwnd -eq 0) { throw 'expected-hwnd-required' }
  $null = Get-BagWindow
  if ([long]$command.expectedHwnd -ne $script:BagHwnd) { throw 'target-window-changed' }
  if (-not $focusOnly) { $script:BagGuard.Guard($script:BagHwnd) }
}

function Get-BagCursor([string]$outputPath = '', [BagCursorSnapshot]$expectedPointer = $null) {
  $cursor = [BagNative]::Cursor($outputPath)
  if ($null -ne $expectedPointer) { [BagNative]::RequireSamePointer($expectedPointer, $cursor) }
  $r = Get-BagRect
  return @{ x = $cursor.x; y = $cursor.y; clientX = $cursor.x - $r.left; clientY = $cursor.y - $r.top;
    visible = $cursor.visible; handle = [string]$cursor.handle; hotspotX = $cursor.hotspotX; hotspotY = $cursor.hotspotY;
    width = $cursor.width; height = $cursor.height; sha256 = $cursor.sha256; path = $cursor.path; rgbaBase64 = $cursor.rgbaBase64 }
}

function Resolve-BagKeys($value) {
  if ($value -is [array]) { $names = @($value) }
  else {
    $normalized = ([string]$value).ToLowerInvariant().Replace('+', '').Replace(' ', '')
    switch ($normalized) {
      'ctrlaltc' { $names = @('CTRL', 'ALT', 'C') }
      'ctrlc' { $names = @('CTRL', 'C') }
      'escape' { $names = @('ESC') }
      'esc' { $names = @('ESC') }
      default { throw 'unsupported-bag-key-chord' }
    }
  }
  $signature = (($names | ForEach-Object { ([string]$_).ToUpperInvariant() }) -join '+')
  switch ($signature) {
    'CTRL+ALT+C' { return @(17, 18, 67) }
    'CTRL+C' { return @(17, 67) }
    'ESC' { return @(27) }
    'ESCAPE' { return @(27) }
    default { throw 'unsupported-bag-key-chord' }
  }
}

function Get-BagExpectedCursor($command) {
  $hasX = $null -ne $command.PSObject.Properties['expectedCursorX']
  $hasY = $null -ne $command.PSObject.Properties['expectedCursorY']
  if ($hasX -ne $hasY) { throw 'expected-cursor-pair-required' }
  if (-not $hasX) { return $null }
  foreach ($value in @($command.expectedCursorX, $command.expectedCursorY)) {
    if ($null -eq $value -or $value -is [string] -or $value -is [bool] -or $value -is [array]) { throw 'expected-cursor-integer-required' }
    $number = [double]$value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or [Math]::Floor($number) -ne $number -or $number -lt [int]::MinValue -or $number -gt [int]::MaxValue) { throw 'expected-cursor-integer-required' }
  }
  return @{ x = [int]$command.expectedCursorX; y = [int]$command.expectedCursorY }
}

$script:BagOcrReady = $false
function Initialize-BagOcr {
  if ($script:BagOcrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $script:BagAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $script:BagOcr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $script:BagOcr) { throw 'ocr-language-unavailable' }
  $script:BagOcrReady = $true
}
function Await-BagWinRt($operation, $resultType) {
  $task = $script:BagAsTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  [void]$task.Wait()
  return $task.Result
}
function Invoke-BagOcr($command) {
  Initialize-BagOcr
  $fromFile = [bool]$command.path
  if ($script:BagOfflineOcr -and -not $fromFile) { throw 'offline-ocr-requires-saved-image' }
  $source = $null
  if ($fromFile) {
    if (-not [System.IO.Path]::IsPathRooted([string]$command.path)) { throw 'absolute-ocr-path-required' }
    $source = New-Object System.Drawing.Bitmap ([System.IO.Path]::GetFullPath([string]$command.path))
    $r = @{ left = 0; top = 0; width = $source.Width; height = $source.Height; foreground = $true }
  } else { $r = Get-BagRect }
  $x = if ($null -ne $command.left) { [int]$command.left } else { [int]$r.left }
  $y = if ($null -ne $command.top) { [int]$command.top } else { [int]$r.top }
  $w = if ($null -ne $command.width) { [int]$command.width } else { [int]$r.width }
  $h = if ($null -ne $command.height) { [int]$command.height } else { [int]$r.height }
  $scale = if ($command.scale) { [int]$command.scale } else { 1 }
  $padX = 0; $padY = 0
  $bitmap = $graphics = $scaled = $scaledGraphics = $memory = $stream = $writer = $software = $null
  try {
    if (-not $r.foreground -or $w -lt 1 -or $h -lt 1 -or $scale -lt 1 -or $scale -gt 3 -or $x -lt $r.left -or $y -lt $r.top -or ($x + $w) -gt ($r.left + $r.width) -or ($y + $h) -gt ($r.top + $r.height)) { throw 'ocr-region-invalid' }
    if (($w * $scale) -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or ($h * $scale) -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'ocr-image-too-large' }
    if ($fromFile) {
      $bitmap = $source.Clone((New-Object System.Drawing.Rectangle $x, $y, $w, $h), $source.PixelFormat)
    } else {
      $bitmap = New-Object System.Drawing.Bitmap $w, $h
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
    }
    [BagNative]::PrepareOcr($bitmap, [int]$command.textThreshold, [bool]$command.invert)
    if ($command.neutralContext) {
      $padX = 160; $padY = 40
      $padded = New-Object System.Drawing.Bitmap ($w + 2 * $padX), ($h + 2 * $padY)
      $padGraphics = [System.Drawing.Graphics]::FromImage($padded)
      $font = New-Object System.Drawing.Font 'Arial', 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
      $lightBackground = (([int]$command.textThreshold -gt 0) -xor [bool]$command.invert)
      try {
        $padGraphics.Clear($(if ($lightBackground) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::Black }))
        $padGraphics.DrawImageUnscaled($bitmap, $padX, $padY)
        $brush = if ($lightBackground) { [System.Drawing.Brushes]::Black } else { [System.Drawing.Brushes]::White }
        $anchorY = $padY + [Math]::Max(0, ($h - 35) / 2)
        $padGraphics.DrawString('sample', $font, $brush, 20, $anchorY)
        $padGraphics.DrawString('sample', $font, $brush, ($padX + $w + 24), $anchorY)
      } finally { $font.Dispose(); $padGraphics.Dispose() }
      $bitmap.Dispose(); $bitmap = $padded
    }
    if (($bitmap.Width * $scale) -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or ($bitmap.Height * $scale) -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'ocr-image-too-large' }
    # Large UI words stay legible at half size; whole-frame safety OCR is ~3x faster there.
    $downscale = if ($command.downscale) { [int]$command.downscale } else { 1 }
    if ($downscale -lt 1 -or $downscale -gt 3 -or ($downscale -gt 1 -and ($scale -ne 1 -or $command.neutralContext))) { throw 'ocr-downscale-invalid' }
    $scaled = New-Object System.Drawing.Bitmap ([int][Math]::Max(1, $bitmap.Width * $scale / $downscale)), ([int][Math]::Max(1, $bitmap.Height * $scale / $downscale))
    $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
    $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaledGraphics.DrawImage($bitmap, 0, 0, $scaled.Width, $scaled.Height)
    $memory = New-Object System.IO.MemoryStream
    $scaled.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
    $writer.WriteBytes($memory.ToArray())
    [void](Await-BagWinRt ($writer.StoreAsync()) ([UInt32]))
    $decoder = Await-BagWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await-BagWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-BagWinRt ($script:BagOcr.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $words = @($line.Words | Where-Object {
        -not $command.neutralContext -or ($_.BoundingRect.X -ge ($padX * $scale) -and $_.BoundingRect.Y -ge ($padY * $scale) -and
          ($_.BoundingRect.X + $_.BoundingRect.Width) -le (($padX + $w) * $scale) -and ($_.BoundingRect.Y + $_.BoundingRect.Height) -le (($padY + $h) * $scale))
      } | ForEach-Object { @{ text = [string]$_.Text; x = $x + [int]($_.BoundingRect.X * $downscale / $scale) - $padX; y = $y + [int]($_.BoundingRect.Y * $downscale / $scale) - $padY; w = [int]($_.BoundingRect.Width * $downscale / $scale); h = [int]($_.BoundingRect.Height * $downscale / $scale) } })
      if ($words.Count -eq 0) { continue }
      $minX = ($words | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
      $minY = ($words | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
      $maxX = ($words | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
      $maxY = ($words | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
      $lines += @{ text = $(if ($command.neutralContext) { [string](($words | ForEach-Object { $_.text }) -join ' ') } else { [string]$line.Text });
        words = $words; x = [int]$minX; y = [int]$minY; w = [int]($maxX - $minX); h = [int]($maxY - $minY) }
    }
    if (-not $fromFile -and [BagNative]::GetForegroundWindow().ToInt64() -ne $script:BagHwnd) { throw 'focus-lost-during-ocr' }
    return @{ text = $(if ($command.neutralContext) { [string](($lines | ForEach-Object { $_.text }) -join ' ') } else { [string]$result.Text });
      lines = $lines; coordinateSpace = $(if ($fromFile) { 'client' } else { 'screen' }); path = [string]$command.path;
      preprocessing = @{ textThreshold = [int]$command.textThreshold; invert = [bool]$command.invert; scale = $scale; neutralContext = [bool]$command.neutralContext } }
  } finally {
    foreach ($resource in @($software, $writer, $stream, $memory, $scaledGraphics, $scaled, $graphics, $bitmap, $source)) {
      if ($null -ne $resource -and $resource -is [System.IDisposable]) { $resource.Dispose() }
    }
  }
}

if ($OfflineOcr) { return }

try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'quit') { break }
    try {
      $command = $line | ConvertFrom-Json
      if ($command.op -eq 'quit') { Emit-Bag @{ ok = $true }; break }
      $result = @{}
      switch ([string]$command.op) {
        'state' {
          if (-not $command.monitorOnly) {
            try { $result = Get-BagRect }
            catch { $result = @{ foreground = $false; foregroundIsPoe = $false; windowError = [string]$_.Exception.Message } }
          }
          $result.nativeMonitorReady = $script:BagGuard.MonitorReady
          $result.parentProcessId = $ParentProcessId
          $result.stopReason = $script:BagGuard.StopReason
        }
        'rect' { $result = Get-BagRect }
        'cursor' { $result = @{ cursor = Get-BagCursor ([string]$command.path) } }
        'capture' {
          $r = Get-BagRect
          if (-not $r.foreground) { throw 'capture-requires-foreground' }
          if (-not $command.path -or -not [System.IO.Path]::IsPathRooted([string]$command.path)) { throw 'absolute-capture-path-required' }
          $capturePath = [System.IO.Path]::GetFullPath([string]$command.path)
          $bitmap = New-Object System.Drawing.Bitmap $r.width, $r.height
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $pointerBefore = [BagNative]::Pointer()
          $capturedAt = [DateTime]::UtcNow.ToString('o')
          try {
            $graphics.CopyFromScreen($r.left, $r.top, 0, 0, $bitmap.Size)
            $pointerAfter = [BagNative]::Pointer()
            [BagNative]::RequireSamePointer($pointerBefore, $pointerAfter)
            $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Bmp)
          }
          finally { $graphics.Dispose(); $bitmap.Dispose() }
          $result = $r
          $result.path = $capturePath
          $result.capturedAt = $capturedAt
          $result.sha256 = [BagNative]::Hash([System.IO.File]::ReadAllBytes($capturePath))
          $result.cursor = Get-BagCursor ([System.IO.Path]::ChangeExtension($capturePath, '.cursor.png')) $pointerAfter
          $result.pointerBefore = @{ x = $pointerBefore.x; y = $pointerBefore.y; handle = [string]$pointerBefore.handle; visible = $pointerBefore.visible }
          $result.pointerAfter = @{ x = $pointerAfter.x; y = $pointerAfter.y; handle = [string]$pointerAfter.handle; visible = $pointerAfter.visible }
          if ([BagNative]::GetForegroundWindow().ToInt64() -ne $script:BagHwnd) { throw 'focus-lost-during-capture' }
        }
        'clipboard' { $result.text = [string][System.Windows.Forms.Clipboard]::GetText() }
        'setclipboard' { Assert-BagMutation $command; [System.Windows.Forms.Clipboard]::SetText([string]$command.text) }
        'ocr' { $result = Invoke-BagOcr $command }
        'focus' { Assert-BagMutation $command $true; $script:BagGuard.Focus($script:BagHwnd); $result.focused = $true }
        'move' {
          Assert-BagMutation $command
          if ($null -eq $command.x -or $null -eq $command.y -or -not [BagNative]::InsideTarget($script:BagHwnd, [int]$command.x, [int]$command.y)) { throw 'coordinates-outside-client' }
          $script:BagGuard.Move($script:BagHwnd, [int]$command.x, [int]$command.y)
        }
        'hotkey' {
          $expectedCursor = Get-BagExpectedCursor $command
          Assert-BagMutation $command
          $keys = [int[]](Resolve-BagKeys $command.keys)
          if ($null -eq $expectedCursor) { $script:BagGuard.Hotkey($script:BagHwnd, $keys) }
          else { $script:BagGuard.Hotkey($script:BagHwnd, $keys, $expectedCursor.x, $expectedCursor.y) }
        }
        { $_ -in @('click', 'rightclick') } {
          Assert-BagMutation $command
          if ($null -ne $command.x -or $null -ne $command.y) {
            if ($null -eq $command.x -or $null -eq $command.y -or -not [BagNative]::InsideTarget($script:BagHwnd, [int]$command.x, [int]$command.y)) { throw 'coordinates-outside-client' }
            $script:BagGuard.Move($script:BagHwnd, [int]$command.x, [int]$command.y)
          }
          $cursor = [BagNative]::Cursor('')
          if (-not [BagNative]::InsideTarget($script:BagHwnd, $cursor.x, $cursor.y)) { throw 'cursor-outside-client' }
          $modifier = 0
          if ($command.modifier) {
            if ($command.modifier -eq 'ctrl') { $modifier = 17 }
            elseif ($command.modifier -eq 'alt') { $modifier = 18 }
            else { throw 'invalid-click-modifier' }
          }
          $script:BagGuard.Click($script:BagHwnd, ($command.op -eq 'rightclick'), $modifier)
        }
        'readitem' {
          # One hover + advanced-copy chord; the reply carries the text only when the
          # clipboard sequence advanced after this chord at this pointer position.
          Assert-BagMutation $command
          if ($null -eq $command.x -or $null -eq $command.y -or -not [BagNative]::InsideTarget($script:BagHwnd, [int]$command.x, [int]$command.y)) { throw 'coordinates-outside-client' }
          $hover = if ($null -ne $command.hoverMs) { [int]$command.hoverMs } else { 120 }
          $timeout = if ($null -ne $command.timeoutMs) { [int]$command.timeoutMs } else { 150 }
          $watch = [System.Diagnostics.Stopwatch]::StartNew()
          $copied = $script:BagGuard.ReadItem($script:BagHwnd, [int]$command.x, [int]$command.y, $hover, $timeout, [int[]]@(17, 18, 67), [BagNative]::ClipboardSequenceReader)
          $text = ''
          if ($copied) {
            for ($attempt = 0; $attempt -lt 6 -and -not $text; $attempt++) {
              try { $text = [string][System.Windows.Forms.Clipboard]::GetText() } catch { $text = '' }
              if (-not $text) { [System.Threading.Thread]::Sleep(5) }
            }
          }
          $result = @{ copied = [bool]$copied; text = $text; waitedMs = $script:BagGuard.ReadWaitedMs; elapsedMs = $watch.ElapsedMilliseconds }
        }
        'clickchain' {
          Assert-BagMutation $command
          $points = @($command.points)
          if ($points.Count -lt 1 -or $points.Count -gt 60) { throw 'invalid-click-chain' }
          $xs = New-Object 'int[]' $points.Count; $ys = New-Object 'int[]' $points.Count
          for ($i = 0; $i -lt $points.Count; $i++) {
            if ($null -eq $points[$i].x -or $null -eq $points[$i].y -or -not [BagNative]::InsideTarget($script:BagHwnd, [int]$points[$i].x, [int]$points[$i].y)) { throw 'coordinates-outside-client' }
            $xs[$i] = [int]$points[$i].x; $ys[$i] = [int]$points[$i].y
          }
          $settle = if ($null -ne $command.settleMs) { [int]$command.settleMs } else { 40 }
          $gap = if ($null -ne $command.gapMs) { [int]$command.gapMs } else { 60 }
          if ($command.ctrl -and $command.shift) { throw 'invalid-chain-modifiers' }
          $chainModifier = if ($command.ctrl) { 17 } elseif ($command.shift) { 16 } else { 0 }
          try { $script:BagGuard.ClickChain($script:BagHwnd, $xs, $ys, [bool]$command.right, [int]$chainModifier, $settle, $gap) }
          catch {
            $failure = if ($_.Exception.InnerException) { [string]$_.Exception.InnerException.Message } else { [string]$_.Exception.Message }
            # A chain that already emitted clicks is partial input; the count is the accounting boundary.
            if ($script:BagGuard.ChainCompleted -gt 0) { throw ('partial-input:' + $script:BagGuard.ChainCompleted + ':' + $failure) }
            throw $failure
          }
          $result = @{ count = $script:BagGuard.ChainCompleted }
        }
        'regions' {
          # Small client-space rectangles from ONE screen copy. Used between fast bag
          # actions where a whole 4K frame is unnecessary; each rectangle is saved
          # as evidence and hashed exactly like a full capture.
          $r = Get-BagRect
          if (-not $r.foreground) { throw 'capture-requires-foreground' }
          if (-not $command.path -or -not [System.IO.Path]::IsPathRooted([string]$command.path)) { throw 'absolute-capture-path-required' }
          $rects = @($command.rects)
          if ($rects.Count -lt 1 -or $rects.Count -gt 8) { throw 'invalid-capture-regions' }
          $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = 0; $maxY = 0
          foreach ($rect in $rects) {
            foreach ($value in @($rect.x, $rect.y, $rect.w, $rect.h)) { if ($null -eq $value -or $value -is [string]) { throw 'invalid-capture-regions' } }
            if ([int]$rect.x -lt 0 -or [int]$rect.y -lt 0 -or [int]$rect.w -lt 1 -or [int]$rect.h -lt 1 -or ([int]$rect.x + [int]$rect.w) -gt $r.width -or ([int]$rect.y + [int]$rect.h) -gt $r.height) { throw 'capture-region-outside-client' }
            $minX = [Math]::Min($minX, [int]$rect.x); $minY = [Math]::Min($minY, [int]$rect.y)
            $maxX = [Math]::Max($maxX, [int]$rect.x + [int]$rect.w); $maxY = [Math]::Max($maxY, [int]$rect.y + [int]$rect.h)
          }
          $base = [System.IO.Path]::GetFullPath([string]$command.path)
          $bitmap = New-Object System.Drawing.Bitmap ($maxX - $minX), ($maxY - $minY), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $pointerBefore = [BagNative]::Pointer()
          $capturedAt = [DateTime]::UtcNow.ToString('o')
          $files = @()
          try {
            $graphics.CopyFromScreen(($r.left + $minX), ($r.top + $minY), 0, 0, $bitmap.Size)
            $pointerAfter = [BagNative]::Pointer()
            [BagNative]::RequireSamePointer($pointerBefore, $pointerAfter)
            for ($i = 0; $i -lt $rects.Count; $i++) {
              $rect = $rects[$i]
              $crop = $bitmap.Clone((New-Object System.Drawing.Rectangle ([int]$rect.x - $minX), ([int]$rect.y - $minY), ([int]$rect.w), ([int]$rect.h)), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
              try { $file = "$base.$i.bmp"; $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Bmp) } finally { $crop.Dispose() }
              $files += @{ path = $file; x = [int]$rect.x; y = [int]$rect.y; w = [int]$rect.w; h = [int]$rect.h; sha256 = [BagNative]::Hash([System.IO.File]::ReadAllBytes($file)) }
            }
          } finally { $graphics.Dispose(); $bitmap.Dispose() }
          $result = $r
          $result.capturedAt = $capturedAt
          $result.files = $files
          if ($command.cursorArt) { $result.cursor = Get-BagCursor '' $pointerAfter }
          else { $result.cursor = @{ x = $pointerAfter.x; y = $pointerAfter.y; clientX = $pointerAfter.x - $r.left; clientY = $pointerAfter.y - $r.top; visible = $pointerAfter.visible; handle = [string]$pointerAfter.handle } }
          if ([BagNative]::GetForegroundWindow().ToInt64() -ne $script:BagHwnd) { throw 'focus-lost-during-capture' }
        }
        'selftest' { $result = @{ tests = @([BagInterlock]::SelfTest()); nativeInput = $false } }
        default { throw 'unsupported-bag-operation' }
      }
      $result.ok = $true
      $result.stopped = $script:BagGuard.Stopped
      $result.paused = $script:BagGuard.Paused
      $result.at = [DateTime]::UtcNow.ToString('o')
      Emit-Bag $result
    } catch {
      Emit-Bag @{ ok = $false; error = [string]$_.Exception.Message; stopped = $script:BagGuard.Stopped; paused = $script:BagGuard.Paused; at = [DateTime]::UtcNow.ToString('o') }
    }
  }
} finally { $script:BagGuard.Dispose() }
