/**
 * Feature module "stashTracker": snapshots, history, compare, session gains
 * and the in-stash price overlay (`Alt+P`).
 *
 * Reads the sorter's ledger and the grid calibration; writes only its own
 * `<userData>/stash-tracker/` files. The single game-facing call is the
 * passive `{ op: "rect" }` probe in hostProbe.ts, on a user gesture only.
 * No network, no keystrokes, no clicks.
 *
 * Electron is resolved lazily (the label window factory) exactly like the
 * overlay module, so this file imports cleanly under plain Node and the
 * tests inject fakes through `createStashTrackerModule(deps)`.
 */
import {
  normalizeStashTrackerSettings,
  type StashTrackerSettings,
  type StashTrackerSettingsPatch,
} from "../../../shared/stashTracker.js";
import type { OverlayPanelEvent } from "../../../shared/overlay.js";
import { starterPriceTable } from "../../../core/priceTable.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { probePoeClient, type ClientProbe } from "./hostProbe.js";
import {
  PriceLabelWindow,
  electronLabelWindowFactory,
  type LabelScreenLike,
  type LabelWindowLike,
  type LabelWindowPort,
} from "./labelWindow.js";
import {
  StashTrackerService,
  type TrackerFs,
  type TrackerTimers,
} from "./service.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    stashTracker: StashTrackerService;
  }
}

export interface StashTrackerModuleDeps {
  createLabelWindow?: () => LabelWindowLike;
  screen?: LabelScreenLike;
  probeClient?: () => Promise<ClientProbe>;
  otherHostRunning?: () => Promise<boolean>;
  labelWindow?: LabelWindowPort;
  fs?: TrackerFs;
  timers?: TrackerTimers;
  pollMs?: number;
  settleMs?: number;
  sessionId?: string;
  now?: () => Date;
  manualTicks?: boolean;
}

async function electronScreen(): Promise<LabelScreenLike> {
  const { screen } = await import("electron");
  return screen as unknown as LabelScreenLike;
}

/**
 * Lazy so the win-host module (and PowerShell) is only reached when the
 * probe would actually run next to another host.
 */
async function otherHostRunningDefault(): Promise<boolean> {
  try {
    const { defaultOtherHostRunning } = await import("../../chatCommandService.js");
    return await defaultOtherHostRunning();
  } catch {
    return false;
  }
}

async function poeRunning(ctx: FeatureContext): Promise<boolean> {
  try {
    return (await ctx.poeWindows()).length > 0;
  } catch {
    return false;
  }
}

