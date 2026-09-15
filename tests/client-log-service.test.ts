import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import {
  ClientLogTailer,
  createClientLogModule,
  normalizeClientLogSettings,
  realClientLogFs,
  RING_CAPACITY,
  type ClientLogFs,
  type ClientLogModuleOptions,
} from "../src/main/features/clientLog/index.js";
import {
  clientLogCandidates,
  gameSettingsCandidates,
  locateClientLog,
  parseSteamLibraryFolders,
} from "../src/main/features/clientLog/locate.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { ClientLogEvent } from "../src/core/clientLog.js";
import type { ClientLogStatus } from "../src/shared/clientLog.js";

const ENV = { programFilesX86: "C:\\PF86", programFiles: "C:\\PF" };
const PROFILE = "C:\\Users\\tester";
const STEAM_LOG = path.join(ENV.programFilesX86, "Steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt");
const STANDALONE_LOG = path.join(ENV.programFilesX86, "Grinding Gear Games", "Path of Exile 2", "logs", "Client.txt");
const EPIC_LOG = path.join(ENV.programFiles, "Epic Games", "Path of Exile 2", "logs", "Client.txt");
const VDF = path.join(ENV.programFilesX86, "Steam", "steamapps", "libraryfolders.vdf");
const LIBRARY_LOG = path.join("D:\\Games\\Steam", "steamapps", "common", "Path of Exile 2", "logs", "Client.txt");

const FIXTURE = readFileSync(path.join(process.cwd(), "fixtures", "client-log", "sample-en.txt"), "utf8");
const P = (n: number) => `2026/09/11 21:00:${String(n).padStart(2, "0")} 40300000 3ef23348 [INFO Client 23032] `;
const D = (n: number) => `2026/09/11 21:00:${String(n).padStart(2, "0")} 40300000 2caa229f [DEBUG Client 23032] `;

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const key = (file: string) => file.toLowerCase();
  const set = (file: string, text: string, mtimeMs = 1) => {
    files.set(key(file), Buffer.from(text, "utf8"));
    mtimes.set(key(file), mtimeMs);
  };
  const appendBytes = (file: string, bytes: Buffer) => {
    files.set(key(file), Buffer.concat([files.get(key(file)) ?? Buffer.alloc(0), bytes]));
  };
  for (const [file, text] of Object.entries(initial)) set(file, text);
  const reads: Array<[number, number]> = [];
  const fs: ClientLogFs = {
    exists: (file) => files.has(key(file)),
    readText: (file) => files.get(key(file))?.toString("utf8"),
    stat: (file) => {
      const buffer = files.get(key(file));
      return buffer ? { size: buffer.length, mtimeMs: mtimes.get(key(file)) ?? 1 } : undefined;
    },
    readRange: (file, start, end) => {
      reads.push([start, end]);
      const buffer = files.get(key(file));
      if (!buffer) throw new Error(`ENOENT ${file}`);
      return Buffer.from(buffer.subarray(start, Math.min(end, buffer.length)));
    },
  };
  return {
    fs,
    reads,
    set,
    append: (file: string, text: string) => appendBytes(file, Buffer.from(text, "utf8")),
    appendBytes,
    remove: (file: string) => files.delete(key(file)),
  };
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke };
}

function fakeWindow() {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      },
    },
  };
}

async function boot(options: ClientLogModuleOptions, settingsJson?: string) {
  const { ipc, invoke } = fakeIpc();
  const memory = new Map<string, string>();
  if (settingsJson) memory.set("settings.json", settingsJson);
  const settings = new SettingsStore({
    file: "settings.json",
    fs: { read: (file) => memory.get(file), write: (file, text) => void memory.set(file, text) },
  });
  const main = fakeWindow();
  const log = vi.fn();
  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: {} as never,
    settings,
    mainWindow: () => main as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: async () => undefined,
    log,
  });
  const result = await rt.register([createClientLogModule({ manualPolls: true, env: ENV, userProfile: PROFILE, ...options })]);
  expect(result.failed).toEqual([]);
  const service = rt.ctx.require("clientLog") as ClientLogTailer;
  const eventsSent = () => main.sent.filter(([channel]) => channel === "client-log:event").map(([, payload]) => payload as ClientLogEvent);
  return { rt, invoke, service, main, settings, memory, log, eventsSent };
}

