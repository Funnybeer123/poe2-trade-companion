import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";
import { scene, weakText, unid, wisdom } from "../tests/support/bagFixtures.js";
import { batch, strongText } from "../tests/support/batchFixtures.js";

export async function bagTriageSmoke(mode: SmokeBuildMode, testInfo: TestInfo) {
  const root = testInfo.outputPath("isolated-bag-worker"); mkdirSync(root, { recursive: true });
  await withPackagedElectron(mode, testInfo, async ({ application, page }) => {
    // Keep the user's live clipboard from navigating this isolated UI test.
    await application.evaluate(({ BrowserWindow, clipboard }) => {
      clipboard.readText = () => "";
      for (const window of BrowserWindow.getAllWindows()) {
        const send = window.webContents.send.bind(window.webContents);
        window.webContents.send = (channel, ...args) => { if (channel !== "item:evaluated") send(channel, ...args); };
      }
    });
    await page.locator("aside.side-rail").getByRole("link", { name: /^Tools\b/ }).click();
    await page.getByRole("navigation", { name: "Tools and QA sections" }).getByRole("link", { name: /^Bag cleanup/ }).click();
    const panel = page.locator(".bag-triage-tool");
    await expect(panel.getByRole("heading", { name: "Bag triage", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Gamble rings · buy & sort", exact: true })).toBeDisabled();
    await expect(panel.getByRole("list", { name: "Bag setup needed" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Identify & drop", exact: true })).toBeDisabled();
    await panel.locator("summary").filter({ hasText: "Diagnostic controls" }).click();
    for (const name of ["Capture bag", "Identify one", "Drop one low-priority item", "Reconcile"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await expect(panel.getByRole("button", { name: "Refresh setup", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Refresh setup", exact: true }).click();
    await expect(panel.getByRole("list", { name: "Bag setup needed" })).toContainText("Bag cursor and inventory references are missing");
    await page.screenshot({ path: testInfo.outputPath("bag-triage.png"), fullPage: true });
    const runtime = await application.evaluate(({ app }) => ({ executable: process.execPath, path: app.getAppPath() }));
    const worker = path.join(runtime.path.replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "map-triage.cjs");
    expect(existsSync(worker)).toBe(true);
    const ringWorker = path.join(path.dirname(worker), "ring-gamble.cjs");
    expect(existsSync(ringWorker)).toBe(true);
    expect(execFileSync(runtime.executable, [ringWorker], { encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })).toContain("No game input emitted");
    expect(existsSync(path.join(runtime.path.replace(/app\.asar$/, "app.asar.unpacked"), "scripts", "win-bag-host.ps1"))).toBe(true);
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
    const before = scene([{ text: wisdom(3), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 }]);
    const identifyJournal = path.join(root, "identify-one.jsonl");
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: before }]));
    run(["--replay=" + replay, "--journal=" + identifyJournal]);
    const armed = structuredClone(before); armed.cursor = { state: "wisdom", evidence: "synthetic:wisdom-cursor" };
    const after = scene([{ text: wisdom(2), row: 0, col: 0 }, { text: weakText(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 }]);
    const action = { id: "identify-one:action:0", kind: "arm", itemId: "identify-one:Inventory:0,1", cell: { row: 0, col: 0 }, ground: { x: 400, y: 300 } };
    writeFileSync(replay, JSON.stringify([{ kind: "observe", scene: before }, { kind: "mutate", action }, { kind: "observe", scene: armed },
      { kind: "mutate", action: { ...action, id: "identify-one:action:1", kind: "identify", cell: { row: 0, col: 1 } } }, { kind: "observe", scene: after }]));
    const identified = run(["--replay=" + replay, "--journal=" + identifyJournal, "--stage=identify"]);
    expect(identified).toContain('"verifiedIdentifications":1'); expect(identified).toContain('"nativeInputs":0');
    // Missing per-client live perception must fail before the guarded host starts.
    try { run(["--stage=capture", "--journal=" + path.join(root, "not-live.jsonl"), "--perception=" + path.join(root, "absent-perception.json")]); throw new Error("expected refusal"); }
    catch (error) { expect((error as { status: number }).status).toBe(1); expect(String((error as { stderr: string }).stderr)).toContain("No native host started"); }
  });
}
