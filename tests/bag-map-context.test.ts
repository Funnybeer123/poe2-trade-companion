import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BagMapLogParser, createBagMapContext, validateBagCalibration } from "../src/adapters/bagMapContext.js";
import { emptyProfile } from "../src/core/calibrationProfile.js";

const dirs: string[] = [];
const temporary = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "poe2-map-context-")); dirs.push(dir); return path.join(dir, "Client.txt"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const log = (message: string, level = "INFO", pid = 1200) => `2026/09/14 15:23:22 16245015 abc123 [${level} Client ${pid}] ${message}`;
const entered = (area = "MapSlick", source = "Slick") => [
  log("Got Instance Details from login server", "DEBUG"),
  log("Connecting to instance server at 192.0.2.1:1234 "),
  log("Client-Safe Instance ID = 123456", "DEBUG"),
  log(`Generating level 79 area "${area}" with seed 987654`, "DEBUG"),
  log("[SCENE] Set Source [(null)]"),
  log(`[SCENE] Set Source [${source}]`),
  log(`[LOADING SCREEN] (${source}) Duration = 1.29444 seconds`),
];
const feed = (parser: BagMapLogParser, lines: string[], start = 0) => { let offset = start; for (const line of lines) { parser.accept(line, offset); offset += Buffer.byteLength(line + "\n"); } return offset; };

describe("positive bag map context", () => {
  it("requires a client-safe instance, generated map, matching scene and completed loading", () => {
    const parser = new BagMapLogParser("fixture");
    expect(parser.snapshot().context).toBe("unknown");
    const lines = entered();
    const offset = feed(parser, lines.slice(0, -1));
    expect(parser.snapshot()).toMatchObject({ context: "unknown", loading: true, mapInstance: "" });
    feed(parser, lines.slice(-1), offset);
    expect(parser.snapshot(100, 1200)).toMatchObject({ context: "map", loading: false, areaId: "MapSlick", areaName: "Slick", observedAt: 100, processId: 1200 });
    expect(parser.snapshot().mapInstance).toMatch(/^client-log:[a-f0-9]{64}$/);
    expect(parser.snapshot(100, 1201)).toMatchObject({ context: "unknown", mapInstance: "", loading: true });
  });
  it("changes identity on same-seed same-server reentry and never uses absence of town as proof", () => {
    const parser = new BagMapLogParser("fixture");
    const offset = feed(parser, entered()), first = parser.snapshot().mapInstance;
    feed(parser, entered(), offset);
    expect(parser.snapshot().mapInstance).not.toBe(first);
    feed(parser, entered("G2_13", "Campaign area"), offset * 2);
    expect(parser.snapshot()).toMatchObject({ context: "unknown", mapInstance: "" });
  });
  it.each([["HideoutShoreline", "hideout"], ["G2_town", "town"]])("recognizes %s as %s without allowing map input", (area, context) => {
    const parser = new BagMapLogParser("fixture"); feed(parser, entered(area));
    expect(parser.snapshot()).toMatchObject({ context, mapInstance: "", loading: false });
  });
  it.each([
    log("Got Instance Details from login server", "DEBUG"),
    log("Connecting to instance server at 192.0.2.1:5678 "),
    log("Abnormal disconnect: An unexpected disconnection occurred."),
    log("Abnormal disconnect: An unexpected disconnection occurred.", "ERROR"),
    log("Async connecting to example.login.pathofexile2.com:21262"),
    log("[SCENE] Set Source [(null)]"),
    log("Client-Safe Instance ID = 123457", "DEBUG"),
    log("Client-Safe Instance ID = unknown", "DEBUG"),
    log("Generating level 79 area \"Future-Unknown-Format\" with seed 987654", "DEBUG"),
    log("[LOADING SCREEN] (Different area) Duration = 1.2 seconds"),
    log("[WINDOW] Gained focus", "INFO", 1300),
  ])("invalidates prior entry for transition %s", transition => {
    const parser = new BagMapLogParser("fixture"); const offset = feed(parser, entered());
    parser.accept(transition, offset);
    expect(parser.snapshot()).toMatchObject({ context: "unknown", loading: true, mapInstance: "" });
  });
  it("rejects mismatched loading, missing instance identity and chat imitations", () => {
    const parser = new BagMapLogParser("fixture");
    feed(parser, entered().filter(line => !line.includes("Client-Safe")));
    expect(parser.snapshot().context).toBe("unknown");
    feed(parser, entered().map(line => line.replace("Client 1200] ", "Client 1200] #Example: ")));
    expect(parser.snapshot().context).toBe("unknown");
    feed(parser, [...entered().slice(0, -1), log("[LOADING SCREEN] (Other) Duration = 1 seconds")]);
    expect(parser.snapshot().context).toBe("unknown");
  });
  it("ignores unrelated chat/disconnected text and preserves privacy in evidence", () => {
    const parser = new BagMapLogParser("fixture"); const offset = feed(parser, entered()), before = parser.snapshot().mapInstance;
    feed(parser, [log("#Example: unexpected disconnect occurred"), log("@Example: Generating level 79 area \"MapPit\" with seed 1")], offset);
    expect(parser.snapshot().mapInstance).toBe(before);
    expect(parser.snapshot().evidence).not.toMatch(/Example|192\.0\.2|Slick/);
  });
});

describe("incremental Client.txt observation", () => {
  it("reads existing state, appended partial transitions, and same-area reentry", () => {
    const file = temporary(); writeFileSync(file, entered().join("\r\n") + "\r\n");
    const reader = createBagMapContext(file), first = reader.read(1200);
    expect(first.context).toBe("map"); expect(reader.read(1200).mapInstance).toBe(first.mapInstance);
    const transition = log("Got Instance Details from login server", "DEBUG");
    appendFileSync(file, transition.slice(0, 30));
    expect(reader.read().context).toBe("unknown");
    appendFileSync(file, transition.slice(30) + "\n");
    expect(reader.read()).toMatchObject({ context: "unknown", loading: true });
    appendFileSync(file, entered().join("\n") + "\n");
    expect(reader.read().context).toBe("map");
    expect(reader.read().mapInstance).not.toBe(first.mapInstance);
    expect(createBagMapContext(file).read().mapInstance).toBe(reader.read().mapInstance);
  });
  it("invalidates missing, replaced, truncated and overwritten files", () => {
    const file = temporary(), reader = createBagMapContext(file);
    expect(reader.read()).toMatchObject({ context: "unknown", loading: true });
    writeFileSync(file, entered().join("\n") + "\n"); const first = reader.read().mapInstance;
    renameSync(file, file + ".old"); writeFileSync(file, entered().join("\n") + "\n");
    expect(reader.read().mapInstance).not.toBe(first);
    writeFileSync(file, "unrelated line\n"); expect(reader.read().context).toBe("unknown");
    writeFileSync(file, entered().join("\n") + "\n"); expect(reader.read().context).toBe("map");
    writeFileSync(file, "x".repeat(3000) + "\n"); expect(reader.read().context).toBe("unknown");
  });
  it("bounds initial reads and skips the partial first line", () => {
    const file = temporary(); writeFileSync(file, "x".repeat(5000) + "\n" + entered().join("\n") + "\n" + "x".repeat(600) + "\n");
    expect(createBagMapContext(file, { maxReadBytes: 2048 }).read().context).toBe("map");
    expect(createBagMapContext(file, { maxReadBytes: 1024 }).read().context).toBe("unknown");
  });
});

describe("bag calibration binding", () => {
  const profile = () => ({ ...emptyProfile(3840, 2160), bagGrid: { x: 2530, y: 1173, w: 1289, h: 541, cols: 12, rows: 5 } });
  const client = { x: 0, y: 0, w: 3840, h: 2160 };
  it("binds geometry to exact client dimensions and location", () => {
    const calibrated = validateBagCalibration(profile(), client);
    expect(calibrated.grid).toEqual(profile().bagGrid);
    expect(validateBagCalibration(profile(), { ...client, x: 10 }).hash).not.toBe(calibrated.hash);
    expect(() => validateBagCalibration(profile(), { ...client, w: 1920 })).toThrow("calibration");
  });
  it.each([{ cols: 10 }, { x: -1 }, { w: 9999 }, { y: Number.NaN }])("rejects invalid grid %o", patch => {
    const p = profile(); Object.assign(p.bagGrid, patch);
    expect(() => validateBagCalibration(p, client)).toThrow("calibration");
  });
});
