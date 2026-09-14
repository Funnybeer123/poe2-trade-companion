import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";
import { scene, weakText } from "../tests/support/bagFixtures.js";
import { batch, strongText } from "../tests/support/batchFixtures.js";

export async function bagTriageSmoke(mode: SmokeBuildMode, testInfo: TestInfo) {
  const root = testInfo.outputPath("isolated-bag-worker"); mkdirSync(root, { recursive: true });
  await withPackagedElectron(mode, testInfo, async ({ application }) => {
    const runtime = await application.evaluate(({ app }) => ({ executable: process.execPath, path: app.getAppPath() }));
    const worker = path.join(runtime.path.replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "map-triage.cjs");
    expect(existsSync(worker)).toBe(true);
    const guard = path.join(root, "no-input.cjs");
    writeFileSync(guard, "const deny=()=>{process.exitCode=99;throw Error('OFFLINE_GUARD')};globalThis.fetch=deny;" +
      "for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny}" +
      "for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])require('node:child_process')[key]=deny;" +
      "require('node:net').connect=deny;require('node:net').Socket.prototype.connect=deny;");
    const run = (args: string[]) => execFileSync(runtime.executable, ["--require", guard, worker, ...args], {
      cwd: root, encoding: "utf8", timeout: 20000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", POE2_BAG_DATA_ROOT: root }, stdio: "pipe" });
    const input = path.join(root, "historical.json"), raw = JSON.stringify(batch([strongText(), weakText()]));
    writeFileSync(input, raw);
    expect(run(["--from-scan=" + input])).toContain('"nativeInputs":0');
    expect(readFileSync(input, "utf8")).toBe(raw);
    const replay = path.join(root, "capture.json"), journal = path.join(root, "session.jsonl");
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: scene([{ text: strongText(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }]) }]));
    const out = run(["--replay=" + replay, "--journal=" + journal]);
    expect(out).toContain('"physicalItems":2'); expect(out).toContain('"marketRequests":0');
    expect(existsSync(journal)).toBe(true);
    // Same no-live-adapter refusal as the daemon's stage=capture request.
    try { run(["--stage=capture", "--journal=" + path.join(root, "not-live.jsonl")]); throw new Error("expected refusal"); }
    catch (error) { expect((error as { status: number }).status).toBe(1); expect(String((error as { stderr: string }).stderr)).toContain("NOT ready"); }
  }, { cwd: root });
}
