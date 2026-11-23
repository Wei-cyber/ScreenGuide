import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Rectangle } from "electron";

const execFileAsync = promisify(execFile);

export interface CapturedWindowActivation {
  activated: boolean;
  bounds?: Rectangle;
}

export function windowHandleFromSourceId(sourceId: string): string | null {
  return /^window:(\d+):/.exec(sourceId)?.[1] ?? null;
}

export async function activateCapturedWindow(sourceId: string): Promise<CapturedWindowActivation | null> {
  const handle = windowHandleFromSourceId(sourceId);
  if (!handle || process.platform !== "win32") return null;

  // The handle is restricted to decimal digits before interpolation. This helper
  // restores and focuses only the window the user explicitly selected.
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScreenGuideWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
}
'@
$target = [IntPtr]::new([Int64]::Parse('${handle}'))
if (-not [ScreenGuideWindow]::IsWindow($target)) { exit 2 }
if ([ScreenGuideWindow]::IsIconic($target)) { [void][ScreenGuideWindow]::ShowWindowAsync($target, 9) }
[void][ScreenGuideWindow]::BringWindowToTop($target)
$activated = [ScreenGuideWindow]::SetForegroundWindow($target)
$rect = New-Object ScreenGuideWindow+RECT
$hasBounds = [ScreenGuideWindow]::DwmGetWindowAttribute($target, 9, [ref]$rect, [Runtime.InteropServices.Marshal]::SizeOf($rect)) -eq 0
if (-not $hasBounds) { $hasBounds = [ScreenGuideWindow]::GetWindowRect($target, [ref]$rect) }
[PSCustomObject]@{
  activated = $activated
  hasBounds = $hasBounds
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
} | ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, timeout: 5000, maxBuffer: 16_384 },
    );
    const value = JSON.parse(stdout.trim()) as {
      activated?: boolean;
      hasBounds?: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    const validBounds = value.hasBounds
      && [value.x, value.y, value.width, value.height].every(Number.isFinite)
      && Number(value.width) > 0
      && Number(value.height) > 0;
    return {
      activated: value.activated === true,
      bounds: validBounds
        ? { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) }
        : undefined,
    };
  } catch {
    return null;
  }
}
