/** Built-app smoke: real feature IPC, isolated persistence, no external IO. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.join(root, "artifacts", "price-training", "smoke-" + stamp);
const isolated = mkdtempSync(path.join(os.tmpdir(), "poe2-price-training-smoke-"));
const cwd = path.join(isolated, "workspace");
const userData = path.join(isolated, "user-data");
const appData = path.join(isolated, "app-data");
const localAppData = path.join(isolated, "local-app-data");
const profile = path.join(isolated, "profile");
for (const dir of [output, cwd, userData, appData, localAppData, profile]) mkdirSync(dir, { recursive: true });
const config = path.join(cwd, "artifacts", "tab-admin");
mkdirSync(config, { recursive: true });
writeFileSync(path.join(config, "price-feed.json"), JSON.stringify({ league: "Forbidden Rites", autoRefreshDaily: false, poesessid: "" }));

// Serialized into a temporary CommonJS entry point, before importing the built app.
function isolatedBootstrap() {
  const electron = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const child = require("node:child_process");
  const http = require("node:http");
  const https = require("node:https");
  const { syncBuiltinESMExports } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const isolated = process.env.POE2_SMOKE_ISOLATION;
  const state = globalThis.__priceTrainingSmoke = { httpAttempts: [], childAttempts: [], writes: [], clipboardWrites: [] };
  const blockNetwork = (kind, target) => {
    state.httpAttempts.push({ kind, target: String(target?.url ?? target) });
    throw new Error("External HTTP disabled for isolated price-training smoke");
  };
  globalThis.fetch = async (target) => blockNetwork("fetch", target);
  http.request = http.get = (target) => blockNetwork("http", target);
  https.request = https.get = (target) => blockNetwork("https", target);
  electron.net.fetch = async (target) => blockNetwork("electron-fetch", target);
  electron.shell.openExternal = async (target) => blockNetwork("external-link", target);
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync"]) {
    const original = fs[name];
    fs[name] = function(target, ...args) {
      const resolved = path.resolve(String(target));
      const relative = path.relative(isolated, resolved);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("Smoke blocked a config write outside isolation: " + resolved);
      }
      state.writes.push(resolved);
      return original.call(this, target, ...args);
    };
  }
  child.spawn = (target) => {
    state.childAttempts.push(String(target));
    throw new Error("OS input and child processes disabled for isolated smoke");
  };
  child.execFile = (target, ...args) => {
    state.childAttempts.push(String(target));
    const callback = args.findLast((value) => typeof value === "function");
    const error = new Error("OS input and child processes disabled for isolated smoke");
    if (callback) { setImmediate(() => callback(error, "", "")); return {}; }
    throw error;
  };
  syncBuiltinESMExports();
  electron.clipboard.readText = () => "";
  electron.clipboard.writeText = (text) => { state.clipboardWrites.push(String(text)); };
  electron.globalShortcut.register = () => true;
  electron.globalShortcut.unregister = () => {};
  electron.globalShortcut.unregisterAll = () => {};
  electron.globalShortcut.isRegistered = () => false;
  electron.app.setAppPath(process.env.POE2_SMOKE_ROOT);
  electron.app.setPath("appData", process.env.APPDATA);
  electron.app.setPath("userData", process.env.POE2_SMOKE_USER_DATA);
  electron.app.setPath("logs", path.join(process.env.POE2_SMOKE_USER_DATA, "logs"));
  electron.app.on("browser-window-created", (_event, win) => {
    win.setAlwaysOnTop(false);
    win.hide();
    win.setBounds({ x: 0, y: 0, width: 1600, height: 1100 });
  });
  (async () => {
    await electron.app.whenReady();
    electron.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const remote = /^(https?|wss?):/i.test(details.url);
      if (remote) state.httpAttempts.push({ kind: "chromium", target: details.url });
      callback({ cancel: remote });
    });
    await import(pathToFileURL(path.join(process.env.POE2_SMOKE_ROOT, "dist-electron", "index.js")).href);
  })().catch((error) => { console.error(error); electron.app.exit(1); });
}

const bootstrap = path.join(isolated, "bootstrap.cjs");
writeFileSync(bootstrap, "(" + isolatedBootstrap.toString() + ")();");
const require = createRequire(import.meta.url);
const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: profile,
  POE2_SMOKE_ROOT: root, POE2_SMOKE_ISOLATION: isolated, POE2_SMOKE_USER_DATA: userData,
  POE2_ENABLE_LIVE_INPUT: "0", POE2_QA_OPT_IN: "0", POE2_QA_ACK: "0", ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const raw = readFileSync(path.join(root, "fixtures", "items", "chilling-sapphire-training.txt"), "utf8");
const pageErrors = [];
const logs = [];
let application;
let page;
const report = { builtEntry: path.join(root, "dist-electron", "index.js"), isolated, output, passed: false, screenshots: [], checks: [] };

try {
  application = await electron.launch({ executablePath: require("electron"), args: [bootstrap, "--disable-gpu"], cwd, env, timeout: 30_000 });
  application.process().stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  application.process().stderr?.on("data", (chunk) => logs.push(chunk.toString()));
  page = await application.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#app")).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1100 });
  const ipc = (channel, ...args) => page.evaluate(({ channel, args }) => globalThis.window.poe2.features.invoke(channel, ...args), { channel, args });
  const channels = await ipc("app:feature-channels");
  assert(channels.includes("price-training:save"), "built main registers real training IPC");
  await page.locator("aside.side-rail").getByRole("link", { name: /^Tools\b/ }).click();
  await page.getByRole("navigation", { name: "Tools and QA sections" }).getByRole("link", { name: /^Price training\b/ }).click();
  await expect(page.getByRole("heading", { name: "Price training", exact: true })).toBeVisible();
  report.checks.push("Tools navigation opens built Price training component");

  await page.getByLabel("Item copy", { exact: true }).fill(raw);
  await page.getByLabel("League", { exact: true }).fill("Forbidden Rites");
  await page.getByLabel("Price", { exact: true }).fill("1");
  await expect(page.locator('[name="evidence"]')).toHaveValue("estimate");
  await expect(page.locator('[name="scope"]')).toHaveValue("exact");
  await page.getByRole("button", { name: "Save example", exact: true }).click();
  await expect(page.locator(".price-training-tool").getByRole("status")).toContainText("Example saved");
  const learned = page.getByRole("region", { name: "Local training estimate" });
  await expect(learned).toContainText("1 divine");
  await expect(learned).toContainText("Evidence strength 40/100");
  const saved = await ipc("price-training:overview");
  assert.equal(saved.lessons.length, 1);
  assert.deepEqual({ amount: saved.lessons[0].amount, evidence: saved.lessons[0].evidence, scope: saved.lessons[0].scope }, { amount: 1, evidence: "estimate", scope: "exact" });
  const estimate = await ipc("price-training:preview", { itemText: raw, league: "Forbidden Rites" });
  assert.equal(estimate.estimate.matchKind, "exact");
  assert.equal(estimate.estimate.amount, 1);
  assert.equal(estimate.estimate.exampleCount, 1);
  report.checks.push("UI save persists 1 divine as estimate/exact; real core preview matches with evidence strength 40/100");
  await page.locator('[name="itemText"]').evaluate((element) => { element.scrollTop = 0; });
  const screenshot = path.join(output, "smoke-populated-desktop.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  report.screenshots.push(screenshot);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth), false, "desktop layout does not overflow horizontally");

  const valuation = await page.evaluate((text) => globalThis.window.poe2.evaluateText(text), raw);
  assert.equal(valuation.parsed, true);
  assert.equal(valuation.valuation.fair, 1);
  assert.equal(valuation.valuation.currency, "divine");
  assert.equal(valuation.valuation.providerName, "price-training");
  assert.equal(valuation.desirability.category, "keep");
  report.valuation = valuation.valuation;
  assert.equal((await application.evaluate(() => globalThis.__priceTrainingSmoke.httpAttempts)).length, 0);
  report.checks.push("Normal item:evaluate-text IPC returns 1 divine from price-training with zero HTTP");
  const evaluateSession = await ipc("evaluate:open", {
    text: raw, source: "item-log", autoSearch: true, showOverlay: false,
  });
  assert.equal(evaluateSession.localEstimate.valuation.fair, 1);
  assert.equal(evaluateSession.localEstimate.valuation.currency, "divine");
  assert.equal(evaluateSession.results, undefined);
  assert.equal((await application.evaluate(() => globalThis.__priceTrainingSmoke.httpAttempts)).length, 0);
  report.checks.push("Evaluate opens the saved price without metadata or automatic trade requests");
  await expect(page.getByRole("heading", { name: "Item log", exact: true })).toBeVisible();
  const itemScreenshot = path.join(output, "smoke-item-log.png");
  await page.screenshot({ path: itemScreenshot, fullPage: true });
  report.screenshots.push(itemScreenshot);
  await page.getByRole("link", { name: "Teach this price", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Price training", exact: true })).toBeVisible();
  await expect(page.locator('[name="itemText"]')).toHaveValue(raw);
  report.checks.push("Item log Teach this price link hands raw text back without a lookup");

  const examples = page.getByRole("region", { name: "Saved examples" });
  await examples.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Price", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Update example", exact: true }).click();
  await expect(learned).toContainText("2 divine");
  const edited = await ipc("price-training:overview");
  assert.equal(edited.lessons.length, 1);
  assert.equal(edited.lessons[0].id, saved.lessons[0].id);
  assert.equal(edited.lessons[0].amount, 2);
  report.checks.push("Editing updates the existing persisted lesson without duplication");
  await examples.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(examples).toContainText("Save your first correction");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Price training", exact: true })).toBeVisible();
  assert.equal((await ipc("price-training:overview")).lessons.length, 0);
  const events = readFileSync(path.join(config, "price-training.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.kind), ["lesson-save", "lesson-save", "lesson-remove"]);
  report.checks.push("Removal survives reload; append-only history preserves edits");

  const state = await application.evaluate(({ app }) => ({ ...globalThis.__priceTrainingSmoke, cwd: process.cwd(), userData: app.getPath("userData") }));
  assert.equal(state.cwd, cwd);
  assert.equal(state.userData, userData);
  assert.equal(state.httpAttempts.length, 0, "no HTTP requests even attempted");
  assert.equal(state.clipboardWrites.length, 0, "real clipboard was never touched");
  assert.deepEqual(pageErrors, [], "no renderer exceptions");
  report.io = state;
  report.checks.push("Zero HTTP attempts; no clipboard writes; config writes remain inside isolated workspace");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (page && !page.isClosed()) {
    const screenshot = path.join(output, "smoke-failure.png");
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    report.screenshots.push(screenshot);
  }
  if (application) report.io = await application.evaluate(() => globalThis.__priceTrainingSmoke).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => undefined);
  report.pageErrors = pageErrors;
  writeFileSync(path.join(output, "smoke-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(output, "smoke-process.log"), logs.join(""));
  console.log(JSON.stringify(report, null, 2));
}
