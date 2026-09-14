import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStashValuationSettings, STASH_SCORING_VERSION, type StashValuationReport } from "../src/core/stashValuation.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(), read: vi.fn(), mkdir: vi.fn(), write: vi.fn(), rename: vi.fn(),
  provider: vi.fn(), quote: vi.fn(), dispose: vi.fn(), host: vi.fn(), profile: vi.fn(),
  kit: vi.fn(), sorter: vi.fn(), harness: vi.fn(), liveRun: vi.fn(), network: vi.fn(),
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists, readFileSync: mocks.read, mkdirSync: mocks.mkdir, writeFileSync: mocks.write, renameSync: mocks.rename }));
vi.mock("../src/main/priceFeedService.js", () => ({ PriceFeedService: mocks.provider }));
vi.mock("../src/adapters/winHost.js", () => ({ startWinHost: mocks.host }));
vi.mock("../src/adapters/stashTabKit.js", () => ({ StashTabKit: mocks.kit }));
vi.mock("../src/adapters/gearSorter.js", () => ({ GearSorter: mocks.sorter }));
vi.mock("../src/adapters/sortHarness.js", () => ({ SortHarness: mocks.harness }));
vi.mock("../src/core/calibrationStore.js", () => ({ loadProfile: mocks.profile }));
vi.mock("../src/core/dumpValuationRun.js", () => ({ runDumpValuation: mocks.liveRun }));

const root = path.resolve("C:/virtual-saved-pricing-tests");
const source = path.join(root, "saved.json");
const settingsFile = path.join(root, "artifacts", "tab-admin", "stash-valuation.json");
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const files = new Map<string, string>();
const settings = { ...defaultStashValuationSettings(), league: "Forbidden Rites", routingMode: "purpose" as const };
const saved: StashValuationReport = { schemaVersion: 1, id: "original-capture", startedAt: "2026-09-14T11:00:00.000Z",
  finishedAt: "2026-09-14T11:30:00.000Z", league: settings.league, settings, scoreVersion: STASH_SCORING_VERSION,
  mode: "scan", status: "complete", sourceTab: "Dump", scannedItems: 0, rows: [], unreadCells: [], errors: [] };

beforeEach(() => {
  vi.resetModules();
  files.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.exists.mockImplementation((file: string) => files.has(path.resolve(file)));
  mocks.read.mockImplementation((file: string) => {
    const value = files.get(path.resolve(file));
    if (value === undefined) throw new Error("Unexpected file read: " + file);
    return value;
  });
  mocks.provider.mockImplementation(function () { return { fetchStashQuote: mocks.quote, dispose: mocks.dispose }; });
  for (const mock of [mocks.host, mocks.profile, mocks.kit, mocks.sorter, mocks.harness, mocks.liveRun, mocks.quote, mocks.network]) {
    mock.mockImplementation(() => { throw new Error("Unexpected live input or market access."); });
  }
  vi.stubGlobal("fetch", mocks.network);
  vi.stubEnv("POE2_STASH_DATA_ROOT", root);
  vi.stubEnv("POE2_MARKET_CONFIG_DIR", path.join(root, "market"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
  // A valid current profile would otherwise allow an accidental live fallback.
  files.set(settingsFile, JSON.stringify(settings));
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function invoke(args: string[]): Promise<void> {
  process.argv = ["node", "scripts/value-dump.ts", ...args];
  await import("../scripts/value-dump.js");
}
function expectNoLiveAccess(): void {
  for (const mock of [mocks.host, mocks.profile, mocks.kit, mocks.sorter, mocks.harness, mocks.liveRun, mocks.quote, mocks.network]) expect(mock).not.toHaveBeenCalled();
}
async function expectRejected(args: string[]): Promise<void> {
  await invoke(args);
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(console.error).toHaveBeenCalled();
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expectNoLiveAccess();
}

describe("saved pricing CLI boundary", () => {
  it.each(["null", "false", "0", '""', "{}", "{malformed JSON"])("rejects saved payload %s without falling back to live scanning", async payload => {
    files.set(source, payload);
    await expectRejected(["--from-scan=" + source, "--pending-only"]);
  });

  it.each([
    ["--from-scan"], ["--from-scan="], ["--pending-only"],
    ["--from-scan=" + source, "--pending-only", "--move"],
    ["--from-scan=" + source, "--pending-only", "--craft-only"],
  ])("rejects invalid offline option combination %j before provider or input initialization", async (...args) => {
    files.set(source, JSON.stringify(saved));
    await expectRejected(args);
  });

  it.each(["{malformed current settings", JSON.stringify({ ...settings, league: "Standard" })])("uses only the saved profile when current settings are %s", async currentSettings => {
    files.set(source, JSON.stringify(saved));
    files.set(settingsFile, currentSettings);
    await invoke(["--from-scan=" + source, "--pending-only"]);
    await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledTimes(1));
    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    expectNoLiveAccess();
    expect(mocks.provider).toHaveBeenCalledTimes(1);
    expect(mocks.read.mock.calls.map(call => path.resolve(String(call[0])))).not.toContain(settingsFile);
    const latest = mocks.write.mock.calls.at(-1);
    expect(latest).toBeDefined();
    const result = JSON.parse(String(latest![1])) as StashValuationReport;
    expect(result).toMatchObject({ id: saved.id, startedAt: saved.startedAt, league: "Forbidden Rites", settings: saved.settings,
      sourceTab: "Dump", scannedItems: 0, rows: [], status: "complete" });
    expect(mocks.rename).toHaveBeenCalled();
  });

  it("rejects a conflicting league override before creating a provider or game host", async () => {
    files.set(source, JSON.stringify(saved));
    await expectRejected(["--from-scan=" + source, "--pending-only", "--league=Standard"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("original league"));
  });
});