describe("settings sanitizer", () => {
  it("keeps a trimmed file override and a strict boolean gate", () => {
    expect(normalizeClientLogSettings(undefined)).toEqual({ allowInject: false });
    expect(normalizeClientLogSettings({ file: "  C:\\x\\Client.txt ", allowInject: "yes" })).toEqual({
      file: "C:\\x\\Client.txt",
      allowInject: false,
    });
    expect(normalizeClientLogSettings({ file: "", allowInject: true })).toEqual({ allowInject: true });
    expect(normalizeClientLogSettings({ file: 42 })).toEqual({ allowInject: false });
  });
});

describe("locator", () => {
  it("parses Steam library roots from libraryfolders.vdf", () => {
    const vdf = [
      '"libraryfolders"',
      "{",
      '\t"0"',
      "\t{",
      '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
      '\t\t"label"\t\t""',
      "\t}",
      '\t"1"',
      "\t{",
      '\t\t"path"\t\t"D:\\\\Games\\\\Steam"',
      "\t}",
      "}",
    ].join("\n");
    expect(parseSteamLibraryFolders(vdf)).toEqual(["C:\\Program Files (x86)\\Steam", "D:\\Games\\Steam"]);
    expect(parseSteamLibraryFolders("")).toEqual([]);
  });

  it("orders candidates override → steam (default + libraries) → standalone → epic, deduplicated", () => {
    const { fs } = fakeFs({ [VDF]: '"path" "D:\\\\Games\\\\Steam"\n"path" "C:\\\\PF86\\\\Steam"' });
    const candidates = clientLogCandidates(ENV, fs, "E:\\override\\Client.txt");
    expect(candidates.map((c) => c.source)).toEqual(["override", "steam", "steam", "standalone", "standalone", "epic", "epic"]);
    expect(candidates[1].file).toBe(STEAM_LOG);
    expect(candidates[2].file).toBe(LIBRARY_LOG);
    expect(candidates[3].file).toBe(STANDALONE_LOG);
    expect(candidates[5].file).toBe(EPIC_LOG);
  });

  it("picks the first existing candidate and reports none otherwise", () => {
    expect(locateClientLog(ENV, fakeFs().fs)).toMatchObject({ source: "none" });
    expect(locateClientLog(ENV, fakeFs({ [EPIC_LOG]: "" }).fs)).toMatchObject({ file: EPIC_LOG, source: "epic" });
    expect(locateClientLog(ENV, fakeFs({ [STANDALONE_LOG]: "", [EPIC_LOG]: "" }).fs)).toMatchObject({ source: "standalone" });
    const library = fakeFs({ [VDF]: '"path" "D:\\\\Games\\\\Steam"', [LIBRARY_LOG]: "" });
    expect(locateClientLog(ENV, library.fs)).toMatchObject({ file: LIBRARY_LOG, source: "steam" });
    expect(locateClientLog(ENV, library.fs, "E:\\o\\Client.txt")).toMatchObject({ source: "steam" });
    expect(locateClientLog(ENV, fakeFs({ "E:\\o\\Client.txt": "" }).fs, "E:\\o\\Client.txt")).toMatchObject({ source: "override" });
  });

  it("names both game-config locations (Documents and the OneDrive redirect)", () => {
    const [plain, oneDrive] = gameSettingsCandidates(PROFILE);
    expect(plain).toBe(path.join(PROFILE, "Documents", "My Games", "Path of Exile 2", "poe2_production_Config.ini"));
    expect(oneDrive).toBe(path.join(PROFILE, "OneDrive", "Documents", "My Games", "Path of Exile 2", "poe2_production_Config.ini"));
  });
});

