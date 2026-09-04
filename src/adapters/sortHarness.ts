/**
 * First-class troubleshooting harness for live-game automation.
 *
 * Every click and burst the sorter performs goes through here — there are no
 * bare `host.send({op:"click"})` calls anywhere in the sorter — which is what
 * makes these invariants enforceable in one place:
 *
 * - A bullseye + purpose label is shown before every single click lands, and
 *   a lime-found / red-target grid overlay before every burst.
 * - Exactly ONE overlay is on screen at a time, and it is cleared the moment
 *   its click resolves — on success, skip, timeout and every error path.
 *   Stale labels from prior steps once stacked into an unreadable mess.
 * - The control keys are honoured within ~100ms everywhere, including inside
 *   sleeps and mid-burst: Numpad 8 = good (execute), 9 = wrong (teach the
 *   correct spot), 5 = pause/resume, 0 = instant stop.
 * - A Numpad 9 correction — the user clicks or DRAGS A BOX where the click or
 *   detection should have been — is appended to corrections.jsonl and a
 *   "learned" flash confirms the capture. Corrections are bug reports with
 *   pixel-exact repro; read them back after a session and fix the code.
 *
 * The harness also owns adaptive pacing (persisted in pace.json) and the
 * bench log (bench.jsonl): per-phase timings plus per-guard check/fire
 * counts, so speed work is measured and guards that never fire in N sessions
 * can be retired.
 */
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WinReply } from "./winHost.js";
import type { Cell, CorrectionRecord } from "../core/gearSort.js";

export interface HarnessHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

export interface SortHarnessOptions {
  /** artifacts directory; corrections.jsonl / pace.json / bench.jsonl live here. */
  outDir: string;
  /** Gate every click on Numpad 8/9 instead of a short dwell. */
  stepMode?: boolean;
  /** Shorter dwell times. The overlays still show — the harness is not optional. */
  fast?: boolean;
  /** Suppress the item-moving part of bursts (overlays and gates still run). */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Lowest pace multiplier paceUp may reach (default 0.8; turbo 0.5). */
  paceFloor?: number;
  /** Test seams. */
  sleeper?: (ms: number) => Promise<void>;
  initialPace?: number;
}

/** Thrown when the user presses the instant-stop key; not a failure. */
export class SortStop extends Error {
  constructor(why: string) {
    super(`STOPPED (${why})`);
    this.name = "SortStop";
  }
}

interface MarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "click" | "found";
  label?: string;
}

/** Burst chunk size: ~3 clicks ≈ 100ms of host time, so stop lands mid-burst. */
const BURST_CHUNK = 3;

const STEP_HINT = "[8=good 9=wrong 5=pause 0=stop]";

export class SortHarness {
  stopRequested = false;
  stopWhy = "";
  paused = false;

  private approved = false;
  private markedWrong = false;
  private planRejected = false;
  /** Set by a Numpad 9 outside a step gate: teach a correction for the last click. */
  private wrongFlagged = false;
  private lastClick: { x: number; y: number; why: string } | undefined;

  private overlayUp = false;
  private disposed = false;
  private paceMult: number;
  private readonly sessionId = new Date().toISOString();
  private readonly guards = new Map<string, { checks: number; fires: number }>();
  private readonly sleepBase: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(
    private readonly host: HarnessHost,
    /** Independent host, so control keys are heard even mid-request. */
    private readonly control: HarnessHost,
    private readonly options: SortHarnessOptions,
  ) {
    mkdirSync(options.outDir, { recursive: true });
    this.sleepBase = options.sleeper ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? ((line) => console.log(line));
    this.paceMult = options.initialPace ?? (options.fast ? 1.0 : 1.6);
    try {
      if (existsSync(this.paceFile)) {
        this.paceMult = Number(JSON.parse(readFileSync(this.paceFile, "utf8")).mult) || this.paceMult;
      }
    } catch {
      // fresh pace file
    }
  }

  private get paceFile(): string {
    return path.join(this.options.outDir, "pace.json");
  }

