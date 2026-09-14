import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batch } from "../support/batchFixtures.js";
import { weakText, scene } from "../support/bagFixtures.js";
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
  it.each(["--max-drops=NaN", "--calibrate-moves", "--from-scan=missing.json", "--stage=capture"])("fails before native host for %s", arg => {
    try { run([arg]); throw new Error("expected refusal"); }
    catch (error) {
      const e = error as { stderr?: string; status?: number };
      expect(e.status).toBe(1); expect(String(e.stderr)).not.toContain("OFFLINE_GUARD");
    }
  });
});
