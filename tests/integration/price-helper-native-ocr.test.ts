import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveWinHostScript } from "../../src/adapters/winHost.js";
import { priceHelperRow, type CategorySnapshot } from "../../src/core/priceHelper.js";

it.skipIf(process.platform !== "win32")("recognizes an in-memory bitmap through the real Windows OCR pipeline repeatedly", () => {
  const script = resolveWinHostScript("win-price-helper.ps1").replaceAll("'", "''");
  // Source the host with a quit command, then exercise only its bitmap decoder.
  // This test never captures the desktop, opens a window, or sends game input.
  const command = `
. '${script}'
$bitmap = New-Object System.Drawing.Bitmap 600, 120
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font 'Arial', 28
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('3x Divine Orb', $font, [System.Drawing.Brushes]::Black, 20, 25)
  foreach ($attempt in 1..2) {
    $lines = @(Convert-PriceBitmapToLines $bitmap)
    [Console]::WriteLine((ConvertTo-Json -InputObject $lines -Compress))
  }
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
    input: "quit\n", encoding: "utf8", timeout: 25_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const attempts = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as Array<{ text: string; y: number; height: number }>);
  expect(attempts).toHaveLength(2);
  for (const lines of attempts) {
    expect(lines.map(line => line.text).join(" ")).toBe("3x Divine Orb");
    expect(lines[0].y).toBeGreaterThan(0);
    expect(lines[0].height).toBeGreaterThan(0);
  }
}, 30_000);

it.skipIf(process.platform !== "win32")("prices both reported Runeshape rewards from native and scaled screenshot OCR", () => {
  const script = resolveWinHostScript("win-price-helper.ps1").replaceAll("'", "''");
  const fixture = fileURLToPath(new URL("../../fixtures/price-helper/runeshape-mystic-masterwork.png", import.meta.url)).replaceAll("'", "''");
  // The supplied reward-panel fixture contains no account data. No live capture or input.
  const command = `
. '${script}'
$attachment = New-Object System.Drawing.Bitmap '${fixture}'
try {
  foreach ($scale in @(1.0, 1.5)) {
    $crop = $bitmap = $graphics = $null
    try {
      $rect = New-Object System.Drawing.Rectangle 350, 165, 360, 125
      $crop = $attachment.Clone($rect, $attachment.PixelFormat)
      $bitmap = New-Object System.Drawing.Bitmap ([int](360 * $scale)), ([int](125 * $scale))
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($crop, 0, 0, $bitmap.Width, $bitmap.Height)
      $lines = @(Convert-PriceBitmapToLines $bitmap)
      [Console]::WriteLine((ConvertTo-Json -InputObject $lines -Compress))
    } finally { foreach ($resource in @($graphics, $bitmap, $crop)) { if ($null -ne $resource) { $resource.Dispose() } } }
  }
} finally { $attachment.Dispose() }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
    input: "quit\n", encoding: "utf8", timeout: 25_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  const attempts = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as Array<{ text: string; y: number; height: number }>);
  const now = Date.now();
  const snapshot: CategorySnapshot = { category: "Verisium", fetchedAt: new Date(now).toISOString(), prices: [
    { id: "mystic", name: "Mystic Alloy", chaos: 3, divine: 0.3 },
    { id: "masterwork", name: "Masterwork Rune", chaos: 8, divine: 0.8 },
  ] };
  expect(attempts).toHaveLength(2);
  for (const lines of attempts) {
    const rows = lines.map(line => priceHelperRow(line.text, [snapshot], now)).filter(row => row.name);
    expect(rows, JSON.stringify(lines)).toMatchObject([
      { name: "Mystic Alloy", state: "priced", currency: "chaos", unit: 3 },
      { name: "Masterwork Rune", state: "priced", currency: "chaos", unit: 8 },
    ]);
    expect(rows).toHaveLength(2);
    expect(lines.every(line => line.y >= 0 && line.height > 0)).toBe(true);
  }
}, 30_000);
