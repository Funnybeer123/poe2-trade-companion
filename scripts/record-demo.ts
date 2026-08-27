import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpegPath = [
  path.join(os.tmpdir(), "poe2-ffmpeg", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
  path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
].find((candidate) => existsSync(candidate));
if (!ffmpegPath) {
  throw new Error("ffmpeg-static is not installed. Run npm install --prefix %TEMP%\\poe2-ffmpeg ffmpeg-static");
}
const outDir = path.join(root, "artifacts", "demo");
const mp4Path = path.join(outDir, "poe2-item-intelligence-demo.mp4");

const ITEM_TEXT = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Turn",
  "Ruby Ring",
  "--------",
  "Requirements:",
  "Level: 50",
  "--------",
  "Item Level: 75",
  "--------",
  "+30% to Fire Resistance (implicit)",
  "--------",
  "+100 to maximum Life",
  "+35% to Cold Resistance",
].join("\n");

const BUILD_QUERY = JSON.stringify(
  {
    query: {
      type: "Ruby Ring",
      stats: [],
      filters: {
        type_filters: {
          filters: {
            category: { option: "accessory.ring" },
          },
        },
      },
    },
    sort: { price: "asc" },
  },
  null,
  2,
);

async function hold(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

async function openWorkspace(
  page: Page,
  label: string,
  heading: string,
): Promise<void> {
  await page
    .locator("aside.side-rail")
    .getByRole("link", { name: new RegExp(`^${label}\\b`) })
    .click();
  await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
}

function windowBounds(): { x: number; y: number; width: number; height: number } {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DemoWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][DemoWin]::SetProcessDPIAware()
$process = Get-Process electron | Where-Object { $_.MainWindowTitle -match 'PoE2 Intelligence' } | Select-Object -First 1
if (-not $process) { throw 'demo-window-not-found' }
[void][DemoWin]::SetForegroundWindow($process.MainWindowHandle)
Start-Sleep -Milliseconds 200
$rect = New-Object DemoWin+RECT
[void][DemoWin]::GetWindowRect($process.MainWindowHandle, [ref]$rect)
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = [Math]::Max($screen.X, $rect.Left)
$y = [Math]::Max($screen.Y, $rect.Top)
$right = [Math]::Min($screen.Right, $rect.Right)
$bottom = [Math]::Min($screen.Bottom, $rect.Bottom)
Write-Output ("{0} {1} {2} {3}" -f $x, $y, ($right - $x), ($bottom - $y))
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  const match = result.stdout.match(/(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/);
  if (!match) {
    throw new Error(
      `Could not locate the demo window.\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

function even(value: number): number {
  return value - (value % 2);
}

mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page =
  browser.contexts().flatMap((context) => context.pages())[0] ??
  (await browser.contexts()[0]?.waitForEvent("page"));
if (!page) throw new Error("No Electron page was exposed on the debug port.");
await page.locator("#app").waitFor({ timeout: 20_000 });
await page.bringToFront();
await hold(page, 400);

const bounds = windowBounds();
console.log(`capture ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`);
const ffmpeg = spawn(
  ffmpegPath,
  [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "30",
    "-offset_x",
    String(Math.max(0, bounds.x)),
    "-offset_y",
    String(Math.max(0, bounds.y)),
    "-video_size",
    `${even(bounds.width)}x${even(bounds.height)}`,
    "-i",
    "desktop",
    "-t",
    "30",
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "fast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let ffmpegError = "";
ffmpeg.stderr.on("data", (chunk) => {
  ffmpegError += chunk.toString();
});
const ffmpegDone = new Promise<void>((resolve, reject) => {
  ffmpeg.on("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(ffmpegError || `ffmpeg exited ${code}`));
  });
});

await hold(page, 800);
await page.goto("http://localhost:5173/#/items");
await page.getByRole("heading", { name: "Item intelligence", exact: true }).waitFor();
await hold(page, 700);

await page.getByLabel("Path of Exile item text").fill(ITEM_TEXT);
await hold(page, 1100);
await page.getByRole("button", { name: "Evaluate text", exact: true }).click();
await page.getByRole("heading", { name: "Doom Turn", exact: true }).waitFor();
await hold(page, 2800);
await page.locator(".valuation-panel").scrollIntoViewIfNeeded().catch(() => undefined);
await hold(page, 2400);

await openWorkspace(page, "Finder", "Stash query finder");
await hold(page, 700);
await page.getByRole("button", { name: "Generate validated queries", exact: true }).click();
await page.locator(".query-card code").first().waitFor();
await hold(page, 3000);

await openWorkspace(page, "Builds", "Build profiles");
await hold(page, 600);
await page.getByLabel("New profile name").fill("Ruby ring hunter");
await page.getByLabel("Links or query JSON").fill(BUILD_QUERY);
await hold(page, 700);
await page.getByRole("button", { name: "Import as new profile", exact: true }).click();
await page.getByText("1 added · 0 updated", { exact: true }).waitFor();
await hold(page, 2000);

await openWorkspace(page, "Items", "Item intelligence");
await page.getByText("Doom Turn", { exact: true }).first().waitFor();
await hold(page, 2200);

await ffmpegDone;
await browser.close();
console.log(mp4Path);
