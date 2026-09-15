import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWinHost } from "../src/adapters/winHost.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

/** A pipe-only process substitute: these tests never launch PowerShell. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: string[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.commands.push(String(chunk));
      done();
    },
  });
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });
  reply(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

describe("Windows input host request deadlines", () => {
  let child: FakeChild;
  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    spawnMock.mockReturnValue(child);
  });
  afterEach(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("preserves the default 10-second timeout and terminates an unresponsive host", async () => {
    const host = startWinHost();
    const pending = host.send({ op: "rect" });
    const rejected = expect(pending).rejects.toThrow("win-input-host-timeout:rect");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(host.send({ op: "rect" })).rejects.toThrow("win-input-host-closed");
  });

  it("preserves explicit deadlines and clears them when a response arrives", async () => {
    const host = startWinHost({ requestTimeoutMs: 45_000 });
    const pending = host.send({ op: "copysweep" });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(child.kill).not.toHaveBeenCalled();
    child.reply({ ok: true, texts: ["item"] });
    await expect(pending).resolves.toEqual({ ok: true, texts: ["item"] });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();
    await host.close();
  });

  it("keeps a paused request alive beyond 45 seconds when the timeout is explicitly null", async () => {
    const host = startWinHost({ requestTimeoutMs: null });
    const pending = host.send({ op: "clickburst", guarded: true });
    const settled = vi.fn();
    void pending.then(settled);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.reply({ ok: true, count: 2 });
    await expect(pending).resolves.toEqual({ ok: true, count: 2 });
    await host.close();
    expect(child.commands.at(-1)).toBe("quit\n");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("retains the existing waitclick allowance unless timeout is explicitly disabled", async () => {
    const host = startWinHost({ requestTimeoutMs: 1_000 });
    const pending = host.send({ op: "waitclick", timeoutMs: 20_000 });
    const rejected = expect(pending).rejects.toThrow("win-input-host-timeout:waitclick");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it.each(["process-error", "process-exit", "close"] as const)(
    "still rejects all pending requests on %s with disabled deadlines",
    async (failure) => {
      const host = startWinHost({ requestTimeoutMs: null });
      const first = host.send({ op: "clickburst", guarded: true });
      const second = host.send({ op: "capture" });
      const message = failure === "process-error" ? "spawn-failed" :
        failure === "process-exit" ? "win-input-host-exited:7" : "win-input-host-closed";
      const firstRejected = expect(first).rejects.toThrow(message);
      const secondRejected = expect(second).rejects.toThrow(message);
      if (failure === "process-error") child.emit("error", new Error("spawn-failed"));
      else if (failure === "process-exit") {
        child.exitCode = 7;
        child.emit("exit", 7, null);
      } else await host.close();
      await Promise.all([firstRejected, secondRejected]);
      expect(vi.getTimerCount()).toBe(0);
      await host.close();
    },
  );
});