describe("client log module", () => {
  it("backfills the tail into `recent` without emitting, and knows character + area at launch", async () => {
    const disk = fakeFs({ [STEAM_LOG]: FIXTURE });
    const seen: ClientLogEvent[] = [];
    const { service, invoke, main, eventsSent } = await boot({ fs: disk.fs });
    service.on("*", (event) => seen.push(event));

    const status = (await invoke("client-log:status")) as ClientLogStatus;
    expect(status).toMatchObject({ file: STEAM_LOG, source: "steam", watching: true, sizeBytes: Buffer.byteLength(FIXTURE) });
    expect(status.character).toMatchObject({ name: "Fakelia", className: "Disciple of Varashta", level: 88 });
    expect(status.area).toMatchObject({ kind: "area", areaId: "HideoutBeaconOfSalvation", level: 65 });
    expect(status.error).toBeUndefined();

    const recent = (await invoke("client-log:recent")) as ClientLogEvent[];
    expect(recent.length).toBe(24);
    expect(((await invoke("client-log:recent", "whisper")) as ClientLogEvent[]).length).toBe(5);
    expect(((await invoke("client-log:recent", "whisper", 2)) as ClientLogEvent[]).map((e) => e.kind)).toEqual(["whisper", "whisper"]);
    expect(eventsSent()).toEqual([]);
    expect(seen).toEqual([]);
    // Backfill read only the tail window, never from 0 for a big file: here the file is small so [0, size).
    expect(disk.reads).toEqual([[0, Buffer.byteLength(FIXTURE)]]);
    expect(main.sent.some(([channel]) => channel === "client-log:status")).toBe(true);
  });

  it("bounds the backfill window and drops the leading partial line", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `${P(i)}: Fakelia has been slain.`);
    const text = `${lines.join("\n")}\n`;
    const disk = fakeFs({ [STEAM_LOG]: text });
    const window = 200;
    const { service, invoke } = await boot({ fs: disk.fs, backfillBytes: window });
    const size = Buffer.byteLength(text);
    expect(disk.reads).toEqual([[size - window, size]]);
    const recent = service.recent("death");
    // 200 bytes hold two complete ~90-byte lines after the fragment is dropped.
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent.length).toBeLessThanOrEqual(2);
    for (const event of recent) expect(event.kind).toBe("death");
    expect(((await invoke("client-log:status")) as ClientLogStatus).sizeBytes).toBe(size);
  });

  it("emits appended lines live to subscribers and windows, carrying partial lines and split UTF-8", async () => {
    const disk = fakeFs({ [STEAM_LOG]: `${P(0)}: Trade accepted.\n` });
    const { service, eventsSent, main } = await boot({ fs: disk.fs });
    const whispers: string[] = [];
    const all: string[] = [];
    const stopWhisper = service.on("whisper", (event) => whispers.push(event.text));
    service.on("*", (event) => all.push(event.kind));

    service.poll();
    expect(all).toEqual([]);

    // A line arrives in two halves: nothing until the newline lands.
    const line = `${P(1)}@From Buyer: Здравствуйте, still selling?`;
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("Здравствуйте", "utf8")) + 3; // inside a 2-byte character
    disk.appendBytes(STEAM_LOG, bytes.subarray(0, cut));
    service.poll();
    expect(all).toEqual([]);
    disk.appendBytes(STEAM_LOG, bytes.subarray(cut));
    service.poll();
    expect(all).toEqual(["whisper"]);
    expect(whispers).toEqual(["Здравствуйте, still selling?"]);
    expect(eventsSent()).toMatchObject([{ kind: "whisper", player: "Buyer" }]);

    // Two lines in one poll, CRLF, and a status update for the area change.
    const statusCount = main.sent.filter(([channel]) => channel === "client-log:status").length;
    disk.append(STEAM_LOG, `${D(2)}Generating level 79 area "MapSunTemple" with seed 5\r\n${P(3)}: Trade accepted.\r\n`);
    service.poll();
    expect(all).toEqual(["whisper", "area", "trade"]);
    expect(service.status().area).toMatchObject({ areaId: "MapSunTemple", level: 79 });
    expect(main.sent.filter(([channel]) => channel === "client-log:status").length).toBe(statusCount + 1);
    expect(service.status().lastLineAt).toBe(new Date(2026, 8, 11, 21, 0, 3).toISOString());

    stopWhisper();
    disk.append(STEAM_LOG, `${P(4)}@From Buyer: ty\n`);
    service.poll();
    expect(whispers).toHaveLength(1);
    expect(all).toHaveLength(4);
  });

  it("restarts from the top when the file shrinks, without replaying the new tail as live events", async () => {
    const disk = fakeFs({ [STEAM_LOG]: `${P(0)}: Trade accepted.\n${P(1)}: Trade cancelled.\n` });
    const { service, eventsSent, log } = await boot({ fs: disk.fs });
    expect(service.recent("trade")).toHaveLength(2);

    disk.set(STEAM_LOG, `${P(5)}: Fakelia has been slain.\n`);
    service.poll();
    expect(eventsSent()).toEqual([]);
    expect(service.recent().map((e) => e.kind)).toEqual(["trade", "trade", "death"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ feature: "clientLog", message: expect.stringContaining("shrank") }));

    disk.append(STEAM_LOG, `${P(6)}: Trade accepted.\n`);
    service.poll();
    expect(eventsSent()).toMatchObject([{ kind: "trade", result: "accepted" }]);
    expect(service.status().sizeBytes).toBe(Buffer.byteLength(`${P(5)}: Fakelia has been slain.\n${P(6)}: Trade accepted.\n`));
  });

  it("reports a missing file, recovers when it returns, and relocates while none is found", async () => {
    const disk = fakeFs();
    const { service, invoke } = await boot({ fs: disk.fs });
    expect((await invoke("client-log:status")) as ClientLogStatus).toMatchObject({
      source: "none",
      watching: false,
      error: expect.stringContaining("not found"),
    });
    disk.set(STANDALONE_LOG, `${P(0)}: Trade accepted.\n`);
    for (let i = 0; i < 19; i += 1) service.poll();
    expect(service.status().source).toBe("none");
    service.poll();
    expect(service.status()).toMatchObject({ source: "standalone", file: STANDALONE_LOG, watching: true });
    expect(service.recent("trade")).toHaveLength(1);

    disk.remove(STANDALONE_LOG);
    service.poll();
    expect(service.status()).toMatchObject({ watching: false, error: expect.stringContaining("disappeared") });
    disk.set(STANDALONE_LOG, `${P(0)}: Trade accepted.\n${P(1)}: Trade cancelled.\n`);
    service.poll();
    expect(service.status()).toMatchObject({ watching: true });
    expect(service.status().error).toBeUndefined();
  });

  it("caps the ring buffer at 5,000 events, newest last", async () => {
    const disk = fakeFs({ [STEAM_LOG]: "" });
    const { service } = await boot({ fs: disk.fs });
    const lines: string[] = [];
    for (let i = 0; i < RING_CAPACITY + 100; i += 1) lines.push(`${P(i % 60)}: Player${i} has been slain.`);
    disk.append(STEAM_LOG, `${lines.join("\n")}\n`);
    service.poll();
    const recent = service.recent();
    expect(recent).toHaveLength(RING_CAPACITY);
    expect(recent.at(-1)).toMatchObject({ kind: "death", character: `Player${RING_CAPACITY + 99}` });
    expect(recent[0]).toMatchObject({ character: "Player100" });
    expect(service.recent("death", 3)).toHaveLength(3);
  });

  it("replayTail refills `recent` without emitting and returns the event count", async () => {
    const disk = fakeFs({ [STEAM_LOG]: FIXTURE });
    const { service, eventsSent } = await boot({ fs: disk.fs });
    disk.append(STEAM_LOG, `${P(0)}: Trade accepted.\n`);
    service.poll();
    expect(eventsSent()).toHaveLength(1);
    expect(await service.replayTail()).toBe(25);
    expect(service.recent()).toHaveLength(25);
    expect(eventsSent()).toHaveLength(1);
    expect(await service.replayTail(150)).toBe(1);
    expect(service.recent()).toHaveLength(1);
  });

  it("honours the override from settings, persists set-file, and flags a missing override", async () => {
    const disk = fakeFs({ [STEAM_LOG]: `${P(0)}: Trade accepted.\n`, "E:\\mine\\Client.txt": `${P(0)}: Trade cancelled.\n` });
    const { service, invoke, settings } = await boot(
      { fs: disk.fs },
      JSON.stringify({ version: 1, namespaces: { "client-log": { file: "E:\\mine\\Client.txt" } } }),
    );
    expect(service.status()).toMatchObject({ source: "override", file: "E:\\mine\\Client.txt" });
    expect(service.recent("trade")[0]).toMatchObject({ result: "cancelled" });

    const cleared = (await invoke("client-log:set-file", null)) as ClientLogStatus;
    expect(cleared).toMatchObject({ source: "steam", file: STEAM_LOG });
    expect(settings.snapshot()["client-log"]).toEqual({ allowInject: false });
    expect(service.recent("trade")[0]).toMatchObject({ result: "accepted" });

    const missing = (await invoke("client-log:set-file", "Z:\\nowhere\\Client.txt")) as ClientLogStatus;
    expect(missing).toMatchObject({ source: "steam", error: expect.stringContaining("override not found") });
    expect(settings.snapshot()["client-log"]).toEqual({ file: "Z:\\nowhere\\Client.txt", allowInject: false });
  });

  it("browse-file uses the injected dialog and ignores a cancel", async () => {
    const disk = fakeFs({ [STEAM_LOG]: "", "F:\\poe\\logs\\Client.txt": "" });
    const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) };
    const { invoke, service } = await boot({ fs: disk.fs, dialog });
    expect(((await invoke("client-log:browse-file")) as ClientLogStatus).source).toBe("steam");
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ["openFile"], defaultPath: STEAM_LOG }));
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["F:\\poe\\logs\\Client.txt"] });
    expect((await invoke("client-log:browse-file")) as ClientLogStatus).toMatchObject({ source: "override", file: "F:\\poe\\logs\\Client.txt" });
    expect(service.status().file).toBe("F:\\poe\\logs\\Client.txt");
  });

  it("inject is refused unless settings allow it, then parses and emits one line", async () => {
    const disk = fakeFs({ [STEAM_LOG]: "" });
    const { invoke, service, eventsSent } = await boot({ fs: disk.fs });
    await expect(invoke("client-log:inject", `${P(0)}: Trade accepted.`)).rejects.toThrow(/allowInject/);
    expect(eventsSent()).toEqual([]);
    await invoke("settings:set", "client-log", { allowInject: true });
    const seen: ClientLogEvent[] = [];
    service.on("trade", (event) => seen.push(event));
    expect(await invoke("client-log:inject", `${P(0)}: Trade accepted.`)).toMatchObject({ kind: "trade", result: "accepted" });
    expect(seen).toHaveLength(1);
    expect(eventsSent()).toHaveLength(1);
    expect(await invoke("client-log:inject", "garbage")).toBeUndefined();
  });

  it("loads the game settings ini, preferring the newest of the two Documents locations", async () => {
    const [plain, oneDrive] = gameSettingsCandidates(PROFILE);
    const disk = fakeFs({ [STEAM_LOG]: "" });
    disk.set(plain, "[DISPLAY]\nresolution_width=1920\nresolution_height=1080\n[ACTION_KEYS]\nchat=13\n", 10);
    disk.set(oneDrive, "[DISPLAY]\nresolution_width=2560\nresolution_height=1440\n[ACTION_KEYS]\nchat=13\n", 20);
    const { service } = await boot({ fs: disk.fs });
    expect(service.status().gameSettings).toEqual({ resolution: { width: 2560, height: 1440 }, chatKey: 13 });
    const none = await boot({ fs: fakeFs({ [STEAM_LOG]: "" }).fs });
    expect(none.service.status().gameSettings).toBeUndefined();
  });

  it("reload-settings re-reads the ini and returns the refreshed status", async () => {
    const [plain] = gameSettingsCandidates(PROFILE);
    const disk = fakeFs({ [STEAM_LOG]: `${P(0)}: Trade accepted.\n` });
    const { invoke, service } = await boot({ fs: disk.fs });
    expect(service.status().gameSettings).toBeUndefined();

    // The user changes the game's resolution and chat key while we run.
    disk.set(plain, "[DISPLAY]\nresolution_width=3440\nresolution_height=1440\n[ACTION_KEYS]\nchat=13\n", 30);
    expect(service.status().gameSettings).toBeUndefined();

    const reloaded = (await invoke("client-log:reload-settings")) as ClientLogStatus;
    expect(reloaded.gameSettings).toEqual({ resolution: { width: 3440, height: 1440 }, chatKey: 13 });
    expect(reloaded).toMatchObject({ source: "steam", file: STEAM_LOG, watching: true });
    // Same service, and it does not disturb the tail.
    expect(service.status().gameSettings).toEqual({ resolution: { width: 3440, height: 1440 }, chatKey: 13 });
    expect(service.recent("trade")).toHaveLength(1);
    expect(service.reloadGameSettings()).toEqual({ resolution: { width: 3440, height: 1440 }, chatKey: 13 });
  });

  it("disposes its timer and handlers with the runtime", async () => {
    vi.useFakeTimers();
    try {
      const disk = fakeFs({ [STEAM_LOG]: "" });
      const { rt, invoke, service } = await boot({ fs: disk.fs, manualPolls: false, pollMs: 500 });
      disk.append(STEAM_LOG, `${P(0)}: Trade accepted.\n`);
      vi.advanceTimersByTime(500);
      expect(service.recent("trade")).toHaveLength(1);
      await rt.dispose();
      disk.append(STEAM_LOG, `${P(1)}: Trade cancelled.\n`);
      vi.advanceTimersByTime(2000);
      expect(service.recent("trade")).toHaveLength(1);
      await expect(invoke("client-log:status")).rejects.toThrow(/no handler/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("real filesystem tail", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("tails a file in a temp dir that is appended over time", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "poe2-client-log-"));
    const file = path.join(dir, "Client.txt");
    writeFileSync(file, `${P(0)}: Fakelia (Witch) is now level 3\n`, "utf8");
    const { service, eventsSent } = await boot(
      { fs: realClientLogFs },
      JSON.stringify({ version: 1, namespaces: { "client-log": { file } } }),
    );
    expect(service.status()).toMatchObject({ source: "override", file, watching: true });
    expect(service.status().character).toMatchObject({ name: "Fakelia", level: 3 });
    expect(eventsSent()).toEqual([]);

    appendFileSync(file, `${D(1)}Generating level 2 area "G1_2" with seed 77\r\n`, "utf8");
    service.poll();
    expect(eventsSent()).toMatchObject([{ kind: "area", areaId: "G1_2", info: { name: "Clearfell", act: 1 } }]);

    appendFileSync(file, `${P(2)}@From Buyer: Hi, I would like to buy your Long Belt listed for 2 exalted in Standard`, "utf8");
    service.poll();
    expect(eventsSent()).toHaveLength(1);
    appendFileSync(file, "\n", "utf8");
    service.poll();
    expect(eventsSent()).toHaveLength(2);
    expect(eventsSent()[1]).toMatchObject({ kind: "whisper", trade: { itemName: "Long Belt", price: { amount: 2, currency: "exalted" } } });

    writeFileSync(file, `${P(3)}: Trade accepted.\n`, "utf8");
    service.poll();
    expect(eventsSent()).toHaveLength(2);
    expect(service.recent().at(-1)).toMatchObject({ kind: "trade" });
    service.dispose();
  });
});
