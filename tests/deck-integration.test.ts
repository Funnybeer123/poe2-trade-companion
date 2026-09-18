import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeckServer } from "../src/main/deckServer.js";
import { DeckRuntime, type DeckServices } from "../src/main/deckRuntime.js";
import { DECK_ACTIONS, type DeckActionId } from "../src/shared/deckActions.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { defaultCombatConfig } from "../src/core/combatAssist.js";
import { AppClient } from "../stream-deck/src/client.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const kill = new KillSwitch();
  let preferences = { dryRun: true, allowlist: ["PathOfExile"], transferActionsPerMinute: 240, sortActionsPerMinute: 600 };
  const bag = { status: { running: false, readiness: [], gambleReadiness: [], phase: "idle", sessions: [] }, start: vi.fn((stage, options) => { bag.status.running = true; return { stage, options }; }), refresh: () => bag.status };
  const transfer = { status: { running: false, gridsCalibrated: true }, start: vi.fn(), hideOverlay: vi.fn() };
  const sort = { status: { running: false, calibrated: true, last: { plan: { id: "plan", executable: true } } }, start: vi.fn() };
  const scripts = { status: { running: false }, runScript: vi.fn(() => ({ started: true })), survey: vi.fn() };
  const combat = { status: { running: false, actions: 0, config: defaultCombatConfig() }, start: vi.fn(async () => ({ running: true })), stop: vi.fn(), configure: vi.fn() };
  const voice = { status: { phase: "idle" }, trigger: vi.fn(), cancel: vi.fn() };
  const helper = { status: () => ({ running: false, config: { debug: false } }), start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), refreshRumours: vi.fn(), calibrate: vi.fn(), configure: vi.fn() };
  const scanner = { status: { running: false }, start: vi.fn() };
  const stop = vi.fn(() => { bag.status.running = false; transfer.status.running = false; });
  const services = { bag, transfer, sort, scripts, combat, voice, helper, scanner, kill, preferences: () => preferences,
    dryRun: vi.fn((enabled) => { preferences = { ...preferences, dryRun: enabled }; }), stop,
    emergencyStop: vi.fn(() => { kill.trip(); stop(); }), rearm: vi.fn(() => kill.rearm()), navigate: vi.fn(), evaluate: vi.fn(), refreshFeed: vi.fn(), reassess: vi.fn() };
  return { ...services, runtime: new DeckRuntime(services as unknown as DeckServices) };
}
function command(server: DeckServer, action: DeckActionId, id = "command-123") { return { version: 1, session: server.session, id, action, parameters: {} }; }
describe("Stream Deck registry and app routing", () => {
  it("routes every action to a service, preserving typed registry coverage", () => {
    expect(new Set(DECK_ACTIONS.map(a => a[0])).size).toBe(DECK_ACTIONS.length);
    for (const [id] of DECK_ACTIONS) {
      const f = fixture(); f.runtime.execute("safety.dry-off");
      expect(() => f.runtime.execute(id), id).not.toThrow();
      expect(f.runtime.status().buttons[id], id).toBeDefined();
    }
  });
  it("uses the bounded ring workflows and never silently runs bag input in dry-run", () => {
    const f = fixture(); f.runtime.execute("rings.gamble");
    expect(f.bag.start).toHaveBeenCalledWith("gamble", { dryRun: true });
    expect(() => f.runtime.execute("rings.cleanup")).toThrow(/already active/);
    f.runtime.execute("workflow.stop");
    expect(() => f.runtime.execute("bag.workflow")).toThrow(/no no-input preview/);
    f.runtime.execute("safety.dry-off"); f.runtime.execute("rings.cleanup");
    expect(f.bag.start).toHaveBeenLastCalledWith("cleanup", { dryRun: false });
  });
  it("keeps saved allowlist and rate limits and uses explicit current sort plan", () => {
    const f = fixture(); f.runtime.execute("transfer.two-cycle");
    expect(f.transfer.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "two-cycle", dryRun: true, allowlist: ["PathOfExile"], actionsPerMinute: 240 }));
    expect(() => f.runtime.execute("sort.execute")).toThrow(/Dry-run/);
    f.runtime.execute("safety.dry-off"); f.runtime.execute("sort.execute");
    expect(f.sort.start).toHaveBeenCalledWith(expect.objectContaining({ action: "execute", planId: "plan" }));
  });
  it.each(["bag", "transfer", "sort", "scripts", "combat", "scanner"] as const)("rejects starts when %s is active but always permits emergency stop", service => {
    const f = fixture(); f[service].status.running = true;
    expect(() => f.runtime.execute("rings.gamble")).toThrow(/already active/);
    f.runtime.execute("safety.estop"); expect(f.kill.isLatched()).toBe(true);
    expect(() => f.runtime.execute("combat.start")).toThrow(/latched/);
  });
  it("makes missing calibration unavailable and exposes errors from services", () => {
    const f = fixture(); f.transfer.status.gridsCalibrated = false;
    expect(f.runtime.status().buttons["transfer.empty"]).toMatchObject({ state: "unavailable", detail: expect.stringContaining("Calibrate") });
    f.helper.start.mockImplementation(() => { throw new Error("Calibrate price region"); });
    expect(() => f.runtime.execute("helper.start")).toThrow("Calibrate price region");
    expect(f.runtime.status().buttons["helper.start"]).toMatchObject({ state: "error", detail: expect.stringContaining("Calibrate price region") });
  });
  it("guards asynchronous starts, publishes failures and releases pending state", async () => {
    const f = fixture(); let reject!: (reason: Error) => void;
    f.transfer.start.mockReturnValue(new Promise((_, r) => { reject = r; }));
    const pending = f.runtime.execute("transfer.empty") as Promise<unknown>;
    expect(f.runtime.status().buttons["transfer.empty"].state).toBe("active");
    expect(() => f.runtime.execute("transfer.fill")).toThrow(/active/);
    reject(new Error("Target not allowlisted")); await expect(pending).rejects.toThrow("Target not allowlisted");
    expect(f.runtime.status().buttons["transfer.empty"].state).toBe("error");
  });
  it("preserves combat module semantics and explicit pause/resume", () => {
    const f = fixture(); f.runtime.execute("combat.mana");
    expect(f.combat.configure).toHaveBeenCalledWith(expect.objectContaining({ mana: expect.objectContaining({ enabled: true, key: "MOUSE5" }) }));
    expect(f.combat.start).not.toHaveBeenCalled();
    f.runtime.execute("combat.pause"); expect(f.runtime.status().buttons["combat.pause"].state).toBe("paused");
    f.runtime.execute("combat.resume"); expect(f.combat.start).toHaveBeenCalledOnce();
  });
});
describe("Local protocol and plugin reconnect", () => {
  it("does not let failed status or optional logging prevent emergency stop", () => {
    const stop = vi.fn();
    const server = new DeckServer({ status: () => { throw new Error("Unavailable status"); }, execute: stop }, () => { throw new Error("Disk full"); });
    expect(server.command(command(server, "safety.estop")).ok).toBe(true);
    expect(stop).toHaveBeenCalledWith("safety.estop");
  });
  it("rejects arbitrary commands, parameters, duplicates and stale sessions", () => {
    const f = fixture(), server = new DeckServer(f.runtime);
    const cmd = command(server, "open.dashboard"); expect(server.command(cmd).ok).toBe(true);
    expect(server.command(cmd).reason).toMatch(/Duplicate/); expect(f.navigate).toHaveBeenCalledOnce();
    expect(server.command({ ...cmd, id: "command-456", action: "shell.execute" }).ok).toBe(false);
    expect(server.command({ ...cmd, id: "command-457", parameters: { shell: "bad" } }).ok).toBe(false);
    expect(new DeckServer(f.runtime).command(cmd).ok).toBe(false);
  });
  it("authenticates loopback status, rejects browser origins, reconnects without replay", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deck-test-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = fixture(), server = new DeckServer(f.runtime); const port = await server.listen(dir); cleanup.push(() => server.close());
    const file = path.join(dir, "connection.json"), discovery = JSON.parse(readFileSync(file, "utf8"));
    expect((await fetch(`http://127.0.0.1:${port}/v1/status`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: `Bearer ${discovery.token}`, Origin: "https://example.com" } })).status).toBe(403);
    const client = new AppClient(file); expect(await client.poll()).toBeDefined();
    expect((await client.press("open.dashboard")).ok).toBe(true); expect(f.navigate).toHaveBeenCalledOnce();
    server.close(); expect(await client.poll()).toBeUndefined(); expect((await client.press("rings.gamble")).ok).toBe(false);
    const next = new DeckServer(f.runtime); await next.listen(dir); cleanup.push(() => next.close());
    expect((await client.poll())?.session).toBe(next.session); expect(f.bag.start).not.toHaveBeenCalled(); expect(f.navigate).toHaveBeenCalledOnce();
    expect((await client.press("safety.estop")).ok).toBe(true); expect(f.kill.isLatched()).toBe(true);
  });
  it("does not retry an ambiguous purchase command", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "deck-loss-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = fixture(), server = new DeckServer(f.runtime); await server.listen(dir); cleanup.push(() => server.close());
    let posts = 0;
    const request: typeof fetch = async (url, options) => {
      if (options?.method === "POST") { posts++; await fetch(url, options); throw new Error("Lost acknowledgement"); }
      return fetch(url, options);
    };
    const client = new AppClient(path.join(dir, "connection.json"), request); await client.poll();
    expect((await client.press("rings.gamble")).reason).toMatch(/not retried/);
    await client.poll(); await client.poll(); expect(posts).toBe(1); expect(f.bag.start).toHaveBeenCalledOnce();
  });
});
