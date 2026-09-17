import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readBagJournal } from "./bagSessionStore.js";
import type { BagTriageStage, BagTriageStatus } from "../shared/bagTriage.js";
import type { CalibrationProfile } from "../core/calibrationProfile.js";
import { readBagLivePerception } from "../adapters/liveBag.js";

export interface BagTriageServiceOptions {
  root: string;
  dataRoot: string;
  templateDir: string;
  perceptionFile?: string;
  clientLog?: string;
  workerFile?: string;
  executable?: string;
  blocked?: () => string | undefined;
  emit?: (status: BagTriageStatus) => void;
  spawn?: typeof spawn;
  countdownMs?: number;
}

/** The desktop and terminal invoke the same bounded, journaled bag worker. */
export class BagTriageService {
  private state: BagTriageStatus = { running: false, phase: "idle", message: "Ready to identify and drop low-priority items.", sessions: [] };
  private child?: ReturnType<typeof spawn>;
  private countdown?: ReturnType<typeof setTimeout>;
  private stopPoll?: ReturnType<typeof setInterval>;
  private stopFile?: string;
  private readonly directory: string;
  private readonly selectionFile: string;

  constructor(private readonly options: BagTriageServiceOptions) {
    this.options = { ...options, root: path.resolve(options.root), dataRoot: path.resolve(options.dataRoot), templateDir: path.resolve(options.templateDir) };
    this.directory = path.resolve(options.dataRoot, "artifacts", "map-triage");
    this.selectionFile = path.join(this.directory, "desktop-selection.json");
    this.refresh();
    try {
      const saved = JSON.parse(readFileSync(this.selectionFile, "utf8")) as { journal?: string };
      if (saved.journal) this.select(saved.journal);
    } catch { /* A missing or invalid selection never authorizes input. */ }
  }

