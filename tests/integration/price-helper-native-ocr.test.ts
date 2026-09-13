import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveWinHostScript } from "../../src/adapters/winHost.js";

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
