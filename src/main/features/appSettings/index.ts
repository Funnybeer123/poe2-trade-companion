/**
 * Feature module "appSettings": the `app:*` channels behind Tools → Settings
 * (version and paths, the changelog, the first-run checklist, the
 * administrator-rights hint, the overlay test and the window options).
 *
 * SAFETY, in one place:
 * - It sends NO game input. No input host, no host ops, no `GameInputController`.
 *   The only "action" it takes in the game's direction is showing the
 *   foundation's passive `notice` overlay panel as an overlay test.
 * - It opens NO network connection. The two network-ish buttons in the UI go
 *   through the existing, throttled `PriceFeedService.leagues()/refresh()`.
 * - It stores NO secret. `normalizeAppSettings` drops unknown keys and
 *   `app:reset-settings` refuses every namespace but `app` and `overlay`.
 * - The only PowerShell it runs is the fixed probe script and the UAC
 *   relaunch command, both built in `src/core/appSettingsElevation.ts`.
 * - Neither runs on its own. `app:elevation` enumerates `PathOfExile*`
 *   processes and attempts ONE handle open (never reading memory, never
 *   writing) only when the user presses "Check administrator rights", and is
 *   refused outright in `public-companion`; `app:relaunch-elevated` needs the
 *   disclosure, a confirming second click and the user's own UAC consent.
 *   Opening the Settings page starts no process.
 *
 * Electron is resolved lazily inside `register()` (the clientLog/hotkeys
 * precedent) so the module file stays importable under plain Node and the
 * tests can inject every seam.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { deriveSetupChecklist, type ChecklistInput } from "../../../core/appSettingsChecklist.js";
import { relaunchElevatedCommand } from "../../../core/appSettingsElevation.js";
import type { DisplayArea } from "../../../core/appSettingsWindow.js";
import { loadProfile } from "../../../core/calibrationStore.js";
import { resolveStashGrids } from "../../../core/calibrationProfile.js";
import {
  APP_SETTINGS_ID,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppInfo,
  type AppSettings,
  type ChangelogPayload,
  type ElevationReport,
  type OpenFolderResult,
  type ResetWindowsResult,
  type ResettableNamespace,
  type SetupChecklist,
} from "../../../shared/appSettings.js";
import {
  DEFAULT_OVERLAY_SETTINGS,
  normalizeOverlaySettings,
  type NoticePayload,
} from "../../../shared/overlay.js";
import { hotkeyBindingsFilePath } from "../../hotkeyService.js";
import type { FeatureModule } from "../types.js";
import { ElevationProbe, type ElevationExec } from "./elevationProbe.js";
import {
  MainWindowTracker,
  DEFAULT_GAME_START_POLL_MS,
  type MainWindowLike,
  type TrackerTimers,
} from "./windowBounds.js";

/** Biggest CHANGELOG.md we hand to the renderer, in UTF-16 characters. */
export const MAX_CHANGELOG_CHARS = 512 * 1024;
export const DEFAULT_ELEVATION_TTL_MS = 30_000;
/** How long after "Test overlay" a `notice` panel counts as the test itself. */
export const OVERLAY_TEST_WINDOW_MS = 10_000;

export interface AppSettingsFs {
  readText(file: string, maxChars?: number): string | undefined;
}

export interface AppSettingsElectron {
  app?: { getVersion(): string; isPackaged: boolean; quit(): void };
  screen?: {
    getAllDisplays(): Array<{ workArea: DisplayArea }>;
    getPrimaryDisplay(): { workArea: DisplayArea };
  };
}

export interface ProcessInfo {
  execPath: string;
  argv: string[];
  versions: Record<string, string | undefined>;
  platform: string;
  arch: string;
}

export interface AppSettingsModuleDeps {
  exec?: ElevationExec;
  fs?: AppSettingsFs;
  electron?: AppSettingsElectron;
  /** Defaults to running the command through powershell.exe. */
  relaunch?: (command: string) => Promise<{ ok: boolean; error?: string }>;
  processInfo?: () => ProcessInfo;
  now?: () => Date;
  timers?: TrackerTimers;
  elevationTtlMs?: number;
  gameStartPollMs?: number;
}

