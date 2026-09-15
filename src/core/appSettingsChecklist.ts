/**
 * First-run checklist derivation (pure).
 *
 * ONE source of truth: main gathers the inputs from the foundations and
 * `deriveSetupChecklist` turns them into the step list that both the Settings
 * card and the Home page render. A foundation read that failed arrives as
 * `undefined`/`unknown` rather than throwing, so a broken service degrades one
 * step to "unknown" instead of taking the whole card down.
 *
 * The returned shape is FROZEN (see src/shared/appSettings.ts): Home declares
 * a structural subset of it, so field names and the `action` strings are part
 * of the cross-package contract.
 */
import type { SetupChecklist, SetupStep, SetupStepState } from "../shared/appSettings.js";

/**
 * Same value as `src/renderer/utils/readiness.ts` FEED_STALE_AFTER_HOURS —
 * core cannot import the renderer, so both copies are allowed and must stay
 * in step (conflicts judge §3 #20).
 */
export const FEED_STALE_AFTER_HOURS = 36;

export interface ChecklistInput {
  now: string;
  poeRunning: boolean;
  clientLog: { watching: boolean; source: string; file?: string; error?: string };
  feed: {
    resolvedLeague?: string;
    leagueAmbiguous: boolean;
    candidates: number;
    lastError?: string;
    feedEntryCount: number;
    feedAgeHours?: number;
    hasSession: boolean;
  };
  hotkeys: { total: number; errors: Array<{ id: string; label: string; error: string }> };
  overlay: { testedAt?: string; windowVisible: boolean };
  elevation?: { hint?: string; verdict: string; appElevated: boolean | "unknown" };
  calibration: { hasStashGrid: boolean; hasBagGrid: boolean; hasSearchBox: boolean };
  chatCommands?: { enabled: boolean; dryRun: boolean };
  dismissedAt?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Sep 09:58" — short enough for a one-line step detail. */
export function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? "?"} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function gameStep(input: ChecklistInput): SetupStep {
  return {
    id: "game-detected",
    label: "Game detected",
    state: input.poeRunning ? "ok" : "optional",
    detail: input.poeRunning
      ? "Path of Exile 2 is running"
      : "Start the game — most steps verify against it",
    optional: true,
  };
}

function clientLogStep(input: ChecklistInput): SetupStep {
  const { watching, source, file, error } = input.clientLog;
  const state: SetupStepState = watching && !error ? "ok" : error ? "warn" : "todo";
  const detail =
    state === "ok"
      ? `${source}: ${file ?? "(unnamed file)"}`
      : error
        ? error
        : "Client.txt not found yet — point the app at it with Browse…";
  return { id: "client-log", label: "Client.txt", state, detail, optional: false, action: "browse-log" };
}

function leagueStep(input: ChecklistInput): SetupStep {
  const { leagueAmbiguous, resolvedLeague, candidates, lastError } = input.feed;
  if (leagueAmbiguous) {
    return {
      id: "league",
      label: "Pricing league",
      state: "warn",
      detail: `${plural(candidates, "current league")} — pick one under Market data`,
      optional: false,
      action: "open-market-data",
    };
  }
  if (resolvedLeague) {
    return { id: "league", label: "Pricing league", state: "ok", detail: resolvedLeague, optional: false };
  }
  return {
    id: "league",
    label: "Pricing league",
    state: "todo",
    detail: lastError ?? "Not resolved yet",
    optional: false,
    action: "check-leagues",
  };
}

function feedStep(input: ChecklistInput): SetupStep {
  const { feedEntryCount, feedAgeHours } = input.feed;
  const age = feedAgeHours === undefined ? undefined : `${Math.round(feedAgeHours)} h old`;
  if (feedEntryCount > 0 && (feedAgeHours === undefined || feedAgeHours <= FEED_STALE_AFTER_HOURS)) {
    return {
      id: "price-feed",
      label: "Market prices",
      state: "ok",
      detail: `${plural(feedEntryCount, "feed price")}${age ? ` · ${age}` : ""}`,
      optional: false,
    };
  }
  if (feedEntryCount > 0) {
    return {
      id: "price-feed",
      label: "Market prices",
      state: "warn",
      detail: `${plural(feedEntryCount, "feed price")}${age ? ` · ${age}` : ""} — refresh`,
      optional: false,
      action: "refresh-feed",
    };
  }
  return {
    id: "price-feed",
    label: "Market prices",
    state: "todo",
    detail: "No prices yet — refresh the market feed once",
    optional: false,
    action: "refresh-feed",
  };
}