  get status(): BagTriageStatus { return structuredClone(this.state); }
  refresh(): BagTriageStatus { this.refreshSessions(); this.state.readiness = this.readiness(); this.state.gambleReadiness = this.readiness("gamble"); return this.status; }
  private get paths() {
    return {
      entry: this.options.workerFile ? path.resolve(this.options.root, this.options.workerFile) : path.join(this.options.root, "dist-electron", "map-triage.cjs"),
      calibration: path.join(this.options.templateDir, "calibration.json"),
      perception: this.options.perceptionFile ? path.resolve(this.options.dataRoot, this.options.perceptionFile) : path.join(this.directory, "live-perception.json"),
      clientLog: this.options.clientLog ? path.resolve(this.options.dataRoot, this.options.clientLog) : "C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2/logs/Client.txt",
    };
  }
  private readiness(stage?: BagTriageStage): string[] {
    const files = this.paths, issues: string[] = [];
    const available = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
    if (!available((stage === "gamble" || stage === "cleanup") ? path.join(path.dirname(files.entry), "ring-gamble.cjs") : files.entry)) issues.push(this.workerMissingMessage());
    if (!available(files.calibration)) issues.push("Inventory calibration is missing. Open Calibration and mark the bag grid.");
    if (!available(files.perception)) issues.push("Bag cursor and inventory references are missing.");
    if ((stage !== "gamble" && stage !== "cleanup") && !available(files.clientLog)) issues.push("The Path of Exile 2 client log was not found at the configured location.");
    if (available(files.calibration) && available(files.perception)) {
      try {
        const calibration = JSON.parse(readFileSync(files.calibration, "utf8")) as CalibrationProfile;
        readBagLivePerception(files.perception, calibration);
        if ((stage === "gamble" || stage === "cleanup") && !calibration.ventorBagGrid) issues.push("Calibrate the Vendor grid in Calibration before gambling rings.");
      } catch (error) { issues.push(error instanceof Error && error.message.startsWith("Live bag") ? error.message : "Bag calibration could not be validated. Recalibrate the inventory and cursor references."); }
    }
    return issues;
  }
  private publish(update: Partial<BagTriageStatus>) { this.state = { ...this.state, ...update }; this.options.emit?.(this.status); return this.status; }
  setCleanupHotkey(registered: boolean) {
    return this.publish({ cleanupHotkey: registered ? "Ctrl+Alt+V" : undefined,
      cleanupHotkeyError: registered ? undefined : "Ctrl+Alt+V is unavailable; use the cleanup button or close the conflicting app." });
  }
  startCleanupFromHotkey() {
    if (this.state.running) return this.status;
    try { return this.start("cleanup"); }
    catch (error) { return this.publish({ phase: "error", message: error instanceof Error ? error.message : String(error) }); }
  }
  private workerMissingMessage(): string {
    return this.options.workerFile ? "The installed bag worker is missing. Rebuild or reinstall the desktop app."
      : "Build the bag worker with npm run build, then refresh setup.";
  }
  private refreshSessions() {
    const found: Array<{ id: string; label: string; time: number }> = [];
    const walk = (directory: string, depth: number) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && depth < 2 && !entry.name.endsWith(".evidence")) walk(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes("trace") && !entry.name.startsWith("rings-")) {
          found.push({ id: path.relative(this.directory, file), label: path.relative(this.directory, file).replace(/\.jsonl$/, ""), time: statSync(file).mtimeMs });
        }
      }
    };
    try { walk(this.directory, 0); } catch { this.state.message = "Some saved bag sessions could not be read."; }
    this.state.sessions = found.sort((a, b) => b.time - a.time).slice(0, 100).map(({ id, label }) => ({ id, label }));
  }
  private journalPath(id: string): string {
    if (typeof id !== "string" || !id || path.isAbsolute(id) || !id.endsWith(".jsonl")) throw new Error("Choose a saved bag session.");
    const file = path.resolve(this.directory, id), relative = path.relative(this.directory, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(file)) throw new Error("Choose a saved bag session.");
    const real = path.relative(realpathSync(this.directory), realpathSync(file));
    if (real.startsWith("..") || path.isAbsolute(real)) throw new Error("Choose a saved bag session.");
    return file;
  }
  select(id: string): BagTriageStatus {
    if (this.state.running) throw new Error("Stop the current bag stage before selecting another session.");
    const file = this.journalPath(id), session = readBagJournal(file).at(-1)?.session;
    if (!session || session.origin !== "live") throw new Error("Choose a captured live bag session.");
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.selectionFile, JSON.stringify({ journal: id }));
    return this.publish({ journal: id, phase: "idle", message: "Saved bag selected.", physicalItems: session.report.rows.length,
      unreadCells: session.report.unreadCells.length, verifiedIdentifications: session.identifiedIds.length, verifiedDrops: session.droppedIds.length });
  }
  start(stage: BagTriageStage): BagTriageStatus {
    if (!["gamble", "cleanup", "workflow", "capture", "identify", "drop", "reconcile"].includes(stage)) throw new Error("Unknown bag stage.");
    if (this.state.running) throw new Error("A bag stage is already running.");
    const blocked = this.options.blocked?.(); if (blocked) throw new Error(blocked);
    const readiness = this.readiness(stage);
    if (readiness.length) throw new Error(readiness.join(" "));
    const freshJournal = stage === "capture" || stage === "workflow" || (stage === "gamble" || stage === "cleanup");
    if (!freshJournal) {
      if (!this.state.journal) throw new Error("Capture or select your bag first.");
      this.select(this.state.journal);
    }
    mkdirSync(this.directory, { recursive: true });
    const id = freshJournal ? `${(stage === "gamble" || stage === "cleanup") ? "rings" : "bag"}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl` : this.state.journal!;
    this.stopFile = path.join(this.directory, `desktop-stop-${randomUUID()}`);
    this.publish({ running: true, phase: "countdown", stage, journal: id, message: (stage === "gamble" || stage === "cleanup") ? "Stand near Ange with panels closed. Starting in 3 seconds." : "Return to your map. Starting in 3 seconds.", purchased: undefined, sold: undefined, retained: undefined,
      ...(freshJournal ? { physicalItems: undefined, unreadCells: undefined, verifiedIdentifications: undefined, verifiedDrops: undefined } : {}) });
    this.countdown = setTimeout(() => { this.countdown = undefined; this.launch(stage, id); }, this.options.countdownMs ?? 3000);
    return this.status;
  }
  private launch(stage: BagTriageStage, id: string) {
    const blocked = this.options.blocked?.() ?? this.readiness(stage).join(" ");
    if (blocked) { this.publish({ running: false, phase: "error", message: blocked }); return; }
    const journal = path.join(this.directory, id);
    const files = this.paths, entry = (stage === "gamble" || stage === "cleanup") ? path.join(path.dirname(files.entry), "ring-gamble.cjs") : files.entry;
    if (!existsSync(entry)) { this.publish({ running: false, phase: "error", message: this.workerMissingMessage() }); return; }
    const args = [entry, ...(stage === "cleanup" ? ["--rescan"] : []),
      `--stage=${stage}`, `--journal=${journal}`, `--output=${journal}.assessment.json`,
      `--calibration=${files.calibration}`, `--perception=${files.perception}`, `--client-log=${files.clientLog}`,
      ...(stage === "workflow" || (stage === "gamble" || stage === "cleanup") ? ["--run"] : stage === "identify" ? ["--run", "--max-identifications=1"] : stage === "drop" ? ["--run", "--max-drops=1"] : [])];
    this.publish({ phase: "running", message: stage === "cleanup" ? "Scanning existing rings and selling rejects at Ange…" : stage === "gamble" ? "Buying and evaluating one batch of rings at Ange…" : stage === "workflow" ? "Identifying your bag and dropping low-priority items…" : stage === "capture" ? "Reading your bag…" : stage === "identify" ? "Identifying one item…" : stage === "drop" ? "Checking one low-priority drop…" : "Checking the saved action…" });
    let child: ReturnType<typeof spawn>;
    try {
      child = (this.options.spawn ?? spawn)(this.options.executable ?? process.execPath, args, {
        cwd: this.options.dataRoot, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", POE2_BAG_DATA_ROOT: this.options.dataRoot, POE2_STASH_DATA_ROOT: this.options.dataRoot,
          POE2_TEMPLATE_DIR: this.options.templateDir, POE2_BAG_STOP_FILE: this.stopFile },
      });
    } catch { this.publish({ running: false, phase: "error", message: "The bag worker could not start." }); return; }
    this.child = child;
    const logFile = `${journal}.worker.log`;
    const record = (chunk: unknown) => { try { appendFileSync(logFile, String(chunk)); } catch { this.stop("Could not save worker progress. Stopping bag input…"); } };
    let output = "", errors = "";
    const parse = (line: string) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>, counts: Partial<BagTriageStatus> = {};
        for (const key of ["physicalItems", "unreadCells", "verifiedIdentifications", "verifiedDrops", "purchased", "sold", "retained"] as const) {
          if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) counts[key] = Number(value[key]);
        }
        if (Object.keys(counts).length) this.publish(counts);
      } catch { /* Human progress is recorded locally, not treated as worker instructions. */ }
    };
    child.stdout?.on("data", (chunk: unknown) => {
      record(chunk); output += String(chunk);
      let index: number; while ((index = output.indexOf("\n")) >= 0) { parse(output.slice(0, index)); output = output.slice(index + 1); }
      if (output.length > 65536) output = "";
    });
    child.stderr?.on("data", (chunk: unknown) => { record(chunk); errors = (errors + String(chunk)).slice(-4000); });
    const finish = (success: boolean) => {
      if (this.child !== child) return;
      this.child = undefined; if (this.stopPoll) clearInterval(this.stopPoll); this.stopPoll = undefined;
      if (output.trim()) parse(output);
      try { if ((stage !== "gamble" && stage !== "cleanup") && existsSync(journal)) writeFileSync(this.selectionFile, JSON.stringify({ journal: id })); } catch { /* The journal itself remains intact. */ }
      for (const file of [this.stopFile, this.stopFile && this.stopFile + ".ack"]) { try { if (file && existsSync(file)) unlinkSync(file); } catch { /* Preserve an undeletable stop marker. */ } }
      this.refreshSessions();
      const stopped = this.state.phase === "stopping";
      this.publish({ running: false, ...((stage === "gamble" || stage === "cleanup") ? { journal: undefined } : {}), phase: stopped ? "idle" : success ? "complete" : "error",
        message: stopped ? "Bag stage stopped. Reconcile before continuing." : success ? (stage === "gamble" || stage === "cleanup") ? "Ring batch complete. Retained rings are in your bag." : "Bag stage complete." : errors.trim().split(/\r?\n/).at(-1)?.slice(0, 350) || "The bag stage could not finish." });
    };
    child.once("exit", code => finish(code === 0)); child.once("error", () => finish(false));
  }
  stop(reason = "Stopping bag input…"): BagTriageStatus {
    if (this.countdown) { clearTimeout(this.countdown); this.countdown = undefined; return this.publish({ running: false, phase: "idle", message: "Bag stage cancelled." }); }
    if (!this.child) return this.status;
    this.publish({ phase: "stopping", message: reason });
    try { if (this.stopFile) writeFileSync(this.stopFile, "stop"); }
    catch { return this.publish({ message: "Could not signal the bag worker. Use Num0 or Ctrl+Shift+Esc to stop input." }); }
    const child = this.child, stopFile = this.stopFile;
    this.stopPoll ??= setInterval(() => {
      // The native monitor acknowledges only after it releases every owned key/button.
      if (stopFile && existsSync(stopFile + ".ack")) {
        clearInterval(this.stopPoll); this.stopPoll = undefined;
        try { child.kill(); } catch { this.publish({ message: "Input is stopped; the bag worker has not exited yet." }); }
      }
    }, 50);
    this.stopPoll.unref();
    return this.status;
  }
}
