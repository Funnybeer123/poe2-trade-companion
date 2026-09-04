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
 *   npx tsx scripts/record-teach.ts [--secs=180] [--narrate]
 *
 * --narrate also transcribes the user's spoken narration through the local
 * Windows dictation engine (System.Speech, the same engine the voice
 * transfer feature uses) into narration.jsonl — one {at, text, confidence}
 * per recognized phrase, timestamped when the phrase ENDS, so it lines up
 * with the click log. Best-effort: a missing microphone or speech pack
 * only disables the transcript, never the recording.
 *
 * Press Numpad 0 to end the recording early.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secs = Number(process.argv.find((a) => a.startsWith("--secs="))?.slice(7) ?? 180);
const narrate = process.argv.includes("--narrate");
const session = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "artifacts", "teach", session);
mkdirSync(outDir, { recursive: true });
const eventsFile = path.join(outDir, "events.jsonl");
const narrationFile = path.join(outDir, "narration.jsonl");

/**
 * Continuous dictation: Recognize() in a loop, each call waiting up to 4s
 * for speech to START and then running to the end of the phrase. Lines are
 * "<confidence>\t<text>" so the parent can stamp them with its own clock.
 */
function narrationScript(seconds: number): string {
  return `
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($installed.Count -eq 0) { throw "no-local-speech-recognizer-installed" }
  $current = [System.Globalization.CultureInfo]::CurrentUICulture
  $recognizer = $installed | Where-Object { $_.Culture.Name -eq $current.Name } | Select-Object -First 1
  if ($null -eq $recognizer) { $recognizer = $installed[0] }
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizer.Culture)
  $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $engine.SetInputToDefaultAudioDevice()
  [Console]::Out.WriteLine("READY\`t" + $recognizer.Culture.Name)
  [Console]::Out.Flush()
  $deadline = (Get-Date).AddSeconds(${Math.max(5, Math.floor(seconds))})
  while ((Get-Date) -lt $deadline) {
    $heard = $engine.Recognize([TimeSpan]::FromSeconds(4))
    if ($null -ne $heard -and $heard.Text) {
      [Console]::Out.WriteLine(("{0:F2}\`t{1}" -f $heard.Confidence, $heard.Text))
      [Console]::Out.Flush()
    }
  }
} catch {
  [Console]::Out.WriteLine("ERROR\`t" + [string]$_.Exception.Message)
  [Console]::Out.Flush()
}
`.trim();
}

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

// Narration stream (opt-in): the dictation child prints one phrase per
// line; each is stamped on arrival with the recording clock.
const narrator = narrate
  ? spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", narrationScript(secs + 5)],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
  : undefined;
if (narrator) {
  let buffer = "";
  narrator.stdout?.setEncoding("utf8");
  narrator.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/^\uFEFF/, "").trim();
      if (!trimmed) continue;
      const [head, ...rest] = trimmed.split("\t");
      const text = rest.join("\t").trim();
      if (head === "READY") {
        console.log(`narration: listening (${text})`);
        continue;
      }
      if (head === "ERROR") {
        console.log(`narration unavailable: ${text} — recording continues without it`);
        continue;
      }
      const confidence = Number(head);
      appendFileSync(
        narrationFile,
        JSON.stringify({ at: ts(), text, confidence: Number.isFinite(confidence) ? confidence : 0 }) + "\n",
      );
      console.log(`  [${(ts() / 1000).toFixed(1)}s] "${text}"`);
    }
  });
  narrator.on("error", (error) => console.log(`narration unavailable: ${String(error)}`));
}

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

console.log(
  `RECORDING ${secs}s${narrate ? " + narration" : ""} — demonstrate by hand now. Press Numpad 0 when finished.`,
);
console.log(`session: artifacts/teach/${session}`);
await Promise.all([recording, framing]);
done = true;
narrator?.kill();
console.log(`recording complete: ${session}`);
await recHost.close();
await capHost.close();
await keyHost.close();
