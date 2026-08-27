import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WinReply = Record<string, unknown>;

export interface WinHostOptions {
  requestTimeoutMs?: number;
}

export function resolveWinHostScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceCandidates = [
    path.resolve(process.cwd(), "scripts", "win-input-host.ps1"),
    path.resolve(here, "..", "scripts", "win-input-host.ps1"),
    path.resolve(here, "../..", "scripts", "win-input-host.ps1"),
    path.resolve(here, "../../..", "scripts", "win-input-host.ps1"),
  ];
  const candidates = sourceCandidates.flatMap((file) => {
    const unpacked = file.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    return unpacked === file ? [file] : [unpacked, file];
  });
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error(`win-input-host.ps1 not found. Looked in ${candidates.join("; ")}`);
  }
  return found;
}

export function startWinHost(options: WinHostOptions = {}) {
  const host = resolveWinHostScript();
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", host],
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
  let lastStderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    lastStderr = `${lastStderr}${chunk}`.slice(-2_000);
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
    } catch {
      request.resolve({ ok: false, error: "parse", raw: line });
    }
  });
  child.on("error", (error) => failAll(error));
  child.on("exit", (code, signal) => {
    if (!closed) {
      const detail = lastStderr.trim() ? `:${lastStderr.trim()}` : "";
      failAll(new Error(`win-input-host-exited:${code ?? signal ?? "unknown"}${detail}`));
    }
  });
  rl.on("close", () => {
    if (!closed) failAll(new Error("win-input-host-output-closed"));
  });

  async function send(payload: Record<string, unknown>): Promise<WinReply> {
    return new Promise((resolve, reject) => {
      if (closed || child.exitCode !== null || child.killed) {
        reject(new Error("win-input-host-closed"));
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
          child.kill();
        }, timeoutMs),
      };
      pending.push(request);
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        closed = true;
        failAll(err);
        child.kill();
      });
    });
  }
  async function close() {
    if (closed) return;
    closed = true;
    failAll(new Error("win-input-host-closed"));
    try {
      child.stdin.write("quit\n");
    } catch {
      /* ignore */
    }
    child.kill();
  }
  return { send, close };
}