function cookieStep(input: ChecklistInput): SetupStep {
  return {
    id: "session-cookie",
    label: "PoE session cookie",
    state: input.feed.hasSession ? "ok" : "optional",
    detail: input.feed.hasSession
      ? "POESESSID saved"
      : "Optional — live search and bulk exchange need it",
    optional: true,
    ...(input.feed.hasSession ? {} : { action: "open-market-data" as const }),
  };
}

function hotkeyStep(input: ChecklistInput): SetupStep {
  const { total, errors } = input.hotkeys;
  if (errors.length > 0) {
    const listed = errors.map((entry) => `${entry.label} (${entry.error})`).join("; ");
    return {
      id: "hotkeys",
      label: "Hotkeys",
      state: "warn",
      detail: `${errors.length} not active: ${listed}`,
      optional: false,
      action: "open-hotkeys",
    };
  }
  if (total > 0) {
    return {
      id: "hotkeys",
      label: "Hotkeys",
      state: "ok",
      detail: `${plural(total, "shortcut")} active`,
      optional: false,
      action: "open-hotkeys",
    };
  }
  return {
    id: "hotkeys",
    label: "Hotkeys",
    state: "unknown",
    detail: "No hotkey actions registered yet",
    optional: false,
    action: "open-hotkeys",
  };
}

function overlayStep(input: ChecklistInput): SetupStep {
  const testedAt = input.overlay.testedAt;
  return testedAt
    ? {
        id: "overlay",
        label: "Overlay",
        state: "ok",
        detail: `Tested ${formatStamp(testedAt)}`,
        optional: false,
        action: "test-overlay",
      }
    : {
        id: "overlay",
        label: "Overlay",
        state: "todo",
        detail: "Press Test overlay once so you know where panels appear",
        optional: false,
        action: "test-overlay",
      };
}

function adminStep(input: ChecklistInput): SetupStep {
  const elevation = input.elevation;
  let state: SetupStepState = "unknown";
  let detail = "Not checked yet";
  if (elevation) {
    if (elevation.hint) {
      state = "warn";
      detail = elevation.hint;
    } else if (elevation.appElevated === true) {
      state = "ok";
      detail = "Companion runs elevated — nothing to warn about";
    } else if (elevation.verdict === "unknown") {
      state = "unknown";
      detail = "Could not tell — the check is a heuristic and never blocks anything";
    } else {
      state = "ok";
      detail = "Game and companion run at the same privilege";
    }
  }
  return { id: "admin-rights", label: "Administrator rights", state, detail, optional: true };
}

function calibrationStep(input: ChecklistInput): SetupStep {
  const ready = input.calibration.hasStashGrid && input.calibration.hasBagGrid;
  return {
    id: "calibration",
    label: "Calibration",
    state: ready ? "ok" : "optional",
    detail: ready
      ? "Stash and bag grids calibrated"
      : "Optional — only stash transfers and sorting need it",
    optional: true,
    ...(ready ? {} : { action: "open-calibration" as const }),
  };
}

function chatStep(input: ChecklistInput): SetupStep {
  const chat = input.chatCommands;
  if (!chat) {
    return {
      id: "chat-commands",
      label: "Chat commands",
      state: "unknown",
      detail: "Not available in this build",
      optional: true,
    };
  }
  if (chat.enabled) {
    return {
      id: "chat-commands",
      label: "Chat commands",
      state: "ok",
      detail: `Enabled — one line per gesture; stopped by Ctrl+Shift+Esc and by the Dry-run switch${
        chat.dryRun ? " · dry-run on" : ""
      }`,
      optional: true,
      action: "open-settings",
    };
  }
  return {
    id: "chat-commands",
    label: "Chat commands",
    state: "optional",
    detail: "Optional — trade replies and /hideout need it",
    optional: true,
    action: "open-settings",
  };
}

/**
 * `required` counts only the five steps a working setup really needs
 * (Client.txt, league, prices, hotkeys, overlay). "unknown" never counts as
 * done, and an optional step can never block completion — so a user who runs
 * the app elevated, without a cookie and without calibration still reaches
 * "Setup complete".
 */
export function deriveSetupChecklist(input: ChecklistInput): SetupChecklist {
  const steps: SetupStep[] = [
    gameStep(input),
    clientLogStep(input),
    leagueStep(input),
    feedStep(input),
    cookieStep(input),
    hotkeyStep(input),
    overlayStep(input),
    adminStep(input),
    calibrationStep(input),
    chatStep(input),
  ];
  const requiredSteps = steps.filter((step) => !step.optional);
  const done = requiredSteps.filter((step) => step.state === "ok").length;
  return {
    steps,
    done,
    required: requiredSteps.length,
    complete: done === requiredSteps.length,
    ...(input.dismissedAt ? { dismissedAt: input.dismissedAt } : {}),
    generatedAt: input.now,
  };
}