  private get benchFile(): string {
    return path.join(this.options.outDir, "bench.jsonl");
  }

  private get correctionsFile(): string {
    return path.join(this.options.outDir, "corrections.jsonl");
  }

  get pace(): number {
    return this.paceMult;
  }

  /* ---------------- control keys ---------------- */

  /**
   * Listen for the numpad control keys on the dedicated host. Runs until
   * dispose(); never throws. Numpad + / - double for 8 / 9 so the keys work
   * with NumLock off too.
   */
  startKeyListener(): void {
    void (async () => {
      while (!this.disposed) {
        let reply: WinReply;
        try {
          reply = await this.control.send({ op: "waitkey", timeoutMs: 600 });
        } catch {
          return; // control host closed — shutting down
        }
        if (!reply.ok) continue;
        const key = Number(reply.key);
        if (key === 0) {
          this.stopRequested = true;
          this.stopWhy = "Numpad 0 pressed";
          return;
        }
        if (key === 5) this.paused = !this.paused;
        if (key === 7) this.planRejected = true;
        if (key === 8 || key === 10) this.approved = true;
        if (key === 9 || key === 11) {
          this.markedWrong = true;
          this.wrongFlagged = true;
        }
      }
    })();
  }

  private throwIfStopped(where: string): void {
    if (this.stopRequested) throw new SortStop(`${this.stopWhy} — ${where}`);
  }

  /**
   * Paced sleep that honours stop and pause within ~100ms. Every wait in the
   * sorter goes through here, so Numpad 0 always lands mid-wait.
   */
  async sleep(ms: number, paced = true): Promise<void> {
    let left = Math.round(paced ? ms * this.paceMult : ms);
    while (left > 0) {
      this.throwIfStopped("mid-wait");
      if (this.paused) await this.pauseGate();
      const chunk = Math.min(100, left);
      await this.sleepBase(chunk);
      left -= chunk;
    }
    this.throwIfStopped("mid-wait");
  }

  /** Block while paused, with a banner so the state is visible on screen. */
  async pauseGate(): Promise<void> {
    if (!this.paused) return;
    await this.showOverlay([
      { x: 1500, y: 30, w: 900, h: 70, kind: "click", label: "PAUSED — Numpad5 resume · Numpad0 stop" },
    ]);
    try {
      while (this.paused && !this.stopRequested) await this.sleepBase(100);
    } finally {
      await this.clearOverlay();
    }
    this.throwIfStopped("while paused");
  }

  /**
   * Checkpoint between actions: honour pause, honour stop, and if the user
   * flagged the previous click as wrong (Numpad 9 outside a step gate),
   * capture their correction before anything else happens on screen.
   */
  async checkpoint(where: string): Promise<void> {
    this.throwIfStopped(where);
    await this.pauseGate();
    // Hovers and Ctrl+C only mean anything inside the game: if the user
    // has clicked away, bring the game back before the next sweep instead
    // of reading whatever window is up (2026-09-03). Throttled — checkpoints
    // are frequent.
    if (Date.now() - this.lastForegroundCheck > 2_000) {
      this.lastForegroundCheck = Date.now();
      try {
        const rect = await this.host.send({ op: "rect" });
        if (rect.ok && rect.foregroundIsPoe === false) {
          await this.host.send({ op: "focus" });
          await this.sleepBase(250);
        }
      } catch {
        // A failed probe must not break the run; the next checkpoint retries.
      }
    }
    if (this.wrongFlagged) {
      this.wrongFlagged = false;
      this.markedWrong = false;
      const last = this.lastClick;
      if (last) await this.captureCorrection(last.why, { x: last.x, y: last.y });
    }
  }

  /* ---------------- overlay (one at a time, always cleared) ---------------- */

  private async showOverlay(rects: MarkRect[]): Promise<void> {
    // The host's Show-Marks replaces any prior overlay, but tracking state
    // here keeps clearOverlay cheap and makes "one overlay at a time" true
    // even if a future host draws additively.
    await this.host.send({ op: "marks", rects });
    this.overlayUp = true;
  }

