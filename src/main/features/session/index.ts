/**
 * Feature module "session": Home, character, mapping, the AFK / post-game
 * recap and the death screenshots.
 *
 * It REQUIRES the client-log foundation (there is nothing to show without
 * it) and only GETS the overlay and hotkey services, so the module still
 * registers when those failed — Home then renders with the recap button
 * disabled instead of the whole package disappearing. The lookups are loose
 * (`ctx.get as (id: string) => unknown`) the same way `chatCommandsModule`
 * does it, because those FeatureServiceMap keys live in their own files.
 *
 * No game input, no network: the kill switch and the dry-run switch are
 * irrelevant here and are deliberately not read.
 */
import { pathToFileURL } from "node:url";
import type { ClientLogEvent } from "../../../core/clientLog.js";
import type { ClientLogStatus } from "../../../shared/clientLog.js";
import type { HotkeyBindingView } from "../../../shared/hotkeys.js";
import type { OverlayPanelEvent, OverlayShowOptions, OverlayState } from "../../../shared/overlay.js";
import {
  normalizeSessionSettings,
  sessionSettingsIssues,
  type RecapMode,
  type SessionSettings,
} from "../../../shared/session.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { DeathCapturer, electronDeathCapturerDeps, type DeathCapturerDeps } from "./deathCapture.js";
import { SessionService, type SessionFs, type SessionTimers } from "./service.js";

export const SESSION_SETTINGS_ID = "session";
export const SESSION_POLL_MS = 15_000;

interface ClientLogLike {
  status(): ClientLogStatus;
  recent(kind?: string, limit?: number): ClientLogEvent[];
  on(kind: "*", callback: (event: ClientLogEvent) => void): () => void;
}

interface OverlayLike {
  show(panelId: string, options?: OverlayShowOptions): Promise<void>;
  update(panelId: string, payload: unknown): void;
  hide(panelId: string): void;
  isVisible(panelId: string): boolean;
  state(): OverlayState;
  onPanelEvent(callback: (event: OverlayPanelEvent) => void): () => void;
}

interface HotkeysLike {
  contribute(action: {
    id: string;
    label: string;
    detail?: string;
    group: string;
    defaultAccelerator: string | null;
    run: () => void | Promise<void>;
  }): () => void;
  list(): HotkeyBindingView[];
}

export interface SessionModuleOptions {
  fs?: SessionFs;
  now?: () => Date;
  capturer?: DeathCapturer;
  capturerDeps?: DeathCapturerDeps;
  timers?: SessionTimers;
  pollMs?: number;
  /** Test seam: do not arm the process poll (call `service.tick()` yourself). */
  manualTicks?: boolean;
  openPath?: (target: string) => Promise<string>;
}

function clampLimit(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.round(value)));
}

function asId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, 120) : "";
}

function asMode(raw: unknown): RecapMode {
  return raw === "afk" || raw === "mini" || raw === "full" ? raw : "full";
}

