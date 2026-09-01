import { computed, ref, watch } from "vue";
import { overlaySelectionSummary } from "@core/dryRunOverlay";
import { DEFAULT_POE_PROCESS_ALLOWLIST } from "@core/capabilities";
import {
  getAssistiveApi,
  getStashSortApi,
  rendererApi,
  type AssistiveApi,
  type AssistiveRunEvent,
  type AssistiveRunKind,
  type AssistiveRunResult,
  type StashSortApi,
} from "../services/rendererApi";
import { allowlistEntries, useRendererPreferences } from "./useRendererPreferences";
import { useRuntimeState } from "./useRuntimeState";

export const DEFAULT_TRANSFER_ALLOWLIST = [...DEFAULT_POE_PROCESS_ALLOWLIST];
export {
  DEFAULT_TRANSFER_ACTIONS_PER_MINUTE,
  DEFAULT_SORT_ACTIONS_PER_MINUTE,
} from "./useRendererPreferences";

export type TransferStatus = Awaited<ReturnType<AssistiveApi["status"]>>;
export type SortStatus = Awaited<ReturnType<StashSortApi["status"]>>;
export type SortRunResult = Awaited<ReturnType<StashSortApi["start"]>>;
export type SortRunEvent = Parameters<Parameters<StashSortApi["onEvent"]>[0]>[0];

export interface TransferStartOptions {
  kind: AssistiveRunKind;
  wantedClasses?: string[];
  uniqueAcrossCycles?: boolean;
  qaAcknowledged?: boolean;
  allowlist?: string[];
  actionsPerMinute?: number;
  maxItems?: number;
}

export interface SortStartOptions {
  action: "preview" | "execute";
  planId?: string;
  qaAcknowledged?: boolean;
  allowlist?: string[];
  actionsPerMinute?: number;
  tabSafety?: "writable-grid" | "unknown";
}

const {
  defaultDryRun: dryRun,
  processAllowlist,
  transferActionsPerMinute,
  sortActionsPerMinute,
} = useRendererPreferences();

const transferStatus = ref<TransferStatus>({
  running: false,
  killLatched: false,
  mode: "authorized-qa",
  qaOptIn: true,
  stashTab: "normal",
  gridsCalibrated: false,
  searchCalibrated: false,
  overlayVisible: false,
});
const sortStatus = ref<SortStatus>({
  running: false,
  mode: "authorized-qa",
  qaOptIn: true,
  killLatched: false,
  stashTab: "normal",
  calibrated: false,
});
const lastTransferResult = ref<AssistiveRunResult | null>(null);
const lastSortResult = ref<SortRunResult | null>(null);
const transferEvents = ref<AssistiveRunEvent[]>([]);
const sortEvents = ref<SortRunEvent[]>([]);
const actionError = ref("");
const cursorHandoffMessage = ref("");
const sendingToCursor = ref(false);

let initialized = false;
let refreshTimer: number | undefined;
let removeAssistiveListener: (() => void) | undefined;
let removeSortListener: (() => void) | undefined;
let hideOverlayOnDryRunOff = false;

const killLatched = computed(
  () => transferStatus.value.killLatched || sortStatus.value.killLatched,
);
const busy = computed(
  () => transferStatus.value.running || sortStatus.value.running,
);
const gridsReady = computed(() => transferStatus.value.gridsCalibrated);
const overlayVisible = computed(() => Boolean(transferStatus.value.overlayVisible));
const canStop = computed(
  () => busy.value || overlayVisible.value,
);

function parseAllowlist(value?: string[] | string): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  // The saved Settings allowlist is the app-wide default.
  return allowlistEntries(processAllowlist.value);
}

function searchReadyFor(wantedClasses: string[]): boolean {
  return (
    transferStatus.value.searchCalibrated ||
    (wantedClasses.length === 0 && (dryRun.value || gridsReady.value))
  );
}

function hasAssistiveApi(): boolean {
  return Boolean(getAssistiveApi());
}

function hasSortApi(): boolean {
  return Boolean(getStashSortApi());
}

export function canStartEmptyNow(): boolean {
  return Boolean(
    hasAssistiveApi() && !busy.value && !killLatched.value && gridsReady.value,
  );
}

export function canStartFillNow(wantedClasses: string[] = []): boolean {
  return (
    canStartEmptyNow() && searchReadyFor(wantedClasses)
  );
}