  async clearOverlay(): Promise<void> {
    try {
      await this.host.send({ op: "hidemark" });
    } catch {
      // Clearing must never mask the original failure.
    }
    this.overlayUp = false;
  }

  get hasOverlay(): boolean {
    return this.overlayUp;
  }

  /** Brief confirmation flash (e.g. "learned"), cleared automatically. */
  async flash(text: string, ms = 900): Promise<void> {
    try {
      await this.showOverlay([{ x: 1500, y: 30, w: 900, h: 70, kind: "found", label: text }]);
      await this.sleepBase(ms);
    } finally {
      await this.clearOverlay();
    }
  }

  /* ---------------- clicks ---------------- */

  /**
   * Single click with a bullseye + purpose label shown first. In step mode
   * the click waits for Numpad 8; Numpad 9 asks the user to demonstrate the
   * correct spot instead (their click acts in-game itself, so the planned
   * click is skipped). The overlay is cleared before the click lands and on
   * every abort path.
   */
  async click(x: number, y: number, why: string): Promise<"clicked" | "corrected"> {
    await this.checkpoint(`before click: ${why}`);
    this.armGate();
    try {
      await this.showOverlay([
        {
          x: x - 25,
          y: y - 25,
          w: 50,
          h: 50,
          kind: "click",
          label: this.options.stepMode ? `${why}  ${STEP_HINT}` : why,
        },
      ]);
      if (this.options.stepMode) {
        const verdict = await this.stepGate(why);
        if (verdict === "wrong") {
          await this.clearOverlay();
          await this.captureCorrection(why, { x, y });
          return "corrected"; // the user's own click performed the action
        }
      } else {
        await this.sleepBase(this.options.fast ? 120 : 350);
      }
    } finally {
      await this.clearOverlay();
    }
    this.throwIfStopped(`at click: ${why}`);
    this.lastClick = { x, y, why };
    await this.host.send({ op: "click", x, y });
    return "clicked";
  }

  /**
   * Arm the verdict flags BEFORE the overlay is shown. Resetting them inside
   * the gate instead would wipe a verdict the key listener already recorded
   * between the overlay appearing and the gate starting to poll — a real
   * race: the user's keypress would be silently discarded and the gate would
   * wait forever.
   */
  private armGate(): void {
    this.approved = false;
    this.markedWrong = false;
    this.planRejected = false;
  }

  private lastForegroundCheck = 0;

  /** Wait for the user's verdict on the shown click. */
  private async stepGate(why: string): Promise<"good" | "wrong"> {
    let lastFocusCheck = Date.now();
    for (;;) {
      if (this.stopRequested) throw new SortStop(`${this.stopWhy} at step: ${why}`);
      if (this.approved) return "good";
      if (this.markedWrong || this.planRejected) {
        this.wrongFlagged = false;
        return "wrong";
      }
      if (this.paused) {
        // The bullseye stays up (it names the step); just wait here.
        await this.sleepBase(100);
        continue;
      }
      // The host's waitkey only counts numpad presses while the game is the
      // foreground window; a user who glanced at the terminal presses 8 into
      // nothing (2026-09-02). Pull the game back every few seconds.
      if (Date.now() - lastFocusCheck > 3_000) {
        lastFocusCheck = Date.now();
        try {
          const rect = await this.host.send({ op: "rect" });
          if (rect.ok && rect.foregroundIsPoe === false) await this.host.send({ op: "focus" });
        } catch {
          // A failed probe must not break the gate; the next tick retries.
        }
      }
      await this.sleepBase(100);
    }
  }

  /* ---------------- bursts ---------------- */

