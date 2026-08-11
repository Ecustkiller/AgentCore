# Raise AgentCore Electron windows to the foreground.
# Used by shoot-graph-perf-live.mjs so CDP frame samples aren't measuring
# Chromium's occluded-window ~1Hz rAF throttle (visibilityState still "visible").
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

$targets = Get-Process | Where-Object {
  $_.ProcessName -eq 'electron' -and $_.MainWindowHandle -ne 0
}

if (-not $targets) {
  Write-Output "NO_WINDOW_FOUND"
  exit 1
}

foreach ($p in $targets) {
  $h = $p.MainWindowHandle
  Write-Output ("raising pid={0} title='{1}' handle={2}" -f $p.Id, $p.MainWindowTitle, $h)
  [Win32Fg]::ShowWindow($h, 9) | Out-Null      # SW_RESTORE
  [Win32Fg]::BringWindowToTop($h) | Out-Null
  # HWND_TOPMOST then NOTOPMOST forces a real raise past focus-steal guards.
  [Win32Fg]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0003) | Out-Null
  [Win32Fg]::SetWindowPos($h, [IntPtr]::new(-2), 0, 0, 0, 0, 0x0003) | Out-Null
  [Win32Fg]::SetForegroundWindow($h) | Out-Null
}
Start-Sleep -Milliseconds 800
Write-Output "RAISED"
