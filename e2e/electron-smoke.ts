import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";

export type SmokeBuildMode = "public-companion" | "authorized-qa";

export interface ElectronSmokeSession {
  application: ElectronApplication;
  page: Page;
}

const EXECUTABLES: Record<SmokeBuildMode, string> = {
  "public-companion": path.resolve(
    "release",
    "public",
    "win-unpacked",
    "PoE2 Trade Companion.exe",
  ),
  "authorized-qa": path.resolve(
    "release",
    "qa",
    "win-unpacked",
    "PoE2 QA Trade Bot.exe",
  ),
};

function executableFor(mode: SmokeBuildMode): string {
  const override =
    mode === "public-companion"
      ? process.env.POE2_E2E_PUBLIC_EXECUTABLE
      : process.env.POE2_E2E_QA_EXECUTABLE;
  if (override) return path.resolve(override);

  try {
    const manifest = JSON.parse(
      readFileSync(
        path.resolve("artifacts", "playwright", "electron-builds.json"),
        "utf8",
      ),
    ) as Partial<Record<SmokeBuildMode, string>>;
    const packaged = manifest[mode];
    if (packaged && existsSync(packaged)) return packaged;
  } catch {
    // Fall back to the stable legacy location for manually packaged builds.
  }
  return EXECUTABLES[mode];
}

export async function withPackagedElectron(
  mode: SmokeBuildMode,
  testInfo: TestInfo,
  run: (session: ElectronSmokeSession) => Promise<void>,
  options: { cwd?: string; background?: boolean } = {},
): Promise<void> {
  const executablePath = executableFor(mode);
  if (!existsSync(executablePath)) {
    throw new Error(
      `Missing ${mode} unpacked app at ${executablePath}. Run npm run pack:smoke first.`,
    );
  }

  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let failed = false;
  let mainState = "";
  const pageErrors: string[] = [];
  const processOutput: string[] = [];
  const userData = testInfo.outputPath("user-data");
  try {
    application = await electron.launch({
      executablePath,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      args: [
        `--user-data-dir=${userData}`,
        "--disable-gpu",
      ],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
        POE2_BUILD_MODE: mode,
        POE2_QA_OPT_IN: "0",
        POE2_QA_ACK: "0",
        POE2_ENABLE_LIVE_INPUT: "0",
        POE2_SMOKE_BACKGROUND: options.background ? "1" : "0",
        POE2_SMOKE_USER_DATA_DIR: options.background ? userData : "",
        ...(options.background ? {
          POE2_BAG_PERCEPTION_FILE: path.join(userData, "missing-bag-perception.json"),
          POE2_CLIENT_LOG: path.join(userData, "missing-client-log.txt"),
        } : {}),
      },
      timeout: 30_000,
    });
    const child = application.process();
    child.stdout?.on("data", (chunk: Buffer) => {
      processOutput.push(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      processOutput.push(chunk.toString());
    });
    await application.context().tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const earlyExit = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `${mode} Electron exited before opening a window (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
          ),
        );
      });
    });
    page = await Promise.race([application.firstWindow(), earlyExit]);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#app")).toBeVisible();
    if (options.background) {
      const hidden = await application.evaluate(({ app, BrowserWindow, globalShortcut }) => ({
        userData: app.getPath("userData"),
        windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })),
        shortcuts: ["CommandOrControl+Shift+Escape", "CommandOrControl+Shift+F12", "F8", "CommandOrControl+D", "CommandOrControl+Shift+F5", "CommandOrControl+Shift+F4", "CommandOrControl+Shift+F3"].filter(key => globalShortcut.isRegistered(key)),
      }));
      expect(hidden.windows).toEqual([{ visible: false, focused: false, focusable: false }]);
      expect(path.resolve(hidden.userData)).toBe(path.resolve(userData));
      expect(hidden.shortcuts).toEqual([]);
    }

    const appPath = await application.evaluate(({ app }) => app.getAppPath());
    const inputHost = path.join(
      appPath.replace(/app\.asar$/, "app.asar.unpacked"),
      "scripts",
      "win-input-host.ps1",
    );
    expect(
      existsSync(inputHost),
      `${mode} must unpack the Windows input host for calibration and game tools`,
    ).toBe(true);

    await run({ application, page });
    expect(pageErrors, "renderer page errors").toEqual([]);
  } catch (error) {
    failed = true;
    if (application) {
      mainState = await application
        .evaluate(async ({ app, BrowserWindow }) => {
          let sqlite = "not-checked";
          try {
            const { createRequire } = process.getBuiltinModule("node:module");
            const path = process.getBuiltinModule("node:path");
            const require = createRequire(
              path.join(app.getAppPath(), "package.json"),
            );
            const Database = require("better-sqlite3") as new (
              filename: string,
            ) => { close(): void };
            const database = new Database(":memory:");
            database.close();
            sqlite = "ok";
          } catch (reason) {
            sqlite =
              reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
          }
          return {
            ready: app.isReady(),
            userData: app.getPath("userData"),
            windowCount: BrowserWindow.getAllWindows().length,
            sqlite,
          };
        })
        .then((state) => JSON.stringify(state))
        .catch((reason) => `unavailable: ${String(reason)}`);
    }
    if (page && !page.isClosed()) {
      await page
        .screenshot({
          path: testInfo.outputPath("failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = processOutput.join("").trim();
    throw new Error(
      [
        message,
        `Electron main state: ${mainState || "unavailable"}`,
        diagnostics ? `Electron process output:\n${diagnostics}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  } finally {
    if (application) {
      await application
        .context()
        .tracing.stop(
          failed ? { path: testInfo.outputPath("trace.zip") } : undefined,
        )
        .catch(() => undefined);
      await application.close().catch(() => undefined);
    }
  }
}

export async function navigatePrimary(
  page: Page,
  label: string,
  heading: string,
  route: string,
): Promise<void> {
  const rail = page.locator("aside.side-rail");
  await expect(rail).toBeVisible();
  const control = rail.getByRole("link", {
    name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  });
  await expect(control).toHaveCount(1);
  await control.click();
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`#${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
}