  /**
   * Ctrl-click burst with the grid overlay first: lime for every detected
   * cell, red for the cells about to be clicked. Chunked so stop/pause land
   * mid-burst. In step mode the whole plan is gated on Numpad 8/9.
   *
   * Returns how many clicks were actually sent (0 when rejected/dry-run).
   */
  async burst(
    targets: readonly Cell[],
    options: {
      found?: readonly Cell[];
      cellW: number;
      cellH: number;
      label: string;
      shift?: boolean;
    },
  ): Promise<number> {
    if (targets.length === 0) return 0;
    await this.checkpoint(`before burst: ${options.label}`);
    this.armGate();
    const rect = (cell: Cell, kind: MarkRect["kind"], label?: string): MarkRect => ({
      x: Math.round(cell.x - options.cellW / 2),
      y: Math.round(cell.y - options.cellH / 2),
      w: Math.round(options.cellW),
      h: Math.round(options.cellH),
      kind,
      ...(label ? { label } : {}),
    });
    const targetKeys = new Set(targets.map((cell) => `${cell.x},${cell.y}`));
    const foundOnly = (options.found ?? []).filter(
      (cell) => !targetKeys.has(`${cell.x},${cell.y}`),
    );
    const rects = [
      ...foundOnly.map((cell) => rect(cell, "found")),
      ...targets.map((cell, index) =>
        rect(
          cell,
          "click",
          index === 0
            ? `${options.label}${this.options.stepMode ? `  ${STEP_HINT}` : ""}`
            : undefined,
        ),
      ),
    ];
    try {
      await this.showOverlay(rects);
      if (this.options.stepMode) {
        const verdict = await this.stepGate(options.label);
        if (verdict === "wrong") {
          await this.clearOverlay();
          await this.captureCorrection(options.label, targets[0]!);
          return 0;
        }
      } else {
        // Let the human see the plan before it executes.
        await this.sleep(this.options.fast ? 150 : 900, false);
      }
      if (this.planRejected) {
        this.planRejected = false;
        this.log(`  · plan REJECTED by user: ${options.label}`);
        return 0;
      }
      if (this.options.dryRun) return 0;
      let sent = 0;
      for (let i = 0; i < targets.length; i += BURST_CHUNK) {
        this.throwIfStopped(`mid-burst: ${options.label}`);
        if (this.paused) await this.pauseGate();
        const slice = targets.slice(i, i + BURST_CHUNK).map((cell) => ({ x: cell.x, y: cell.y }));
        let reply = await this.host.send({ op: "ctrlburst", points: slice, shift: options.shift ?? false });
        if (!reply.ok && /focus/i.test(String(reply.error ?? ""))) {
          await this.host.send({ op: "focus" });
          await this.sleepBase(400);
          reply = await this.host.send({ op: "ctrlburst", points: slice, shift: options.shift ?? false });
        }
        if (!reply.ok) throw new Error(`burst-failed:${reply.error}`);
        sent += slice.length;
      }
      this.lastClick = { x: targets[0]!.x, y: targets[0]!.y, why: options.label };
      return sent;
    } finally {
      await this.clearOverlay();
    }
  }

  /**
   * Show a plan overlay (no clicks) and wait for the user's verdict:
   * Numpad 8 = good, Numpad 9 = wrong. Used by teach mode to confirm the
   * occupancy plan before a sweep. The overlay is always cleared.
   */
  async confirmPlan(
    rects: ReadonlyArray<{ x: number; y: number; w: number; h: number; kind: "click" | "found"; label?: string }>,
    label: string,
  ): Promise<"good" | "wrong"> {
    await this.checkpoint(`plan: ${label}`);
    this.armGate();
    try {
      await this.showOverlay([
        ...rects,
        { x: 1500, y: 30, w: 1100, h: 70, kind: "click", label: `${label}  ${STEP_HINT}` },
      ]);
      return await this.stepGate(label);
    } finally {
      await this.clearOverlay();
    }
  }

  /* ---------------- corrections ---------------- */

