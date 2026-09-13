import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveWinHostScript } from "../../src/adapters/winHost.js";
import { priceHelperRow, type CategorySnapshot } from "../../src/core/priceHelper.js";
import { identifyHelperReward, parseRewardCatalog } from "../../src/core/helperReward.js";

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

it.skipIf(process.platform !== "win32")("identifies all six level-20 Runeshape gems from the supplied screenshot through native OCR", () => {
  const script = resolveWinHostScript("win-price-helper.ps1").replaceAll("'", "''");
  const fixture = fileURLToPath(new URL("../../fixtures/price-helper/runeshape-level20-skills.png", import.meta.url)).replaceAll("'", "''");
  // Decode the supplied panel offline through the same function used by the scanner.
  // Keep the verified crop and original pixel scale; never capture or operate the game.
  const command = `
. '${script}'
$attachment = New-Object System.Drawing.Bitmap '${fixture}'
$crop = $null
try {
  $rect = New-Object System.Drawing.Rectangle 250, 155, 491, 613
  $crop = $attachment.Clone($rect, $attachment.PixelFormat)
  $lines = @(Convert-PriceBitmapToLines $crop)
  [Console]::WriteLine((ConvertTo-Json -InputObject $lines -Compress))
} finally { if ($null -ne $crop) { $crop.Dispose() }; $attachment.Dispose() }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
    input: "quit\n", encoding: "utf8", timeout: 25_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  const lines = JSON.parse(result.stdout.trim()) as Array<{ text: string; y: number; height: number }>;
  const names = ["Rain of Blades", "Wardbound Minions", "Voltaic Barrier", "Hollow Shell", "Explosive Transmutation", "Animus Splinters"];
  const catalog = parseRewardCatalog({ result: [{ id: "gem", entries: names.map(type => ({ type })) }] });
  const rewards = lines.map(line => ({ ...line, identity: identifyHelperReward(line.text, catalog) })).filter(row => row.identity);
  expect(rewards.map(row => row.identity), JSON.stringify(lines)).toEqual(names.map(name => ({ name, type: name, kind: "gem", gemLevel: 20, quantity: 1 })));
  // Each identity must remain in its own reward band, even if rune icons produce extra OCR lines.
  const expectedCenters = [32, 140, 248, 357, 465, 573];
  rewards.forEach((row, index) => {
    expect(row.y).toBeGreaterThanOrEqual(0); expect(row.height).toBeGreaterThan(0);
    expect(row.y + row.height).toBeLessThanOrEqual(613);
    expect(Math.abs(row.y + row.height / 2 - expectedCenters[index]!)).toBeLessThan(8);
    if (index) expect(row.y).toBeGreaterThan(rewards[index - 1]!.y + rewards[index - 1]!.height);
  });
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
