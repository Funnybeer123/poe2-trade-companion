/**
 * Read-only readiness probe for the sorter: exits 0 with "READY" when the
 * PoE2 window exists and the STASH + INVENTORY title bands are visible
 * (i.e. the user is at their stash and automation may resume). Sends no
 * clicks and no keys. Exits 0 with a reason string otherwise.
 */
import { startWinHost } from "../src/adapters/winHost.js";

interface Line {
  text: string;
  x: number;
  y: number;
}

const host = startWinHost({ requestTimeoutMs: 30_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) {
    console.log("NOT-READY game-window-missing");
    process.exit(0);
  }
  const ocr = await host.send({ op: "ocr" });
  const lines = (Array.isArray(ocr.lines) ? ocr.lines : []) as Line[];
  const stash = lines.some(
    (l) => /stash/i.test(l.text) && l.y >= 100 && l.y <= 220 && l.x >= 400 && l.x <= 1200,
  );
  const inventory = lines.some(
    (l) => /inventor/i.test(l.text) && l.y >= 100 && l.y <= 220 && l.x >= 2800,
  );
  if (stash && inventory) console.log("READY");
  else if (stash) console.log("NOT-READY stash-open-bag-closed");
  else console.log("NOT-READY stash-not-visible");
} finally {
  await host.close();
}
