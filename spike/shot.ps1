# Start `npm run dev`, wait for the window to actually appear, screenshot that
# window, then clean everything up.
#
# Why one script: each DSH command runs in its own process tree, and the moment
# the command ends its Electron children are reaped -- "start" and "assert" must
# happen inside a single invocation. See docs/技术方案.md appendix B.
#
# The window is matched by PID, not by title alone. Matching by title picks up
# any other Terminal Manage instance that is already open -- you then screenshot
# the wrong window and, worse, the cleanup below kills that unrelated instance.
# So the candidate window must belong to the process tree we just started.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI unless the file
# carries a UTF-8 BOM, so non-ASCII source turns into mojibake and fails to parse.

param(
  [string]$Out = 'docs\screenshot-m2.png',
  [string]$TitleLike = 'Terminal Manage',
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# PW_RENDERFULLCONTENT. Without it an occluded window renders blank.
# SetForegroundWindow + CopyFromScreen is not an option: the Windows foreground
# lock refuses the activation and you end up capturing whatever is on top.
$PW_RENDERFULLCONTENT = 2

$script:foundHwnd = [IntPtr]::Zero

# Every PID descended from $RootPid, including it. Used both to decide which
# window is ours and to make sure cleanup cannot reach anything else.
function Get-ProcessTree([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId)
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$set.Add($RootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($null -eq $p) { continue }
      $ppid = [int]$p.ParentProcessId
      $pid2 = [int]$p.ProcessId
      if ($set.Contains($ppid) -and -not $set.Contains($pid2)) {
        [void]$set.Add($pid2)
        $changed = $true
      }
    }
  }
  return $set
}

function Find-AppWindow([string]$needle, $PidSet) {
  $script:foundHwnd = [IntPtr]::Zero
  $callback = [Win32+EnumWindowsProc] {
    param($hWnd, $lParam)
    if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }

    # Ownership check first: it is cheap and it is the whole point of this loop.
    $wpid = [uint32]0
    [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if (-not $PidSet.Contains([int]$wpid)) { return $true }

    $buf = New-Object System.Text.StringBuilder 512
    [void][Win32]::GetWindowTextW($hWnd, $buf, 512)
    $text = $buf.ToString()
    if ($text -and $text.Contains($needle)) {
      $script:foundHwnd = $hWnd
      return $false
    }
    return $true
  }
  [void][Win32]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:foundHwnd
}

$stdout = Join-Path $root 'dev.log'
$stderr = Join-Path $root 'dev.err'
Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

$env:TM_DEBUG = '1'
$proc = Start-Process npm.cmd -ArgumentList 'run', 'dev' -NoNewWindow -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

Write-Host "dev started pid=$($proc.Id), waiting for window..."

$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  # The tree grows while electron-vite spawns vite and electron, so re-read it
  # each poll; a PID set captured once at the top would miss the window.
  $tree = Get-ProcessTree $proc.Id
  $hwnd = Find-AppWindow $TitleLike $tree
  if ($hwnd -ne [IntPtr]::Zero) { break }
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Host 'FAILED: no window found'
  Write-Host '--- dev.log tail ---'
  Get-Content $stdout -Tail 30 -ErrorAction SilentlyContinue
  Write-Host '--- dev.err tail ---'
  Get-Content $stderr -Tail 30 -ErrorAction SilentlyContinue
  taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
  exit 1
}

# Give the renderer a moment to paint the first frame before capturing.
Start-Sleep -Seconds 2

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

Write-Host "window HWND=$hwnd size=${width}x${height} at ($($rect.Left),$($rect.Top))"

$bmp = New-Object System.Drawing.Bitmap $width, $height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [Win32]::PrintWindow($hwnd, $hdc, $PW_RENDERFULLCONTENT)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()

$outPath = Join-Path $root $Out
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "PrintWindow=$ok -> $outPath"

Write-Host '--- debug.log tail ---'
# Respect the same userData override the app itself honours, so this reads the
# log of the instance we just started instead of the user's real one.
$debugLog = if ($env:TM_USER_DATA) {
  Join-Path $env:TM_USER_DATA 'debug.log'
} else {
  Join-Path $env:APPDATA 'terminal-manage\debug.log'
}
Get-Content $debugLog -Tail 12 -ErrorAction SilentlyContinue

# Only ever tear down what this script started. Every electron.exe on the
# machine would include the user's own running instance.
taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
Write-Host 'cleaned up'
exit 0