export function transferBlockReason(wantedClasses: string[] = []): string {
  if (!hasAssistiveApi()) {
    return "Game actions need the Electron app.";
  }
  if (killLatched.value) {
    return "Emergency stop is latched. Click Re-arm, then Empty.";
  }
  if (busy.value) {
    return transferStatus.value.running
      ? "A transfer is already running."
      : "A stash sort is already running.";
  }
  if (!gridsReady.value) {
    return "Calibrate the stash grid and bag grid under Tools → Calibration, then Empty is available.";
  }
  if (!transferStatus.value.searchCalibrated && wantedClasses.length > 0) {
    return "Class filters need the stash search box. Empty still works without it.";
  }
  return "";
}

export function sortBlockReason(): string {
  if (!hasSortApi()) {
    return "Game actions need the Electron app.";
  }
  if (killLatched.value) {
    return "Emergency stop is latched. Click Re-arm, then Sort.";
  }
  if (busy.value) {
    return transferStatus.value.running
      ? "A transfer is already running."
      : "A stash sort is already running.";
  }
  if (!sortStatus.value.calibrated) {
    return "Calibrate stash, bag, and search under Tools → Calibration, then Sort is available.";
  }
  return "";
}

function canStartSortNow(): boolean {
  return Boolean(
    hasSortApi() && !busy.value && !killLatched.value && sortStatus.value.calibrated,
  );
}

function hasFailedOrSuspectResult(result: AssistiveRunResult | null): boolean {
  if (!result) return false;
  if (!result.ok || result.dryRun) return true;
  return result.reason !== "ok" && result.reason !== "max-items-reached";
}

const canSendToCursor = computed(() => {
  if (overlayVisible.value) return true;
  if ((transferStatus.value.overlaySelection?.length ?? 0) > 0) return true;
  if ((transferStatus.value.overlayWrongCount ?? 0) > 0) return true;
  if (actionError.value) return true;
  return hasFailedOrSuspectResult(lastTransferResult.value);
});

function cursorHandoffBlockReason(): string {
  if (!hasAssistiveApi()) return "Fix in Cursor needs the Electron app.";
  if (canSendToCursor.value) {
    return "Package occupancy labels and logs, then open a Cursor Fix prompt.";
  }
  return "Label Wrong cells on the overlay, or run a dry-run Empty/Fill that failed.";
}

function transferResultMessage(result: AssistiveRunResult | null): string {
  if (!result) return "";
  const deposited = (result.traces ?? []).some(
    (trace) => trace.input?.kind === "click" && trace.result === "emitted",
  );
  if (result.kind === "empty" && result.reason === "source-empty") {
    return "No bag items were seen. Open stash and inventory, then Empty again.";
  }
  if (result.kind === "empty" && result.reason === "bag-empty" && !deposited) {
    return "The bag already looks empty.";
  }
  return result.reason;
}

const railStatus = computed(() => {
  if (actionError.value) return actionError.value;
  if (cursorHandoffMessage.value && !busy.value) return cursorHandoffMessage.value;
  if (killLatched.value) {
    return "Emergency stop is latched. Re-arm to use game actions.";
  }
  if (transferStatus.value.running) {
    const latest = transferEvents.value.at(-1);
    return latest?.message || "Transfer running…";
  }
  if (sortStatus.value.running) {
    const latest = sortEvents.value.at(-1);
    return latest?.message || "Sort running…";
  }
  if (overlayVisible.value) {
    const selected = transferStatus.value.overlaySelection ?? [];
    if (selected.length) {
      return `Overlay: ${overlaySelectionSummary(selected)}. Label Right/Wrong on the overlay.`;
    }
    return "Dry-run overlay visible. Click an item to select it; Shift-click adds more.";
  }
  if (!hasAssistiveApi() && !hasSortApi()) {
    return "Game actions need the Electron app.";
  }
  if (!gridsReady.value) {
    return "Calibrate stash and bag grids under Tools → Calibration.";
  }
  const transferMessage = transferResultMessage(lastTransferResult.value);
  if (transferMessage) return transferMessage;
  if (lastSortResult.value?.reason) {
    return lastSortResult.value.action === "preview" && lastSortResult.value.plan.executable
      ? dryRun.value
        ? "Sort preview ready. Uncheck Dry-run to move items, or execute from Tools → Sort stash."
        : lastSortResult.value.reason
      : lastSortResult.value.plan.blockers[0]?.message || lastSortResult.value.reason;
  }
  return transferStatus.value.gridsCalibrated
    ? `${transferStatus.value.stashTab === "quad" ? "Quad" : "Normal"} stash · grids ready`
    : "Grids missing";
});

const canStartEmpty = computed(() => canStartEmptyNow());
const canStartFill = computed(() => canStartFillNow());
const canStartSort = computed(() => canStartSortNow());
const startBlockReason = computed(() => transferBlockReason());

