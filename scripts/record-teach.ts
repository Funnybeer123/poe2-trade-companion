/**
 * Teach-by-demonstration recorder: watches the USER sort items by hand and
 * records everything needed to learn the workflow — every click (left/right,
 * with ctrl/shift state and exact position), coarse mouse movement, and a
 * screenshot roughly every second plus one at every click.
 *
 * Sends NO input of its own. Output:
 *   artifacts/teach/<session>/events.jsonl   one JSON event per line
 *   artifacts/teach/<session>/f<t>.png       frames named by ms offset
 *
 *   npx tsx scripts/record-teach.ts [--secs=180]
 *
 * Press Numpad 0 to end the recording early.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secs = Number(process.argv.find((a) => a.startsWith("--secs="))?.slice(7) ?? 180);
const session = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "artifacts", "teach", session);
mkdirSync(outDir, { recursive: true });
const eventsFile = path.join(outDir, "events.jsonl");

const recHost = startWinHost({ requestTimeoutMs: 30_000 });
const capHost = startWinHost({ requestTimeoutMs: 30_000 });
const keyHost = startWinHost({ requestTimeoutMs: 30_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let done = false;
const t0 = Date.now();
const ts = () => Date.now() - t0;

// Early exit on Numpad 0.
void (async () => {
  for (;;) {
    try {
      const reply = await keyHost.send({ op: "waitkey", timeoutMs: 2000 });
      if (reply.ok && Number(reply.key) === 0) {
        done = true;
        return;
      }
    } catch {
      return;
    }
    if (done) return;
  }
})();

let clickPending = false;

// Input event stream: 1-second observation windows, appended as JSONL.
const recording = (async () => {
  while (!done && ts() < secs * 1000) {
    const reply = await recHost.send({ op: "record", ms: 1000 });
    if (!reply.ok) continue;
    const events = (Array.isArray(reply.events) ? reply.events : []) as Array<Record<string, unknown>>;
    for (const event of events) {
      appendFileSync(eventsFile, JSON.stringify({ ...event, at: ts() }) + "\n");
      if (event.kind === "ldown" || event.kind === "rdown") clickPending = true;
    }
  }
})();

// Frame stream: about one per second, plus promptly after any click.
const framing = (async () => {
  let last = 0;
  while (!done && ts() < secs * 1000) {
    if (clickPending || ts() - last >= 1000) {
      clickPending = false;
      last = ts();
      try {
        const bmp = path.join(outDir, "grab.bmp");
        const cap = await capHost.send({ op: "capture", path: bmp });
        if (cap.ok) {
          writeFileSync(path.join(outDir, `f${String(last).padStart(7, "0")}.png`), encodeBgrPng(readBmpBgr(bmp)));
          rmSync(bmp, { force: true });
        }
      } catch {
        /* keep going */
      }
    }
    await sleep(120);
  }
})();

console.log(`RECORDING ${secs}s — sort a few items by hand now. Press Numpad 0 when finished.`);
console.log(`session: artifacts/teach/${session}`);
await Promise.all([recording, framing]);
done = true;
console.log(`recording complete: ${session}`);
await recHost.close();
await capHost.close();
await keyHost.close();