  /**
   * The user said a click/plan was wrong: ask them to click — or drag a box
   * around — the place it should have been, record it, and flash "learned".
   * Their input acts in-game itself; nothing is replayed.
   */
  async captureCorrection(why: string, planned: Cell): Promise<CorrectionRecord | undefined> {
    await this.showOverlay([
      {
        x: 1500,
        y: 30,
        w: 1100,
        h: 70,
        kind: "click",
        label: `WRONG — click (or drag a box around) the CORRECT spot for: ${why}`,
      },
    ]);
    this.log(`  · marked WRONG by user: ${why} at (${planned.x},${planned.y}) — waiting for their correction`);
    let down: { x: number; y: number } | undefined;
    let up: { x: number; y: number } | undefined;
    try {
      const deadline = Date.now() + 30_000;
      while (!up && Date.now() < deadline && !this.stopRequested) {
        const reply = await this.control.send({ op: "record", ms: 1000 });
        const events = (Array.isArray(reply.events) ? reply.events : []) as Array<
          Record<string, unknown>
        >;
        for (const event of events) {
          if (event.kind === "ldown" && !down) down = { x: Number(event.x), y: Number(event.y) };
          if (event.kind === "lup" && down) {
            up = { x: Number(event.x), y: Number(event.y) };
            break;
          }
        }
      }
    } finally {
      await this.clearOverlay();
    }
    if (!down || !up) {
      this.log(`  · no correction received for: ${why}`);
      return undefined;
    }
    const isBox = Math.abs(up.x - down.x) > 40 || Math.abs(up.y - down.y) > 40;
    const record: CorrectionRecord = {
      at: new Date().toISOString(),
      why,
      planned: { x: planned.x, y: planned.y },
      ...(isBox
        ? {
            box: {
              x: Math.min(down.x, up.x),
              y: Math.min(down.y, up.y),
              w: Math.abs(up.x - down.x),
              h: Math.abs(up.y - down.y),
            },
          }
        : { corrected: { x: down.x, y: down.y } }),
    };
    appendFileSync(this.correctionsFile, JSON.stringify(record) + "\n");
    this.log(
      `  · CORRECTION learned: ${why}: planned (${planned.x},${planned.y}) -> ` +
        (isBox ? `box ${JSON.stringify(record.box)}` : `(${down.x},${down.y})`),
    );
    await this.flash("learned ✓");
    return record;
  }

  /* ---------------- pacing ---------------- */

  paceUp(): void {
    this.paceMult = Math.max(this.options.paceFloor ?? 0.8, this.paceMult * 0.9);
    this.savePace();
  }

  paceDown(): void {
    this.paceMult = Math.min(3.0, this.paceMult * 1.5);
    this.savePace();
  }

  private savePace(): void {
    try {
      writeFileSync(this.paceFile, JSON.stringify({ mult: this.paceMult }));
    } catch {
      // pacing is an optimisation, never a failure
    }
  }

  /* ---------------- bench ---------------- */

  /** Time a phase; call the returned function when it ends. */
  startPhase(phase: string): (outcome?: string) => void {
    const startedAt = Date.now();
    return (outcome = "ok") => {
      this.appendBench({ kind: "phase", phase, ms: Date.now() - startedAt, outcome });
    };
  }

  /**
   * Record a guard evaluation. Guards that never fire across sessions show up
   * as fires=0 in the bench log and can be retired.
   */
  guard(name: string, fired: boolean): boolean {
    const entry = this.guards.get(name) ?? { checks: 0, fires: 0 };
    entry.checks += 1;
    if (fired) entry.fires += 1;
    this.guards.set(name, entry);
    if (fired) this.appendBench({ kind: "guard-fired", guard: name });
    return fired;
  }

  private appendBench(record: Record<string, unknown>): void {
    try {
      appendFileSync(
        this.benchFile,
        JSON.stringify({ at: new Date().toISOString(), session: this.sessionId, ...record }) + "\n",
      );
    } catch {
      // bench is diagnostics, never a failure
    }
  }

  /** Flush the guard tally and stop the key listener. Safe to call twice. */
  async dispose(summary: Record<string, unknown> = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.clearOverlay();
    this.appendBench({
      kind: "session",
      pace: this.paceMult,
      guards: Object.fromEntries(this.guards),
      ...summary,
    });
  }
}