async function refreshGameActions(): Promise<void> {
  const assistive = getAssistiveApi();
  const sort = getStashSortApi();
  try {
    if (assistive) {
      transferStatus.value = await assistive.status();
      lastTransferResult.value = transferStatus.value.last ?? lastTransferResult.value;
    }
    if (sort) {
      sortStatus.value = await sort.status();
    }
  } catch (reason) {
    actionError.value =
      reason instanceof Error ? reason.message : String(reason);
  }
}

async function hideOverlay(): Promise<void> {
  const assistive = getAssistiveApi();
  if (!assistive?.hideOverlay) return;
  transferStatus.value = {
    ...transferStatus.value,
    ...(await assistive.hideOverlay()),
  };
}

async function labelOverlayCell(label: "right" | "wrong"): Promise<void> {
  const assistive = getAssistiveApi();
  if (!assistive?.labelOverlayCell) return;
  await assistive.labelOverlayCell(label);
  await refreshGameActions();
}

async function sendToCursor(): Promise<void> {
  const assistive = getAssistiveApi();
  if (!assistive?.sendToCursor) {
    actionError.value = "Fix in Cursor needs the Electron app.";
    return;
  }
  if (!canSendToCursor.value) {
    actionError.value = cursorHandoffBlockReason();
    return;
  }
  sendingToCursor.value = true;
  cursorHandoffMessage.value = "Packaging logs for Cursor…";
  actionError.value = "";
  try {
    const result = await assistive.sendToCursor();
    cursorHandoffMessage.value = result.message;
    if (!result.ok && result.message) {
      actionError.value = result.message;
    }
  } catch (reason) {
    actionError.value =
      reason instanceof Error ? reason.message : "Could not send logs to Cursor.";
    cursorHandoffMessage.value = "";
  } finally {
    sendingToCursor.value = false;
    await refreshGameActions();
  }
}

async function startAssistive(options: TransferStartOptions): Promise<AssistiveRunResult | null> {
  const assistive = getAssistiveApi();
  const wantedClasses = options.wantedClasses ?? [];
  const allowed =
    options.kind === "empty" ? canStartEmptyNow() : canStartFillNow(wantedClasses);
  if (!assistive) {
    actionError.value = "Game actions need the Electron app.";
    return null;
  }
  if (!allowed) {
    actionError.value =
      transferBlockReason(wantedClasses) ||
      (options.kind === "empty" ? "Empty is not available." : "Fill is not available.");
    return null;
  }
  actionError.value = "";
  cursorHandoffMessage.value = "";
  transferEvents.value = [];
  try {
    transferStatus.value = { ...transferStatus.value, running: true };
    const result = await assistive.start({
      kind: options.kind,
      dryRun: dryRun.value,
      wantedClasses,
      uniqueAcrossCycles: options.uniqueAcrossCycles ?? false,
      qaAcknowledged: options.qaAcknowledged ?? true,
      allowlist: parseAllowlist(options.allowlist),
      actionsPerMinute: Math.max(
        1,
        options.actionsPerMinute ?? transferActionsPerMinute.value,
      ),
      ...(options.maxItems && options.maxItems > 0
        ? { maxItems: Math.floor(options.maxItems) }
        : {}),
    });
    lastTransferResult.value = result;
    const message = transferResultMessage(result);
    if (message && (result.reason === "source-empty" || result.reason === "bag-empty")) {
      actionError.value = message;
    }
    return result;
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
    return null;
  } finally {
    await refreshGameActions();
  }
}

async function startSort(options: SortStartOptions): Promise<SortRunResult | null> {
  const sort = getStashSortApi();
  if (!sort) {
    actionError.value = "Game actions need the Electron app.";
    return null;
  }
  if (killLatched.value || busy.value) {
    actionError.value = sortBlockReason() || "Sort is not available.";
    return null;
  }
  if (options.action === "preview" && !sortStatus.value.calibrated) {
    actionError.value = sortBlockReason() || "Sort is not available.";
    return null;
  }
  actionError.value = "";
  if (options.action === "preview") sortEvents.value = [];
  try {
    sortStatus.value = { ...sortStatus.value, running: true };
    const result = await sort.start({
      action: options.action,
      ...(options.planId ? { planId: options.planId } : {}),
      qaAcknowledged: options.qaAcknowledged ?? true,
      allowlist: parseAllowlist(options.allowlist),
      actionsPerMinute: Math.max(
        1,
        Math.min(1_200, options.actionsPerMinute ?? sortActionsPerMinute.value),
      ),
      tabSafety: options.tabSafety ?? "writable-grid",
    });
    lastSortResult.value = result;
    return result;
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
    return null;
  } finally {
    await refreshGameActions();
  }
}

