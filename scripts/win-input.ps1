param(
  [Parameter(Mandatory=$true)][ValidateSet("focus","click","ctrlclick","hotkey","rect")][string]$Op,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Keys = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AssistiveWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$proc = Get-Process | Where-Object { $_.ProcessName -match 'PathOfExile' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output '{"ok":false,"error":"no-poe-window"}'; exit 1 }
$hwnd = $proc.MainWindowHandle
[void][AssistiveWin]::ShowWindow($hwnd, 9)
[void][AssistiveWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 80

if ($Op -eq "rect") {
  $r = New-Object AssistiveWin+RECT
  [void][AssistiveWin]::GetWindowRect($hwnd, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  Write-Output (@{ ok = $true; left = $r.Left; top = $r.Top; width = $w; height = $h; process = $proc.ProcessName } | ConvertTo-Json -Compress)
  exit 0
}

if ($Op -eq "click" -or $Op -eq "ctrlclick") {
  [void][AssistiveWin]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 40
  if ($Op -eq "ctrlclick") {
    [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  }
  [AssistiveWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [AssistiveWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  if ($Op -eq "ctrlclick") {
    Start-Sleep -Milliseconds 20
    [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  }
  Write-Output '{"ok":true}'
  exit 0
}

if ($Op -eq "hotkey") {
  if ($Keys -eq "ctrlc") {
    [AssistiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [AssistiveWin]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [AssistiveWin]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
    [AssistiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  } elseif ($Keys -eq "i") {
    [AssistiveWin]::keybd_event(0x49, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [AssistiveWin]::keybd_event(0x49, 0, 2, [UIntPtr]::Zero)
  }
  Write-Output '{"ok":true}'
  exit 0
}

if ($Op -eq "focus") {
  Write-Output '{"ok":true}'
  exit 0
}
