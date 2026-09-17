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
using System.Threading;
public struct CombatRect { public int Left, Top, Right, Bottom; }
public struct CombatPoint { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct CombatKey { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] public struct CombatMouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] public struct CombatUnion { [FieldOffset(0)] public CombatKey Key; [FieldOffset(0)] public CombatMouse Mouse; }
[StructLayout(LayoutKind.Sequential)] public struct CombatInput { public uint Type; public CombatUnion Data; }
public sealed class CombatTriggerEdge {
  public long Id, At, AgeMs;
  public string Hwnd;
}
public sealed class CombatTriggerSnapshot {
  public CombatTriggerEdge Trigger;
  public bool Down;
}
// Pure edge detector. Native events and sample requests use the same lock; there
// is one pending edge, never a queue of casts to replay after a busy period.
public sealed class CombatTriggerState {
  readonly object gate = new object();
  int key;
  bool down;
  long sequence;
  CombatTriggerEdge pending;
  public void Configure(int nextKey, bool alreadyHeld) {
    lock (gate) { key = nextKey; down = nextKey != 0 && alreadyHeld; pending = null; }
  }
  public void Observe(int observedKey, bool pressed, bool injected, IntPtr window, long now) {
    lock (gate) {
      // Injected up events must not release a physically held key either.
      if (key == 0 || observedKey != key || injected) return;
      if (!pressed) { down = false; return; }
      if (down) return; // Windows key-repeat is not a new physical press.
      down = true;
      pending = new CombatTriggerEdge { Id = ++sequence, Hwnd = window.ToInt64().ToString(), At = now };
    }
  }
  public CombatTriggerSnapshot Consume(long now) {
    lock (gate) {
      CombatTriggerEdge edge = pending;
      pending = null;
      if (edge != null) edge.AgeMs = Math.Max(0, now - edge.At);
      return new CombatTriggerSnapshot { Trigger = edge, Down = down };
    }
  }
}
// A low-level hook needs a continuously pumped message thread. It only observes
// physical edges: R reaches the game unchanged, including while the macro is busy.
public static class CombatTriggerMonitor {
  [StructLayout(LayoutKind.Sequential)] struct KeyboardEvent { public uint Vk, Scan, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public CombatPoint Point; public uint Private; }
  delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll", SetLastError=true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint flags);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
  static readonly object lifecycle = new object();
  static readonly CombatTriggerState state = new CombatTriggerState();
  static readonly HookProc callback = OnKeyboard;
  static Thread thread;
  static ManualResetEvent initialized;
  static volatile bool stopRequested;
  static uint threadId;
  static IntPtr hook;
  static volatile Exception failure;
  static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data) {
    try {
      int kind = message.ToInt32();
      if (code >= 0 && (kind == 0x100 || kind == 0x101 || kind == 0x104 || kind == 0x105)) {
        KeyboardEvent input = (KeyboardEvent)Marshal.PtrToStructure(data, typeof(KeyboardEvent));
        // Preserve the physical latch for modified presses, but make their edge
        // ineligible even if all modifiers are released before the next sample.
        IntPtr target = CombatWin.ModifiersDown() ? IntPtr.Zero : CombatWin.GetForegroundWindow();
        state.Observe((int)input.Vk, kind == 0x100 || kind == 0x104, (input.Flags & 0x12) != 0,
          target, CombatWin.Clock.ElapsedMilliseconds);
      }
    } catch (Exception error) { failure = error; state.Configure(0, false); }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }
  public static int TriggerCode(string key) {
    if (String.IsNullOrEmpty(key)) return 0;
    if (key.Length != 1 || !(key[0] >= 'A' && key[0] <= 'Z' || key[0] >= '0' && key[0] <= '9')) throw new Exception("Trigger must be a letter or digit");
    return key[0];
  }
  public static void Configure(string key) {
    int code = TriggerCode(key);
    lock (lifecycle) {
      Stop();
      failure = null;
      if (code == 0) return;
      stopRequested = false;
      ManualResetEvent ready = initialized = new ManualResetEvent(false);
      thread = new Thread(() => {
        try {
          threadId = GetCurrentThreadId();
          Message message;
          PeekMessage(out message, IntPtr.Zero, 0, 0, 0); // Create the thread queue before signalling readiness.
          hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
          if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot listen for the physical trigger key");
          if (!stopRequested) state.Configure(code, (GetAsyncKeyState(code) & 0x8000) != 0);
          ready.Set();
          int result = 0;
          while (!stopRequested && (result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
          }
          if (result < 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Trigger message loop failed");
        } catch (Exception error) { failure = error; }
        finally {
          if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
          state.Configure(0, false);
          ready.Set();
        }
      });
      thread.IsBackground = true;
      thread.Name = "Combat physical trigger";
      thread.Start();
      if (!ready.WaitOne(3000)) { Stop(); throw new Exception("Trigger listener startup timed out"); }
      if (failure != null) { Exception error = failure; Stop(); throw new Exception("Trigger listener failed", error); }
    }
  }
  static void Stop() {
    stopRequested = true;
    state.Configure(0, false);
    if (thread == null) return;
    if (thread.IsAlive) {
      PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); // WM_QUIT
      if (!thread.Join(2000)) throw new Exception("Trigger listener did not stop");
    }
    thread = null; threadId = 0;
    if (initialized != null) { initialized.Dispose(); initialized = null; }
  }
  public static CombatTriggerSnapshot Consume() {
    if (failure != null) throw new Exception("Trigger listener failed", failure);
    return state.Consume(CombatWin.Clock.ElapsedMilliseconds);
  }
  public static void Dispose() { lock (lifecycle) { Stop(); } }
}
public static class CombatWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out CombatRect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref CombatPoint point);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out CombatPoint point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(CombatPoint point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
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
    // Up to five regions: health, mana, the two skill icons and the anchor.
    if (regions == null || regions.Length % 6 != 0 || regions.Length > 30) throw new Exception("Invalid HUD regions");
    if (regions.Length == 0) return new byte[0][]; // Manual-trigger mode needs window guards, not a bitmap.
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
  public static bool PreviewWindowMatches(IntPtr window, Rectangle bounds) {
    return GetForegroundWindow() == window && Allowed(ProcessName(window)) && Bounds(window) == bounds;
  }
  public static bool WaitForStablePreview(Func<bool> eligible, Func<long> now, Action<int> wait) {
    long started = now();
    while (true) {
      if (!eligible()) return false;
      long remaining = 750 - (now() - started);
      if (remaining <= 0) return true;
      wait((int)Math.Min(25, remaining));
    }
  }
  public static bool SettlePreview(IntPtr window, Rectangle bounds) {
    // Calibration only: give the operator time to cast after activating the
    // game. A focus or client-rectangle change requires a fresh full interval.
    return WaitForStablePreview(() => PreviewWindowMatches(window, bounds), () => Clock.ElapsedMilliseconds, milliseconds => System.Threading.Thread.Sleep(milliseconds));
  }
  public static string Preview(Rectangle bounds) {
    using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) { graphics.CopyFromScreen(bounds.Location, Point.Empty, bitmap.Size); }
      using (MemoryStream stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); return Convert.ToBase64String(stream.ToArray()); }
    }
  }
  public static int BindingCode(string key) {
    if (key == "MOUSE5") return 0x06; // VK_XBUTTON2, used only to check held state.
    if (key == null || key.Length != 1 || !(key[0] >= 'A' && key[0] <= 'Z' || key[0] >= '0' && key[0] <= '9')) throw new Exception("Unsupported combat binding");
    return key[0];
  }
  public static CombatInput[] TapEvents(string key) {
    int code = BindingCode(key);
    CombatInput down = new CombatInput();
    if (key == "MOUSE5") {
      down.Type = 0; down.Data.Mouse.Data = 2; down.Data.Mouse.Flags = 0x0080; // XBUTTON2 / XDOWN; no movement.
      CombatInput up = down; up.Data.Mouse.Flags = 0x0100; // XUP
      return new [] { down, up };
    }
    down.Type = 1; down.Data.Key.Vk = (ushort)code;
    CombatInput keyUp = down; keyUp.Data.Key.Flags = 2;
    return new [] { down, keyUp };
  }
  public static void Tap(string key, string expectedWindow) {
    CombatInput[] events = TapEvents(key);
    IntPtr window = Foreground();
    if (window.ToInt64().ToString() != expectedWindow || window != sampledWindow) throw new Exception("Game window changed");
    if (Clock.ElapsedMilliseconds - sampledAt > 120 || Bounds(window) != sampledRect) throw new Exception("Stale capture or window moved");
    if (key == "MOUSE5") {
      CombatPoint cursor;
      if (!GetCursorPos(out cursor) || !sampledRect.Contains(cursor.X, cursor.Y) || GetAncestor(WindowFromPoint(cursor), 2) != window) throw new Exception("Keep the cursor over the game for Mouse Button 5");
    }
    if (ModifiersDown() || (GetAsyncKeyState(BindingCode(key)) & 0x8000) != 0) throw new Exception("Modifier or action binding held");
    // Down/up in one OS batch: no held key if the worker is terminated.
    uint sent = SendInput(2, events, Marshal.SizeOf(typeof(CombatInput)));
    if (sent != 2) {
      SendInput(1, new [] { events[1] }, Marshal.SizeOf(typeof(CombatInput)));
      throw new Exception("Windows rejected combat input");
    }
  }
}
'@
try { [void][CombatWin]::SetProcessDpiAwareness(2) } catch {}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -eq 'quit') { break }
  $isSample = $false
  $triggerSnapshot = $null
  try {
    $command = $line | ConvertFrom-Json
    if ($command.op -eq 'ping') {
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'configureTrigger') {
      [CombatTriggerMonitor]::Configure([string]$command.key)
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'completeTriggerCycle') {
      # Define cycle completion on the native listener: discard presses that
      # arrived during the final action without releasing the physical latch.
      $null = [CombatTriggerMonitor]::Consume()
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'tap') {
      [CombatWin]::Tap([string]$command.key, [string]$command.expectedHwnd)
      $reply = @{ ok = $true }
    } elseif ($command.op -eq 'preview' -or $command.op -eq 'sample') {
      if ($command.op -eq 'sample') {
        $isSample = $true
        # Consume before every guard, so failed captures cannot defer a press.
        $triggerSnapshot = [CombatTriggerMonitor]::Consume()
      }
      $window = [CombatWin]::Foreground()
      $bounds = [CombatWin]::Bounds($window)
      if ($command.op -eq 'preview') {
        if (-not [CombatWin]::SettlePreview($window, $bounds)) { throw 'Focus Path of Exile 2 to continue' }
        $image = [CombatWin]::Preview($bounds)
        if (-not [CombatWin]::PreviewWindowMatches($window, $bounds)) { throw 'Focus Path of Exile 2 to continue' }
        $reply = @{ ok = $true; image = ('data:image/png;base64,' + $image); width = $bounds.Width; height = $bounds.Height }
      } else {
        if ([CombatWin]::ModifiersDown()) { throw 'Release modifier keys to resume' }
        [CombatWin]::BeginSample($window, $bounds)
        $samples = @{}
        $regionValues = New-Object 'System.Collections.Generic.List[int]'
        $regionNames = New-Object 'System.Collections.Generic.List[string]'
        foreach ($name in @('health', 'mana', 'unleash', 'verisium', 'anchor')) {
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
  if ($isSample) {
    $reply.triggerDown = $null -ne $triggerSnapshot -and $triggerSnapshot.Down
    if ($reply.ok -and $null -ne $triggerSnapshot.Trigger) {
      $edge = $triggerSnapshot.Trigger
      $reply.trigger = @{ id = $edge.Id; hwnd = $edge.Hwnd; ageMs = [Math]::Max(0, [CombatWin]::Clock.ElapsedMilliseconds - $edge.At) }
    }
  }
  [Console]::WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
} } finally { [CombatTriggerMonitor]::Dispose() }