const defaultTimers: SessionTimers = {
  setInterval: (callback, ms) => {
    const handle: { unref?: () => void } = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => {
    const handle: { unref?: () => void } = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSessionModule(options: SessionModuleOptions = {}): FeatureModule {
  return {
    id: "session",
    async register(ctx: FeatureContext) {
      const settings = ctx.settings.namespace<SessionSettings>(
        SESSION_SETTINGS_ID,
        normalizeSessionSettings,
      );
      const issues = sessionSettingsIssues(ctx.settings.snapshot()[SESSION_SETTINGS_ID]);
      if (issues.length > 0) {
        ctx.log({ feature: "session", level: "info", message: "settings sanitized", detail: issues });
      }

      const getService = ctx.get as unknown as (id: string) => unknown;
      const clientLog = getService("clientLog") as ClientLogLike | undefined;
      if (!clientLog) throw new Error('feature "session" requires the clientLog service');
      const overlay = getService("overlay") as OverlayLike | undefined;
      const hotkeys = getService("hotkeys") as HotkeysLike | undefined;

      let capturer = options.capturer;
      if (!capturer) {
        try {
          const deps =
            options.capturerDeps ??
            (await electronDeathCapturerDeps({
              displayBounds: () => {
                const bounds = overlay?.state().display?.bounds;
                return bounds ? { width: bounds.width, height: bounds.height } : undefined;
              },
              allowScreenFallback: () => settings.get().allowScreenFallback,
            }));
          capturer = new DeathCapturer(deps);
        } catch (error) {
          ctx.log({
            feature: "session",
            level: "warn",
            message: "death screenshots are unavailable",
            detail: error instanceof Error ? error.message : error,
          });
        }
      }

      const service = new SessionService({
        userDataDir: ctx.userDataDir,
        configDir: ctx.configDir,
        ...(options.fs ? { fs: options.fs } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.timers ? { timers: options.timers } : {}),
        settings: () => settings.get(),
        clientLog,
        ...(overlay ? { overlay } : {}),
        ...(hotkeys ? { hotkeys } : {}),
        priceFeed: ctx.core.priceFeed,
        marketTrends: ctx.core.marketTrends,
        poeRunning: async () => (await ctx.poeWindows()).length > 0,
        ...(capturer ? { capturer } : {}),
        openPath:
          options.openPath ??
          (async (target) => {
            try {
              return await ctx.openPath(target);
            } catch {
              // Runtimes without openPath: a file URL still opens on Windows.
              await ctx.openExternal(pathToFileURL(target).href);
              return "";
            }
          }),
        emit: (channel, payload) => ctx.emit(channel, payload),
        notify: (title, body) => ctx.notify(title, body),
        log: (level, message, detail) => ctx.log({ feature: "session", level, message, detail }),
      });

      ctx.handle("session:overview", () => service.overview());
      ctx.handle("session:home", () => service.home());
      ctx.handle("session:history", (limit?: unknown) => service.historyList(clampLimit(limit, 50)));
      ctx.handle("session:history-get", (id?: unknown) => service.historyGet(asId(id)));
      ctx.handle("session:history-delete", (id?: unknown) => service.historyDelete(asId(id)));
      ctx.handle("session:end", () => service.endSession("manual"));
      ctx.handle("session:recap-show", (mode?: unknown) => service.showRecap(asMode(mode)));
      ctx.handle("session:deaths", (limit?: unknown) => service.deaths(clampLimit(limit, 50)));
      ctx.handle("session:death-thumbnail", (id?: unknown) => service.deathThumbnail(asId(id)));
      ctx.handle("session:death-open", (id?: unknown) => service.deathOpen(asId(id)));
      ctx.handle("session:death-delete", (id?: unknown) => service.deathDelete(asId(id)));
      ctx.handle("session:deaths-open-folder", () => service.openDeathsFolder());
      ctx.handle("session:capture-now", () => service.captureNow("manual"));

      const stopHotkeys: Array<() => void> = [];
      if (hotkeys) {
        stopHotkeys.push(
          hotkeys.contribute({
            id: "session.recap",
            label: "Show session recap",
            detail: "Opens the recap overlay panel (Escape closes it).",
            group: "Session",
            defaultAccelerator: null,
            // Returned, not voided: HotkeyService.trigger() awaits and logs a
            // failure; swallowing the promise here would hide it instead.
            run: async () => {
              await service.showRecap("full");
            },
          }),
          hotkeys.contribute({
            id: "session.capture",
            label: "Capture a screenshot now",
            detail: "Saves a screenshot of the game to Home → Deaths — the replay-lite substitute.",
            group: "Session",
            defaultAccelerator: null,
            run: async () => {
              await service.captureNow("manual");
            },
          }),
        );
      }

      const stopEvents = clientLog.on("*", (event) => service.handleEvent(event));
      const stopPanel = overlay?.onPanelEvent((event) => {
        if (event.kind === "closed-by-user") service.notePanelClosed(event.panelId);
      });
      const stopSettings = settings.onChange((next) => service.applySettings(next));

      const timers = options.timers ?? defaultTimers;
      const poll = options.manualTicks
        ? undefined
        : timers.setInterval(() => {
            // Same reason as the hotkeys: an unobserved rejection from the
            // poll would be an uncaughtException in the main process.
            service.tick().catch((error: unknown) => {
              ctx.log({ feature: "session", level: "warn", message: "session tick failed", detail: error });
            });
          }, options.pollMs ?? SESSION_POLL_MS);

      return {
        dispose: async () => {
          if (poll) timers.clearInterval(poll);
          stopEvents();
          stopPanel?.();
          stopSettings();
          for (const stop of stopHotkeys) stop();
          await service.dispose();
        },
      };
    },
  };
}

export const sessionModule: FeatureModule = createSessionModule();

export type { SessionService } from "./service.js";
