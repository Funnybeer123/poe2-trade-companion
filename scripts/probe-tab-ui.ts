/**
 * Read-only UI probe: full-screen OCR, then dump the strip rows, the
 * tab-list dropdown region, and anything near the list toggle (1287,212).
 * Sends NO clicks and never focuses the game — safe to run any time.
 *
 *   npx tsx scripts/probe-tab-ui.ts
 */
import { startWinHost } from "../src/adapters/winHost.js";

interface Line {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const host = startWinHost({ requestTimeoutMs: 30_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const reply = await host.send({ op: "ocr" });
  const lines = ((Array.isArray(reply.lines) ? reply.lines : []) as Line[]).sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  const show = (line: Line) => `  (${line.x},${line.y} ${line.w}x${line.h}) "${line.text}"`;

  console.log("== strip top row (y 180-245, x<1340) ==");
  for (const l of lines.filter((l) => l.y >= 180 && l.y <= 245 && l.x < 1340)) console.log(show(l));
  console.log("== strip folder row (y 250-320, x<1340) ==");
  for (const l of lines.filter((l) => l.y >= 250 && l.y <= 320 && l.x < 1340)) console.log(show(l));
  console.log("== near list toggle (x 1150-1400, y 150-280) ==");
  for (const l of lines.filter((l) => l.x >= 1150 && l.x <= 1400 && l.y >= 150 && l.y <= 280))
    console.log(show(l));
  console.log("== dropdown region (x>=1340, y 180-1610) ==");
  for (const l of lines.filter((l) => l.x >= 1340 && l.y >= 180 && l.y <= 1610)) console.log(show(l));
  console.log("== title bands ==");
  for (const l of lines.filter((l) => l.y >= 90 && l.y <= 220 && (l.x < 1200 || l.x > 2800)))
    console.log(show(l));
  console.log("== search band (y 1740-1830, x<1400) ==");
  for (const l of lines.filter((l) => l.y >= 1740 && l.y <= 1830 && l.x < 1400))
    console.log(show(l));
} finally {
  await host.close();
}
