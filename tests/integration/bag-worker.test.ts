import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batch } from "../support/batchFixtures.js";
import { weakText, scene, unid, wisdom } from "../support/bagFixtures.js";
import { readBagJournal } from "../../src/main/bagSessionStore.js";
const dir = mkdtempSync(path.join(os.tmpdir(), "poe2-bag-worker-"));
const worker = path.join(dir, "map-triage.cjs"), guard = path.join(dir, "guard.cjs");
beforeAll(async () => {
  await build({ entryPoints: ["scripts/map-triage.ts"], outfile: worker, bundle: true, platform: "node", target: "node22", format: "cjs",
    define: { "import.meta.url": "__url" }, banner: { js: 'const __url=require("node:url").pathToFileURL(__filename).href;' } });
  writeFileSync(guard, "const deny=()=>{process.exitCode=99;throw Error('OFFLINE_GUARD')};globalThis.fetch=deny;" +
    "for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny}" +
    "for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])require('node:child_process')[key]=deny;" +
    "require('node:net').connect=deny;require('node:net').Socket.prototype.connect=deny;");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[]) => execFileSync(process.execPath, ["--require", guard, worker, ...args], {
  cwd: dir, windowsHide: true, encoding: "utf8", timeout: 20000, env: { ...process.env, POE2_BAG_DATA_ROOT: dir }, stdio: "pipe" });
describe("the standalone bag CLI uses the staged runner without native adapters", () => {
  it("reassesses saved batches with zero network/child input and unchanged originals", () => {
    const file = path.join(dir, "saved.json"), raw = JSON.stringify(batch([weakText()])); writeFileSync(file, raw);
    const out = run(["--from-scan=" + file]);
    expect(out).toContain('"marketRequests":0'); expect(out).toContain('"nativeInputs":0');
    expect(readFileSync(file, "utf8")).toBe(raw);
  });
  it("captures an empty bag and resumes a no-action stage in ordered replay", () => {
    const replay = path.join(dir, "capture.json"), journal = path.join(dir, "empty.jsonl");
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: scene([]) }]));
    expect(run(["--replay=" + replay, "--journal=" + journal])).toContain('"physicalItems":0');
    const resume = path.join(dir, "resume.json"); writeFileSync(resume, "[]");
    expect(run(["--replay=" + resume, "--journal=" + journal, "--stage=drop"])).toContain('"verifiedDrops":0');
    expect(readBagJournal(journal)[0]!.session.original.rows).toHaveLength(0);
  });
  it("executes exactly one scripted synthetic pickup/drop and no actual input", () => {
    const before = scene([{ text: weakText(), row: 0, col: 1 }]);
    const capture = path.join(dir, "one-capture.json"), journal = path.join(dir, "one.jsonl");
    writeFileSync(capture, JSON.stringify([{ kind: "observe", scene: before }]));
    run(["--replay=" + capture, "--journal=" + journal]);
    const picked = scene([]); picked.cursor = { state: "item", rawText: weakText(), evidence: "synthetic:held" };
    const after = scene([]); after.groundReceipt = { actionId: "one:action:1", rawText: weakText(), evidence: "synthetic:new-label" };
    const action = { id: "one:action:0", kind: "pickup", itemId: "one:Inventory:0,1", cell: { row: 0, col: 1 }, ground: { x: 400, y: 300 } };
    const replay = path.join(dir, "one-drop.json");
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: before }, { kind: "mutate", action },
      { kind: "observe", scene: picked }, { kind: "mutate", action: { ...action, id: "one:action:1", kind: "drop" } }, { kind: "observe", scene: after }]));
    const output = run(["--replay=" + replay, "--journal=" + journal, "--stage=drop", "--max-drops=1"]);
    expect(output).toContain('"verifiedDrops":1'); expect(output).toContain('"nativeInputs":0');
    expect(readBagJournal(journal).at(-1)!.session.receipts).toHaveLength(2);
  });
  it("defaults identification to exactly one physical item even with more unidentified items", () => {
    const before = scene([{ text: wisdom(3), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 }]);
    const capture = path.join(dir, "identify-capture.json"), journal = path.join(dir, "identify-one.jsonl");
    writeFileSync(capture, JSON.stringify([{ kind: "observe", scene: before }]));
    run(["--replay=" + capture, "--journal=" + journal]);
    const armed = structuredClone(before); armed.cursor = { state: "wisdom", evidence: "synthetic:wisdom-cursor" };
    const after = scene([{ text: wisdom(2), row: 0, col: 0 }, { text: weakText(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 }]);
    const action = { id: "identify-one:action:0", kind: "arm", itemId: "identify-one:Inventory:0,1", cell: { row: 0, col: 0 }, ground: { x: 400, y: 300 } };
    const replay = path.join(dir, "identify-actions.json");
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: before }, { kind: "mutate", action }, { kind: "observe", scene: armed },
      { kind: "mutate", action: { ...action, id: "identify-one:action:1", kind: "identify", cell: { row: 0, col: 1 } } }, { kind: "observe", scene: after }]));
    expect(run(["--replay=" + replay, "--journal=" + journal, "--stage=identify"])).toContain('"verifiedIdentifications":1');
    const saved = readBagJournal(journal).at(-1)!.session;
    expect(saved.report.rows[0]!.quantity).toBe(2);
    expect(saved.report.rows[2]!.rawText).toBe(unid());
  });
  it.each(["--max-identifications=NaN", "--max-identifications=0", "--max-identifications=1.5", "--max-identifications=60"])("rejects %s before live adapters", arg => {
    try { run(["--stage=identify", "--journal=unread.jsonl", "--run", arg]); throw new Error("expected refusal"); }
    catch (error) {
      const e = error as { stderr?: string; status?: number };
      expect(e.status).toBe(1); expect(String(e.stderr)).toContain("max-identifications");
      expect(String(e.stderr)).not.toContain("OFFLINE_GUARD");
    }
  });
  it.each(["--max-drops=NaN", "--calibrate-moves", "--from-scan=missing.json", "--stage=capture"])("fails before native host for %s", arg => {
    try { run([arg]); throw new Error("expected refusal"); }
    catch (error) {
      const e = error as { stderr?: string; status?: number };
      expect(e.status).toBe(1); expect(String(e.stderr)).not.toContain("OFFLINE_GUARD");
    }
  });
  function collision(args: string[]) {
    try { run(args); throw new Error("expected path collision refusal"); }
    catch (error) {
      const result = error as { stderr?: string; status?: number };
      expect(result.status).toBe(1); expect(String(result.stderr)).toContain("Bag path collision:");
      expect(String(result.stderr)).not.toContain("OFFLINE_GUARD");
    }
  }
  it.each(["journal", "lock", "calibration", "perception", "client-log"])("rejects output aliasing %s before any host or write", kind => {
    const folder = path.join(dir, "collision-output-" + kind); mkdirSync(folder);
    const protectedFile = path.join(folder, "protected.json"), journal = kind === "journal" ? protectedFile : kind === "lock" ? protectedFile.slice(0, -5) : path.join(folder, "session.jsonl");
    const target = kind === "lock" ? journal + ".lock" : protectedFile;
    writeFileSync(target, "unchanged private test data\n");
    const args = ["--stage=capture", "--journal=" + journal, "--output=" + target,
      ...(["calibration", "perception", "client-log"].includes(kind) ? [`--${kind}=${target}`] : [])];
    collision(args); expect(readFileSync(target, "utf8")).toBe("unchanged private test data\n");
    expect(existsSync(path.join(folder, "batch-history"))).toBe(false);
    if (kind !== "journal") expect(existsSync(journal)).toBe(false);
  });
  it.each(["calibration", "perception", "client-log"])("rejects a journal or lock aliasing %s", kind => {
    const folder = path.join(dir, "collision-journal-" + kind); mkdirSync(folder);
    const file = path.join(folder, "input.json"); writeFileSync(file, "immutable\n");
    collision(["--stage=capture", `--${kind}=${file}`, "--journal=" + file, "--output=" + path.join(folder, "output.json")]);
    const journal = path.join(folder, "locked-session.jsonl"); writeFileSync(journal + ".lock", "immutable lock target\n");
    collision(["--stage=capture", `--${kind}=${journal}.lock`, "--journal=" + journal]);
    expect(readFileSync(file, "utf8")).toBe("immutable\n"); expect(existsSync(journal)).toBe(false);
  });
  it("rejects replay and original-capture aliases, including case differences and temporary output", () => {
    const file = path.join(dir, "alias-original.json"); writeFileSync(file, JSON.stringify(batch([weakText()]))); const before = readFileSync(file, "utf8");
    collision(["--from-scan=" + file, "--output=" + file.toUpperCase()]);
    collision(["--replay=" + file, "--journal=" + file]);
    collision(["--replay=" + file, "--output=" + file]);
    const temporary = path.join(dir, "alias-output.json.tmp"); writeFileSync(temporary, before);
    collision(["--from-scan=" + temporary, "--output=" + temporary.slice(0, -4)]);
    expect(readFileSync(file, "utf8")).toBe(before); expect(readFileSync(temporary, "utf8")).toBe(before);
  });
  it("resolves linked parents for new output paths and existing hard-link aliases", () => {
    const actual = path.join(dir, "actual-output"), alias = path.join(dir, "aliased-output"); mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    collision(["--stage=capture", "--journal=" + path.join(actual, "new.jsonl"), "--output=" + path.join(alias, "new.jsonl")]);
    expect(existsSync(path.join(actual, "new.jsonl"))).toBe(false);
    const original = path.join(actual, "saved.json"), linked = path.join(alias, "hard-linked.json");
    writeFileSync(original, JSON.stringify(batch([weakText()]))); linkSync(original, linked); const before = readFileSync(original, "utf8");
    collision(["--from-scan=" + original, "--output=" + linked]);
    expect(readFileSync(original, "utf8")).toBe(before);
  });
});