export function createStashTrackerModule(deps: StashTrackerModuleDeps = {}): FeatureModule {
  return {
    id: "stashTracker",
    async register(ctx) {
      const settings = ctx.settings.namespace<StashTrackerSettings>(
        "stash-tracker",
        normalizeStashTrackerSettings,
      );
      const screen = deps.screen ?? (deps.labelWindow ? undefined : await electronScreen());
      const labelWindow: LabelWindowPort =
        deps.labelWindow ??
        new PriceLabelWindow({
          createWindow: deps.createLabelWindow ?? (await electronLabelWindowFactory()),
          screen: screen!,
          log: (level, message, detail) =>
            ctx.log({ feature: "stashTracker", level, message, detail }),
        });
      const service = new StashTrackerService({
        configDir: ctx.configDir,
        userDataDir: ctx.userDataDir,
        repoRoot: ctx.repoRoot,
        sessionId: deps.sessionId ?? `s-${Date.now().toString(36)}`,
        getPriceTable: () => {
          try {
            return ctx.core.itemIntelligence.getPriceTable();
          } catch {
            return starterPriceTable();
          }
        },
        settings,
        overlay: ctx.require("overlay"),
        labelWindow,
        probeClient: deps.probeClient ?? (() => probePoeClient()),
        otherHostRunning: deps.otherHostRunning ?? otherHostRunningDefault,
        poeRunning: () => poeRunning(ctx),
        killSwitchLatched: () => ctx.killSwitchLatched(),
        dryRun: () => ctx.dryRun(),
        emit: (channel, payload) => ctx.emit(channel, payload),
        log: (level, message, detail) =>
          ctx.log({ feature: "stashTracker", level, message, detail }),
        ...(deps.fs ? { fs: deps.fs } : {}),
        ...(deps.timers ? { timers: deps.timers } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
        ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
        ...(deps.manualTicks !== undefined ? { manualTicks: deps.manualTicks } : {}),
      });
      ctx.provide("stashTracker", service);

      const text = (value: unknown): string => String(value ?? "");
      const optionalText = (value: unknown): string | undefined =>
        typeof value === "string" ? value : undefined;

      ctx.handle("stash-tracker:overview", () => service.overview());
      ctx.handle("stash-tracker:current", () => service.current());
      ctx.handle("stash-tracker:snapshot", (label?: unknown) =>
        service.snapshot(optionalText(label)),
      );
      ctx.handle("stash-tracker:snapshot-get", (id: unknown) => service.get(text(id)));
      ctx.handle("stash-tracker:rename", (id: unknown, label: unknown) =>
        service.rename(text(id), text(label)),
      );
      ctx.handle("stash-tracker:delete", (id: unknown) => service.remove(text(id)));
      ctx.handle("stash-tracker:compare", (fromId: unknown, toId: unknown) =>
        service.compare(text(fromId), text(toId)),
      );
      ctx.handle("stash-tracker:session-start", () => service.startSession());
      ctx.handle("stash-tracker:session-gains", () => service.sessionGains());
      ctx.handle("stash-tracker:exclude", (fingerprint: unknown, excluded: unknown) =>
        service.setExcluded(text(fingerprint), Boolean(excluded)),
      );
      ctx.handle("stash-tracker:configure", (patch: unknown) =>
        service.configure(
          typeof patch === "object" && patch !== null
            ? (patch as StashTrackerSettingsPatch)
            : {},
        ),
      );
      ctx.handle("stash-tracker:overlay-toggle", (tab?: unknown) =>
        service.overlayToggle(optionalText(tab)),
      );
      ctx.handle("stash-tracker:overlay-show", (tab?: unknown) =>
        service.overlayShow(optionalText(tab)),
      );
      ctx.handle("stash-tracker:overlay-hide", () => service.overlayHide());
      ctx.handle("stash-tracker:overlay-next", (direction: unknown) =>
        service.overlayNext(direction === -1 ? -1 : 1),
      );
      ctx.handle("stash-tracker:overlay-top-level", (tab: unknown, topLevel: unknown) =>
        service.overlaySetTopLevel(text(tab), Boolean(topLevel)),
      );
      ctx.handle("stash-tracker:overlay-status", () => service.overlayStatus());

      const hotkeys = ctx.require("hotkeys");
      /** A hotkey's promise has nobody to reject to: log it, never leak it. */
      const swallow =
        (message: string) =>
        (error: unknown): void => {
          ctx.log({ feature: "stashTracker", level: "warn", message, detail: error });
        };
      const stopHotkeys = [
        hotkeys.contribute({
          id: "stash-tracker.overlay-toggle",
          label: "Stash prices overlay",
          detail:
            "Labels the open stash tab with the ledger's latest price estimates; press again to hide. Reads the game window position only — it sends no input.",
          group: "Overlay",
          defaultAccelerator: "Alt+P",
          run: () => {
            service.overlayToggle().catch(swallow("overlay toggle hotkey failed"));
          },
        }),
        hotkeys.contribute({
          id: "stash-tracker.overlay-next-tab",
          label: "Stash prices: next tab",
          detail: "Cycles which tab the price overlay labels (unbound by default).",
          group: "Overlay",
          defaultAccelerator: null,
          run: () => {
            service.overlayNext(1).catch(swallow("overlay next-tab hotkey failed"));
          },
        }),
        hotkeys.contribute({
          id: "stash-tracker.snapshot",
          label: "Take a stash snapshot",
          detail: "Saves the current ledger worth as an unnamed snapshot.",
          group: "Stash tracker",
          defaultAccelerator: null,
          run: () => {
            try {
              service.snapshot();
            } catch (error) {
              ctx.log({
                feature: "stashTracker",
                level: "warn",
                message: "snapshot hotkey failed",
                detail: error,
              });
            }
          },
        }),
      ];
      const stopPanelEvents = ctx
        .require("overlay")
        .onPanelEvent((event: OverlayPanelEvent) => service.onPanelEvent(event));

      service.start();

      return {
        dispose: () => {
          for (const stop of stopHotkeys) stop();
          stopPanelEvents();
          service.dispose();
        },
      };
    },
  };
}

export const stashTrackerModule: FeatureModule = createStashTrackerModule();
