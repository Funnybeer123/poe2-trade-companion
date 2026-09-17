# Ctrl+Shift+Esc is reserved by Windows and may fail RegisterHotKey.
# Observe it independently of capture/input queues; do not suppress Task Manager.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class EmergencyKeys {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  public static void Watch() {
    Console.WriteLine("ready"); Console.Out.Flush();
    bool wasDown = false;
    while (true) {
      bool down = (GetAsyncKeyState(0x11) & 0x8000) != 0 && (GetAsyncKeyState(0x10) & 0x8000) != 0 && (GetAsyncKeyState(0x1B) & 0x8000) != 0;
      if (down && !wasDown) { Console.WriteLine("stop"); Console.Out.Flush(); }
      wasDown = down;
      Thread.Sleep(8);
    }
  }
}
'@
[EmergencyKeys]::Watch()
