import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(), existsSync: mocks.existsSync,
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn, execFile: mocks.execFile,
}));
import { StashTabAdminService } from "../src/main/stashTabAdminService.js";

beforeEach(() => {
  mocks.spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), {
    pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  }));
  mocks.execFile.mockReset();
  mocks.existsSync.mockReset().mockReturnValue(false);
});

describe("dump valuation command dispatch", () => {
  it("requires a saved report before resuming and passes a fixed offline path in development", () => {
    const service = new StashTabAdminService({ root: "C:/companion with spaces" });
    expect(service.runScript("value-dump-resume")).toEqual({ started: false, reason: "no-saved-report" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.existsSync.mockReturnValue(true);
    expect(service.runScript("value-dump-resume")).toEqual({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith("npx", ["--yes", "tsx", "scripts/value-dump.ts", "--pending-only",
      "--from-scan=" + path.join("artifacts", "tab-admin", "stash-valuation-report.json")], expect.objectContaining({ cwd: "C:/companion with spaces" }));
    expect(mocks.spawn.mock.calls[0]![1]).not.toContain("--move");
  });

  it("resumes packaged pricing against the canonical user-data report with no shell and preserves stop support", () => {
    mocks.existsSync.mockReturnValue(true);
    const worker = { executable: "C:/installed/Companion.exe", file: "C:/installed/value-dump.cjs", dataRoot: "C:/User data with spaces" };
    const onScriptStopped = vi.fn();
    const service = new StashTabAdminService({ root: "C:/unrelated", valuationWorker: worker, onScriptStopped });
    expect(service.runScript("value-dump-resume")).toEqual({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith(worker.executable, [worker.file, "--pending-only",
      "--from-scan=" + path.join(worker.dataRoot, "artifacts", "tab-admin", "stash-valuation-report.json")],
    expect.objectContaining({ shell: false, windowsHide: true, cwd: worker.dataRoot }));
    service.stopScript("Stop saved pricing");
    expect(mocks.execFile).toHaveBeenCalledWith("taskkill.exe", ["/PID", "12345", "/T", "/F"], { windowsHide: true }, expect.any(Function));
    (mocks.execFile.mock.calls[0]![3] as (error: Error | null) => void)(null);
    expect(onScriptStopped).toHaveBeenCalledWith("value-dump-resume", "Stop saved pricing");
  });

  it("launches a scan with no transfer flag and shares the existing private market configuration", () => {
    const service = new StashTabAdminService({ root: "C:/companion", marketConfigDir: "C:/private-config" });
    expect(service.runScript("value-dump")).toEqual({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith("npx", ["--yes", "tsx", "scripts/value-dump.ts"], expect.objectContaining({
      cwd: "C:/companion", windowsHide: true, env: expect.objectContaining({ POE2_MARKET_CONFIG_DIR: "C:/private-config" }),
    }));
  });

  it("adds the move flag only to the explicit sort command", () => {
    const service = new StashTabAdminService({ root: "C:/companion" });
    expect(service.runScript("value-dump-sort")).toEqual({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith("npx", ["--yes", "tsx", "scripts/value-dump.ts", "--move"], expect.any(Object));
    expect(service.runScript("value-dump")).toEqual({ started: false, reason: "busy" });
  });

  it("launches the packaged worker without npx, a shell, or a source checkout", () => {
    const valuationWorker = { executable: "C:/installed/Companion.exe", file: "C:/installed/app.asar.unpacked/dist-electron/value-dump.cjs", dataRoot: "C:/user-data" };
    const service = new StashTabAdminService({ root: "C:/unrelated-working-directory", valuationWorker,
      marketConfigDir: "C:/user-data", templateDir: "C:/user-data/perception-templates" });
    expect(service.runScript("value-dump-sort")).toEqual({ started: true });
    expect(mocks.spawn).toHaveBeenCalledWith(valuationWorker.executable, [valuationWorker.file, "--move"], expect.objectContaining({
      cwd: "C:/user-data", shell: false, windowsHide: true, env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1",
        POE2_STASH_DATA_ROOT: "C:/user-data", POE2_MARKET_CONFIG_DIR: "C:/user-data", POE2_TEMPLATE_DIR: "C:/user-data/perception-templates" }),
    }));
  });

  it("respects the existing emergency-stop interlock before starting a scan", () => {
    const service = new StashTabAdminService({ root: "C:/companion", canRun: () => false });
    expect(service.runScript("value-dump")).toEqual({ started: false, reason: "blocked" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stops the owned process tree before reporting idle, even if the shell exits first", () => {
    const onScriptStopped = vi.fn();
    const service = new StashTabAdminService({ root: "C:/companion", onScriptStopped });
    service.runScript("value-dump-sort");
    const child = mocks.spawn.mock.results[0]!.value as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    expect(service.stopScript("Emergency stop")).toBe(true);
    expect(mocks.execFile).toHaveBeenCalledWith("taskkill.exe", ["/PID", "12345", "/T", "/F"], { windowsHide: true }, expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
    expect(service.status.running).toBe(true);
    child.emit("exit", 1);
    expect(service.status.running).toBe(true);
    expect(service.runScript("value-dump")).toEqual({ started: false, reason: "busy" });
    const finish = mocks.execFile.mock.calls[0]![3] as (error: Error | null) => void;
    finish(null);
    expect(service.status.running).toBe(false);
    expect(onScriptStopped).toHaveBeenCalledWith("value-dump-sort", "Emergency stop");
    expect(service.stopScript()).toBe(false);
  });

  it("does not issue duplicate tree kills or claim success after a termination failure", () => {
    const emit = vi.fn();
    const onScriptStopped = vi.fn();
    const service = new StashTabAdminService({ root: "C:/companion", emit, onScriptStopped });
    service.runScript("value-dump");
    service.stopScript();
    service.stopScript();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const finish = mocks.execFile.mock.calls[0]![3] as (error: Error | null) => void;
    finish(new Error("Access denied"));
    expect(service.status.running).toBe(true);
    expect(service.status.lastError).toContain("Could not confirm dump valuation stopped");
    const child = mocks.spawn.mock.results[0]!.value as EventEmitter;
    child.emit("exit", 1);
    expect(service.status.running).toBe(true);
    expect(onScriptStopped).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    service.stopScript();
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("handles a launcher error without leaving the service permanently busy", () => {
    const service = new StashTabAdminService({ root: "C:/companion" });
    service.runScript("value-dump");
    const child = mocks.spawn.mock.results[0]!.value as EventEmitter;
    child.emit("error", new Error("npx is unavailable"));
    expect(service.status.running).toBe(false);
    expect(service.status.lastError).toBe("npx is unavailable");
  });
});