async function sortStash(): Promise<SortRunResult | null> {
  if (!canStartSortNow()) {
    actionError.value = sortBlockReason() || "Sort is not available.";
    return null;
  }
  const preview = await startSort({ action: "preview", tabSafety: "writable-grid" });
  if (!preview) return null;
  if (dryRun.value) return preview;
  if (!preview.plan.executable || !preview.schedule.ok || !preview.plan.id) {
    actionError.value =
      preview.plan.blockers[0]?.message ||
      preview.reason ||
      "Sort preview is not executable.";
    return preview;
  }
  return startSort({
    action: "execute",
    planId: preview.plan.id,
    tabSafety: "writable-grid",
  });
}

async function stopGameActions(): Promise<void> {
  const assistive = getAssistiveApi();
  const sort = getStashSortApi();
  if (assistive && transferStatus.value.running) {
    transferStatus.value = await assistive.stop();
  } else if (assistive && overlayVisible.value) {
    await hideOverlay();
  }
  if (sort && sortStatus.value.running) {
    sortStatus.value = await sort.stop();
  }
  await refreshGameActions();
}

async function rearmKillSwitch(): Promise<void> {
  const assistive = getAssistiveApi();
  const sort = getStashSortApi();
  try {
    if (assistive) await assistive.rearm();
    else if (sort) await sort.rearm();
    else await rendererApi.rearm();
    actionError.value = "";
    await refreshGameActions();
    await useRuntimeState().refreshRuntime();
  } catch (reason) {
    actionError.value =
      reason instanceof Error ? reason.message : "The emergency stop could not be re-armed.";
  }
}

function attachListeners(): void {
  const assistive = getAssistiveApi();
  const sort = getStashSortApi();
  removeAssistiveListener?.();
  removeSortListener?.();
  removeAssistiveListener = assistive?.onEvent((event) => {
    transferEvents.value = [...transferEvents.value.slice(-39), event];
    if (event.phase === "complete" || event.phase === "stopped" || event.phase === "overlay") {
      void refreshGameActions();
    }
  });
  removeSortListener = sort?.onEvent((event) => {
    sortEvents.value = [...sortEvents.value.slice(-59), event];
    if (event.phase === "complete" || event.phase === "aborted" || event.phase === "stopped") {
      void refreshGameActions();
    }
  });
}

async function initializeGameActions(): Promise<void> {
  if (initialized) return;
  initialized = true;
  hideOverlayOnDryRunOff = true;
  attachListeners();
  await refreshGameActions();
  if (typeof window !== "undefined" && rendererApi.isNative) {
    refreshTimer = window.setInterval(() => {
      void refreshGameActions();
    }, 1_500);
  }
}

export function disposeGameActions(): void {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  removeAssistiveListener?.();
  removeSortListener?.();
  removeAssistiveListener = undefined;
  removeSortListener = undefined;
  initialized = false;
  hideOverlayOnDryRunOff = false;
  transferStatus.value = {
    running: false,
    killLatched: false,
    mode: "authorized-qa",
    qaOptIn: true,
    stashTab: "normal",
    gridsCalibrated: false,
    searchCalibrated: false,
    overlayVisible: false,
  };
  sortStatus.value = {
    running: false,
    mode: "authorized-qa",
    qaOptIn: true,
    killLatched: false,
    stashTab: "normal",
    calibrated: false,
  };
  lastTransferResult.value = null;
  lastSortResult.value = null;
  transferEvents.value = [];
  sortEvents.value = [];
  actionError.value = "";
  cursorHandoffMessage.value = "";
  sendingToCursor.value = false;
}

watch(dryRun, (enabled) => {
  if (!hideOverlayOnDryRunOff || enabled) return;
  void hideOverlay();
});

export function useGameActions() {
  return {
    dryRun,
    transferStatus,
    sortStatus,
    lastTransferResult,
    lastSortResult,
    transferEvents,
    sortEvents,
    actionError,
    killLatched,
    busy,
    gridsReady,
    overlayVisible,
    canSendToCursor,
    sendingToCursor,
    canStop,
    canStartEmpty,
    canStartFill,
    canStartSort,
    startBlockReason,
    railStatus,
    canStartFillNow,
    transferBlockReason,
    sortBlockReason,
    initializeGameActions,
    refreshGameActions,
    startAssistive,
    startSort,
    sortStash,
    stopGameActions,
    rearmKillSwitch,
    labelOverlayCell,
    sendToCursor,
    cursorHandoffBlockReason,
  };
}
