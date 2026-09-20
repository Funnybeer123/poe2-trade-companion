import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WinReply = Record<string, unknown>;

export interface WinHostOptions {
  requestTimeoutMs?: number;
  /** Optional desktop-owned native cancellation latch; only for the bag helper. */
  bagStopFile?: string;
  scriptName?: "win-input-host.ps1" | "win-combat-host.ps1" | "win-price-helper.ps1" | "win-bag-host.ps1" | "win-follower-host.ps1" | "win-follower-input-host.ps1";
}

export function resolveWinHostScript(scriptName = "win-input-host.ps1"): string {
  if (!["win-input-host.ps1", "win-combat-host.ps1", "win-price-helper.ps1", "win-emergency-stop.ps1", "win-manual-control.ps1", "win-bag-host.ps1", "win-follower-host.ps1", "win-follower-input-host.ps1"].includes(scriptName)) {
    throw new Error("Unsupported native helper script");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bind executable helpers to this module's checkout/package, never to the
  // caller's working directory (which may contain an unrelated scripts folder).
  const sourceCandidates = [
    path.resolve(here, "..", "scripts", scriptName),
    path.resolve(here, "../..", "scripts", scriptName),
    path.resolve(here, "../../..", "scripts", scriptName),
  ];
  const candidates = sourceCandidates.flatMap((file) => {
    const unpacked = file.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    return unpacked === file ? [file] : [unpacked, file];
  });
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error(`${scriptName} not found. Looked in ${candidates.join("; ")}`);
  }
  return found;
}

export function startWinHost(options: WinHostOptions = {}) {
  const host = resolveWinHostScript(options.scriptName);
  const bagStopFile = options.scriptName === "win-bag-host.ps1"
    ? options.bagStopFile ?? path.join(tmpdir(), `poe2-bag-stop-${process.pid}-${randomUUID()}`) : undefined;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", host,
      ...(bagStopFile ? ["-ParentProcessId", String(process.pid), "-StopFile", bagStopFile] : [])],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const rl = createInterface({ input: child.stdout });
  interface PendingRequest {
    resolve: (value: WinReply) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  const pending: PendingRequest[] = [];
  let closed = false;
  // Kept as chunks and joined only when an error is built. Appending and slicing instead leaves every chunk
  // reachable: a slice of a concatenation holds its parent, whose parent is the previous slice, and so on, so
  // the "last 2000 characters" retains the whole history of the stream.
  const stderrChunks: string[] = [];
  const readStderr = () => stderrChunks.join("").slice(-2_000).trim();
  let bagShutdownTimer: NodeJS.Timeout | undefined;

  function stopChild(): void {
    if (!bagStopFile) { child.kill(); return; }
    // The native monitor polls this independently of stdin/OCR. Release owned
    // inputs before termination even if the PowerShell request loop is blocked.
    try { writeFileSync(bagStopFile, "stop", { flag: "wx" }); } catch { /* Already signalled, or parent watchdog remains active. */ }
    try { child.stdin.write("quit\n"); } catch { /* A closed pipe does not affect the native cancellation latch. */ }
    // Acknowledge is written by the native monitor only after releasing input.
    // If acknowledgement fails, leave graceful EOF/parent watchdog in charge.
    bagShutdownTimer ??= setTimeout(() => { if (existsSync(`${bagStopFile}.ack`)) child.kill(); }, 1_000);
    bagShutdownTimer.unref();
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
    if (stderrChunks.length > 32) stderrChunks.splice(0, stderrChunks.length - 32);
  });

  function failAll(error: Error): void {
    for (const request of pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  rl.on("line", (line) => {
    const request = pending.shift();
    if (!request) return;
    clearTimeout(request.timer);
    try {
      request.resolve(JSON.parse(line) as WinReply);
    } catch (error) {
      request.resolve({ ok: false, error: "parse:" + (error instanceof Error ? error.message : String(error)), raw: line });
    }
  });
  child.on("error", (error) => failAll(error));
  // A helper can exit before its final stdin write; never surface EPIPE as an
  // unhandled process error that skips journal/native shutdown cleanup.
  child.stdin.on("error", (error: Error) => {
    failAll(new Error(`${error.message}${readStderr() ? `:${readStderr()}` : ""}`));
    if (!closed) { closed = true; stopChild(); }
  });
  child.on("exit", (code, signal) => {
    if (bagShutdownTimer) clearTimeout(bagShutdownTimer);
    if (bagStopFile && !options.bagStopFile) {
      for (const latch of [bagStopFile, `${bagStopFile}.ack`]) {
        try { rmSync(latch, { force: true }); } catch { /* Private temporary latches only. */ }
      }
    }
    if (!closed) {
      const detail = readStderr() ? `:${readStderr()}` : "";
      failAll(new Error(`win-input-host-exited:${code ?? signal ?? "unknown"}${detail}`));
    }
  });
  rl.on("close", () => {
    if (!closed) failAll(new Error(`win-input-host-output-closed${readStderr() ? `:${readStderr()}` : ""}`));
  });

  async function send(payload: Record<string, unknown>): Promise<WinReply> {
    return new Promise((resolve, reject) => {
      if (closed || child.exitCode !== null || child.killed) {
        reject(new Error("win-input-host-closed"));
        return;
      }
      if (bagStopFile && pending.length > 0) {
        reject(new Error("win-bag-host-concurrent-request-rejected"));
        return;
      }
      const waitClickMs =
        payload.op === "waitclick" && Number.isFinite(Number(payload.timeoutMs))
          ? Math.max(0, Number(payload.timeoutMs)) + 5_000
          : undefined;
      const timeoutMs = waitClickMs ?? Math.max(1_000, options.requestTimeoutMs ?? 10_000);
      const request: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (closed) return;
          closed = true;
          failAll(new Error(`win-input-host-timeout:${String(payload.op ?? "unknown")}`));
          stopChild();
        }, timeoutMs),
      };
      pending.push(request);
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        closed = true;
        failAll(err);
        stopChild();
      });
    });
  }
  async function close() {
    if (closed) return;
    closed = true;
    failAll(new Error("win-input-host-closed"));
    if (bagStopFile && child.exitCode === null) {
      // Let the native helper unwind and release its owned keys before exiting.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { if (existsSync(`${bagStopFile}.ack`)) child.kill(); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        stopChild();
      });
    } else {
      try { child.stdin.write("quit\n"); } catch { /* Ignore a closed legacy host. */ }
      child.kill();
    }
  }
  return { send, close };
}
