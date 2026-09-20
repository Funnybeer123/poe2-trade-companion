# Ctrl+Shift+M or Ctrl+Shift+F RESUMES following; Ctrl+Shift+H holds the PC for the human.
#
# Idempotent chords, never a toggle. A toggle was the first design and it failed live: the operator
# cannot see the status line (the follower usually runs in another window), so a press is a coin flip -
# pressing to resume STOPS a follower that was already following. Over one 1,910 s run the chord fired 17
# times, alternating perfectly, and was still reported as "did not bring it back".
#
# M resumes because that is what it is reached for. Splitting take/give did not settle it: on four
# separate occasions M was pressed meaning "go", the last 16.6 s into a fresh run, parking a follower
# that was already following. Muscle memory is the requirement, so M and F BOTH resume and holding moved
# to H. Taking control needs no key anyway - touching the mouse already does it.
#
# Deliberate takeover, as distinct from the two mechanisms either side of it: the cursor-movement guard
# in win-follower-input-host.ps1 is reactive and resumes 1.5 s after the mouse rests, which is no use for
# playing this character for a while; Ctrl+Shift+Esc latches the kill switch and cannot be rearmed from
# the CLI at all. This sits between them - it holds for as long as you want and gives control back.
#
# Observe the keys independently of the capture/input queues, exactly as the emergency stop does, so a
# busy or wedged worker can never delay the human taking over. This script has no input API by design:
# it only ever reads key state and writes a line. That is asserted by tests/follower-manual-control.test.ts.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ManualControlKeys {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  public static void Watch() {
    Console.WriteLine("ready"); Console.Out.Flush();
    bool wasDown = false, wasGive = false;
    while (true) {
      // 0x11 Ctrl, 0x10 Shift, 0x48 H, 0x4D M, 0x46 F. Edge-triggered: one line per fresh press, never a repeat while held.
      bool mods = (GetAsyncKeyState(0x11) & 0x8000) != 0 && (GetAsyncKeyState(0x10) & 0x8000) != 0;
      bool take = mods && (GetAsyncKeyState(0x48) & 0x8000) != 0;                                        // H: hold it for me
      bool give = mods && ((GetAsyncKeyState(0x4D) & 0x8000) != 0 || (GetAsyncKeyState(0x46) & 0x8000) != 0);  // M or F: follow again
      if (take && !wasDown) { Console.WriteLine("take"); Console.Out.Flush(); }
      if (give && !wasGive) { Console.WriteLine("give"); Console.Out.Flush(); }
      wasDown = take; wasGive = give;
      Thread.Sleep(8);
    }
  }
}
'@
[ManualControlKeys]::Watch()