const realFs: AppSettingsFs = {
  readText: (file, maxChars) => {
    try {
      if (!existsSync(file)) return undefined;
      const raw = readFileSync(file, "utf8");
      // A UTF-8 BOM survives `readFileSync(…, "utf8")` and would sit in front
      // of the first `## [x.y.z]` heading, hiding that release from the parser.
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      return maxChars !== undefined && text.length > maxChars ? text.slice(0, maxChars) : text;
    } catch {
      return undefined;
    }
  },
};

/** Default exec seam: one child process, never a shell string. */
const realExec: ElevationExec = async (file, args, opts) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: opts?.timeoutMs ?? 8_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? Number((error as { code?: unknown }).code)
          : error
            ? 1
            : 0;
        // `killed` separates "we gave up waiting" from "the command failed";
        // the relaunch turns it into a sentence about the UAC prompt.
        const killed = Boolean(error && (error as { killed?: unknown }).killed === true);
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code, killed });
      },
    );
    child.on("error", () => resolve({ stdout: "", stderr: "powershell could not be started", code: 1 }));
  });
};

/** Structural view of the services the checklist reads loosely. */
interface ClientLogLike {
  status(): {
    file?: string;
    source: string;
    watching: boolean;
    error?: string;
  };
}
interface ChatCommandsLike {
  status(): { enabled: boolean; dryRun: boolean };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function createAppSettingsModule(deps: AppSettingsModuleDeps = {}): FeatureModule {
  return {
    id: "appSettings",
    async register(ctx) {
      const now = deps.now ?? (() => new Date());
      const fs = deps.fs ?? realFs;
      const exec = deps.exec ?? realExec;
      const processInfo = deps.processInfo ?? (() => ({
        execPath: process.execPath,
        argv: [...process.argv],
        versions: process.versions as unknown as Record<string, string | undefined>,
        platform: process.platform,
        arch: process.arch,
      }));

      const electron: AppSettingsElectron = deps.electron ?? (await loadElectron());
      const electronApp = electron.app;
      const screen = electron.screen;

      const settings = ctx.settings.namespace<AppSettings>(APP_SETTINGS_ID, normalizeAppSettings);
      const overlay = ctx.require("overlay");
      const hotkeys = ctx.require("hotkeys");
      // Looked up loosely and per call: a foundation that failed to register
      // must degrade one checklist step, not take this module down with it.
      const getService = ctx.get as unknown as (id: string) => unknown;
      const clientLog = (): ClientLogLike | undefined => getService("clientLog") as ClientLogLike | undefined;
      const chatCommands = (): ChatCommandsLike | undefined =>
        getService("chatCommands") as ChatCommandsLike | undefined;

      const log = (level: "info" | "warn" | "error", message: string, detail?: unknown): void =>
        ctx.log({ feature: "appSettings", level, message, detail });

      const probe = new ElevationProbe({
        exec,
        now,
        ttlMs: deps.elevationTtlMs ?? DEFAULT_ELEVATION_TTL_MS,
        log,
      });

      const displays = (): DisplayArea[] => {
        try {
          return (screen?.getAllDisplays() ?? []).map((display) => ({ ...display.workArea }));
        } catch {
          return [];
        }
      };
      const primary = (): DisplayArea => {
        try {
          const area = screen?.getPrimaryDisplay().workArea;
          if (area) return { ...area };
        } catch {
          // Fall through to a harmless default.
        }
        return { x: 0, y: 0, width: 1920, height: 1080 };
      };

      const tracker = new MainWindowTracker({
        getWindow: () => ctx.mainWindow() as unknown as MainWindowLike | undefined,
        settings,
        displays,
        primary,
        poeRunning: async () => (await ctx.poeWindows()).length > 0,
        timers: deps.timers,
        gameStartPollMs: deps.gameStartPollMs ?? DEFAULT_GAME_START_POLL_MS,
        log,
      });
      tracker.start();

      const changelogFile = path.join(ctx.appPath, "CHANGELOG.md");

      // ---------------------------------------------------------------
      // Checklist
      // ---------------------------------------------------------------
      const buildChecklist = async (): Promise<SetupChecklist> => {
        const current = settings.get();
        // `probe.last()` never launches PowerShell — the checklist reads the
        // cached verdict and leaves the step "unknown" until something probes.
        const elevation = probe.last();
        const chat = chatStatus();
        const input: ChecklistInput = {
          now: now().toISOString(),
          poeRunning: await safe(async () => (await ctx.poeWindows()).length > 0, false),
          clientLog: readClientLog(),
          feed: await readFeed(),
          hotkeys: readHotkeys(),
          overlay: readOverlay(),
          ...(elevation ? { elevation: elevationInput(elevation) } : {}),
          calibration: readCalibration(),
          ...(chat ? { chatCommands: chat } : {}),
          ...(current.setup.dismissedAt ? { dismissedAt: current.setup.dismissedAt } : {}),
        };
        return deriveSetupChecklist(input);
      };

      async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
        try {
          return await read();
        } catch (error) {
          log("warn", "checklist input failed", describe(error));
          return fallback;
        }
      }

      function readClientLog(): ChecklistInput["clientLog"] {
        try {
          const status = clientLog()?.status();
          if (!status) return { watching: false, source: "none" };
          return {
            watching: status.watching,
            source: status.source,
            ...(status.file ? { file: status.file } : {}),
            ...(status.error ? { error: status.error } : {}),
          };
        } catch (error) {
          return { watching: false, source: "none", error: describe(error) };
        }
      }

      async function readFeed(): Promise<ChecklistInput["feed"]> {
        try {
          const status = await ctx.core.priceFeed.status();
          return {
            ...(status.resolvedLeague ? { resolvedLeague: status.resolvedLeague } : {}),
            leagueAmbiguous: status.leagueAmbiguous,
            candidates: status.leagueCandidates.length,
            ...(status.lastError ? { lastError: status.lastError } : {}),
            feedEntryCount: status.feedEntryCount,
            ...(status.feedAgeHours === undefined ? {} : { feedAgeHours: status.feedAgeHours }),
            hasSession: ctx.core.priceFeed.hasSession(),
          };
        } catch (error) {
          return {
            leagueAmbiguous: false,
            candidates: 0,
            lastError: describe(error),
            feedEntryCount: 0,
            hasSession: false,
          };
        }
      }

      function readHotkeys(): ChecklistInput["hotkeys"] {
        try {
          const bindings = hotkeys.list();
          return {
            total: bindings.length,
            errors: bindings
              .filter((binding) => Boolean(binding.error))
              .map((binding) => ({ id: binding.id, label: binding.label, error: binding.error ?? "" })),
          };
        } catch {
          return { total: 0, errors: [] };
        }
      }

      function readOverlay(): ChecklistInput["overlay"] {
        const testedAt = settings.get().setup.overlayTestedAt;
        try {
          return { ...(testedAt ? { testedAt } : {}), windowVisible: overlay.state().windowVisible };
        } catch {
          return { ...(testedAt ? { testedAt } : {}), windowVisible: false };
        }
      }

      function elevationInput(report: ElevationReport): NonNullable<ChecklistInput["elevation"]> {
        return {
          ...(report.hint ? { hint: report.hint } : {}),
          verdict: report.poeElevated,
          appElevated: report.appElevated,
        };
      }

      function readCalibration(): ChecklistInput["calibration"] {
        try {
          const profile = loadProfile(path.join(ctx.userDataDir, "perception-templates"));
          const grids = resolveStashGrids(profile);
          return {
            hasStashGrid: Boolean(grids.normal ?? grids.quad),
            hasBagGrid: Boolean(profile.bagGrid),
            hasSearchBox: Boolean(profile.stashSearch),
          };
        } catch {
          return { hasStashGrid: false, hasBagGrid: false, hasSearchBox: false };
        }
      }

      function chatStatus(): { enabled: boolean; dryRun: boolean } | undefined {
        try {
          const status = chatCommands()?.status();
          return status ? { enabled: status.enabled, dryRun: status.dryRun } : undefined;
        } catch {
          return undefined;
        }
      }

      const announceChecklist = async (): Promise<SetupChecklist> => {
        const checklist = await buildChecklist();
        ctx.emit("app:checklist-changed", checklist);
        return checklist;
      };

      // ---------------------------------------------------------------
      // Overlay test: only the notice WE asked for stamps "tested".
      // ---------------------------------------------------------------
      let testPendingUntil = 0;
      const stopPanelEvents = overlay.onPanelEvent((event) => {
        if (event.panelId !== "notice" || event.kind !== "shown") return;
        if (now().getTime() >= testPendingUntil) return;
        testPendingUntil = 0;
        settings.set((current) => ({
          ...current,
          setup: { ...current.setup, overlayTestedAt: now().toISOString() },
        }));
        void announceChecklist();
      });

      // ---------------------------------------------------------------
      // Channels
      // ---------------------------------------------------------------
      ctx.handle("app:info", (): AppInfo => {
        const info = processInfo();
        return {
          version: electronApp?.getVersion() ?? "0.0.0",
          buildMode: ctx.buildMode,
          packaged: electronApp?.isPackaged ?? false,
          electron: info.versions.electron ?? "",
          node: info.versions.node ?? "",
          chrome: info.versions.chrome ?? "",
          platform: info.platform,
          arch: info.arch,
          userDataDir: ctx.userDataDir,
          configDir: ctx.configDir,
          appPath: ctx.appPath,
          settingsFile: ctx.settings.path,
          hotkeysFile: hotkeyBindingsFilePath(ctx.userDataDir),
          changelogFile,
        };
      });

      ctx.handle("app:changelog", (): ChangelogPayload => {
        const markdown = fs.readText(changelogFile, MAX_CHANGELOG_CHARS);
        return markdown === undefined
          ? { markdown: "", source: changelogFile, missing: true }
          : { markdown, source: changelogFile, missing: false };
      });

      ctx.handle("app:setup-checklist", () => buildChecklist());

      ctx.handle("app:dismiss-checklist", async (dismissed: boolean) => {
        settings.set((current) => {
          const { dismissedAt: _previous, ...setup } = current.setup;
          return {
            ...current,
            setup: dismissed ? { ...setup, dismissedAt: now().toISOString() } : setup,
          };
        });
        return announceChecklist();
      });

      let lastVerdict = "";
      ctx.handle("app:elevation", async (force?: boolean): Promise<ElevationReport> => {
        // User-initiated only, and never in the public build: the probe opens
        // a handle on the live game client, which nobody who cannot drive the
        // game has a reason to ask for. The UI hides the button there; this is
        // the gate that makes it true.
        if (ctx.buildMode === "public-companion") {
          throw new Error("The administrator-rights check is not available in this build.");
        }
        const report = await probe.report(force === true);
        const verdict = `${String(report.appElevated)}/${report.poeElevated}`;
        if (verdict !== lastVerdict) {
          lastVerdict = verdict;
          ctx.emit("app:elevation-changed", report);
        }
        return report;
      });

      ctx.handle("app:relaunch-elevated", async (): Promise<{ ok: boolean; error?: string }> => {
        // No game-driving path exists in the public build, so there is
        // nothing for UIPI to unblock — refuse rather than raise a UAC prompt.
        if (ctx.buildMode === "public-companion") return { ok: false, error: "public-companion" };
        const known = probe.last() ?? (await probe.report(false));
        if (known.appElevated === true) return { ok: false, error: "already-elevated" };
        const info = processInfo();
        // Both builds carry their mode in the bundle (Vite's
        // `__POE2_BUILD_MODE__` define), so the env prefix is belt-and-braces —
        // AppInfo builds a fresh environment for the elevated child.
        //
        // What DOES have to be explicit is the app path: a packaged exe needs
        // no argument, while the dev path is `electron .`, and the elevation
        // broker carries neither the caller's cwd nor a relative ".". Pass the
        // absolute app directory as the argument AND as -WorkingDirectory.
        // Packaged: no -WorkingDirectory — `ctx.appPath` is inside app.asar,
        // which `Start-Process` cannot chdir into.
        const packaged = electronApp?.isPackaged ?? false;
        const args = packaged ? [] : [ctx.appPath, ...info.argv.slice(2)];
        const command = relaunchElevatedCommand(
          info.execPath,
          args,
          { POE2_BUILD_MODE: ctx.buildMode },
          packaged ? {} : { workingDirectory: ctx.appPath },
        );
        const run =
          deps.relaunch ??
          (async (text: string) => {
            const result = await exec(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", text],
              // Generous on purpose: the child lives until the user answers
              // the UAC prompt, and reading it can easily take a minute.
              { timeoutMs: 300_000 },
            );
            const stderr = (result.stderr ?? "").trim();
            if (result.killed === true) {
              return { ok: false, error: "the Windows prompt was not answered" };
            }
            if (result.code !== 0 || stderr) {
              return { ok: false, error: stderr || `powershell exited with ${result.code}` };
            }
            return { ok: true };
          });
        let outcome: { ok: boolean; error?: string };
        try {
          outcome = await run(command);
        } catch (error) {
          outcome = { ok: false, error: describe(error) };
        }
        if (!outcome.ok) {
          log("warn", "elevated relaunch refused", outcome.error);
          return outcome;
        }
        // Give the reply time to reach the renderer before we go away.
        const timers = deps.timers;
        const quit = (): void => {
          try {
            electronApp?.quit();
          } catch (error) {
            log("warn", "quit after elevated relaunch failed", describe(error));
          }
        };
        if (timers) timers.setTimeout(quit, 250);
        else setTimeout(quit, 250);
        return outcome;
      });

      ctx.handle("app:reset-windows", async (): Promise<ResetWindowsResult> => {
        let overlayPanelsHidden = 0;
        try {
          overlayPanelsHidden = overlay.state().visiblePanels.length;
          // `true` = pinned panels too: a panel parked off-screen is exactly
          // what this button exists to recover from.
          overlay.hideAll(true);
        } catch (error) {
          log("warn", "could not hide the overlay panels", describe(error));
        }
        const mainWindow = tracker.reset();
        void announceChecklist();
        return { mainWindow, overlayPanelsHidden };
      });

      ctx.handle("app:test-overlay", async (): Promise<void> => {
        testPendingUntil = now().getTime() + OVERLAY_TEST_WINDOW_MS;
        const payload: NoticePayload = {
          title: "Overlay test",
          body: "Panels appear on this display. Escape closes them.",
          tone: "info",
          ttlMs: 4_000,
        };
        try {
          await overlay.show("notice", { anchor: "top-right", payload });
        } catch (error) {
          testPendingUntil = 0;
          throw new Error(`The overlay test panel could not be shown: ${describe(error)}`, { cause: error });
        }
      });

      ctx.handle("app:open-folder", async (which: string): Promise<OpenFolderResult> => {
        // Only ever these two directories — never a caller-supplied path.
        const target =
          which === "configDir"
            ? ctx.configDir
            : which === "userData" || which === "settingsFile"
              ? ctx.userDataDir
              : undefined;
        if (target === undefined) return { ok: false, error: "unknown-folder" };
        const error = await ctx.openPath(target);
        return error === "" ? { ok: true } : { ok: false, error };
      });

      ctx.handle("app:reset-settings", async (namespaces: ResettableNamespace[]) => {
        const list = Array.isArray(namespaces) ? namespaces : [];
        // Validate the WHOLE list first: a mixed list must reset nothing, not
        // wipe the ids it recognised and then report failure.
        for (const id of list) {
          if (id !== "app" && id !== "overlay") {
            throw new Error(`unknown or protected namespace "${String(id)}"`);
          }
        }
        for (const id of list) {
          if (id === "app") {
            settings.set(() => ({
              window: { ...DEFAULT_APP_SETTINGS.window },
              setup: {},
              changelog: { ...DEFAULT_APP_SETTINGS.changelog },
            }));
            tracker.applyAlwaysOnTop();
          } else {
            // `namespace()` returns the already-registered entry, so the
            // overlay module's own onChange → applySettings() still fires.
            ctx.settings
              .namespace("overlay", normalizeOverlaySettings)
              .set(() => ({ ...DEFAULT_OVERLAY_SETTINGS }));
          }
        }
        void announceChecklist();
        return ctx.settings.snapshot();
      });

      // ---------------------------------------------------------------
      // Hotkeys — one action, and it only touches our own window.
      // ---------------------------------------------------------------
      const unContribute = hotkeys.contribute({
        id: "app.show-window",
        label: "Bring the companion window to front",
        detail:
          "Restores and focuses the desktop window on its current page (the overlay stays where it is).",
        group: "Desktop",
        defaultAccelerator: null,
        run: () => tracker.showAndFocus(),
      });

      return {
        dispose: () => {
          unContribute();
          stopPanelEvents();
          tracker.dispose();
        },
      };
    },
  };
}

/** Lazy so the module file stays importable (and testable) under plain Node. */
async function loadElectron(): Promise<AppSettingsElectron> {
  const { app, screen } = await import("electron");
  return { app, screen };
}

export const appSettingsModule: FeatureModule = createAppSettingsModule();
