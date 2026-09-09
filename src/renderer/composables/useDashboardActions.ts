import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { StashTabAdminStatus } from "@core/stashTabAdmin";
import type { VoiceTransferStatus } from "@core/voiceTransfer";
import { getAssistiveApi, getShopApi, getStashSortApi, getStashTabAdminApi } from "../services/rendererApi";
import { useGameActions } from "./useGameActions";
import { useRuntimeState } from "./useRuntimeState";

export type DashboardScriptAction = "gear-sort" | "craft" | "shop-scan" | "shop-list";

const scriptKinds: Record<DashboardScriptAction, { live: string; preview: string }> = {
  "gear-sort": { live: "sort-gear", preview: "sort-gear-dry" },
  craft: { live: "craft-gear", preview: "craft-gear-dry" },
  "shop-scan": { live: "shop-scan", preview: "shop-scan-dry" },
  "shop-list": { live: "shop-buckets", preview: "shop-buckets-dry" },
};

/** Quick controls share the same bridges and saved settings as their detail pages. */
export function useDashboardActions() {
  const game = useGameActions();
  const runtime = useRuntimeState();
  const scriptApi = getStashTabAdminApi();
  const shopApi = getShopApi();
  const assistiveApi = getAssistiveApi();
  const sortApi = getStashSortApi();
  const voiceApi = assistiveApi?.voice;
  const scriptStatus = ref<StashTabAdminStatus>({ running: false, phase: "idle" });
  const shopConfigured = ref(false);
  const voiceStatus = ref<VoiceTransferStatus>();
  const loading = ref(true);
  const pending = ref(false);
  const error = ref("");
  const latestLog = ref("");
  const scriptLoaded = ref(false);
  const voiceLoaded = ref(false);
  const voiceActive = computed(() =>
    ["listening", "recognized", "transferring"].includes(voiceStatus.value?.phase ?? ""),
  );
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeScript: (() => void) | undefined;
  let unsubscribeVoice: (() => void) | undefined;
  let refreshPromise: Promise<void> | undefined;

  function message(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  async function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const results = await Promise.allSettled([
        scriptApi?.status(), shopApi?.overview(), voiceApi?.status(),
      ]);
      if (disposed) return;
      const [script, shop, voice] = results;
      scriptLoaded.value = script.status === "fulfilled" && Boolean(script.value);
      if (script.status === "fulfilled" && script.value) scriptStatus.value = script.value;
      shopConfigured.value = shop.status === "fulfilled" && Boolean(shop.value?.config?.shopTab?.trim());
      voiceLoaded.value = voice.status === "fulfilled" && Boolean(voice.value);
      if (voice.status === "fulfilled") voiceStatus.value = voice.value;
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") error.value = message(failed.reason);
      loading.value = false;
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  function commonBlockReason(checkPending = true): string {
    if (!runtime.isNative.value) return "Open the desktop app to use game actions.";
    if (loading.value) return "Checking game actions…";
    if (checkPending && pending.value) return "Starting an action…";
    if (runtime.error.value) return "Game status is unavailable. Refresh and try again.";
    if (scriptApi && !scriptLoaded.value) return "Script status is unavailable. Refresh and try again.";
    if (voiceApi && !voiceLoaded.value) return "Voice status is unavailable. Refresh and try again.";
    if (runtime.killLatched.value || game.killLatched.value) return "Re-arm the emergency stop first.";
    if (!runtime.targetDetected.value) return "Start Path of Exile 2 first.";
    if (game.busy.value || scriptStatus.value.running || voiceActive.value) return "Another game action is running.";
    return "";
  }

  function scriptBlockReason(action: DashboardScriptAction, checkPending = true): string {
    const common = commonBlockReason(checkPending);
    if (common) return common;
    if (!scriptApi?.runScript || !scriptLoaded.value) return "Script controls are unavailable. Refresh and try again.";
    if ((action === "shop-scan" || action === "shop-list") && !shopConfigured.value) return "Set up your shop tab in Shop first.";
    return "";
  }

  function canRunScript(action: DashboardScriptAction): boolean {
    return !scriptBlockReason(action);
  }

  function voiceBlockReason(checkPending = true): string {
    const common = commonBlockReason(checkPending);
    if (common) return common;
    if (!voiceApi || !voiceLoaded.value) return "Voice controls are unavailable. Refresh and try again.";
    if (!voiceStatus.value?.config.enabled) return "Enable voice transfer in Transfers first.";
    if (!game.transferStatus.value.gridsCalibrated || !game.transferStatus.value.searchCalibrated) return "Calibrate the stash, bag and search box first.";
    return "";
  }

  const canListen = computed(() => !voiceBlockReason());

  async function prepare(): Promise<void> {
    // Read these bridges directly: the shared polling helper keeps old values
    // after a disconnect, which must not authorize a new quick action.
    const [transfer, sort] = await Promise.all([
      assistiveApi?.status(), sortApi?.status(), runtime.refreshRuntime(), refresh(),
    ]);
    if (!transfer || !sort) throw new Error("Game action status is unavailable. Refresh and try again.");
    game.transferStatus.value = transfer;
    game.sortStatus.value = sort;
  }

  async function runScript(action: DashboardScriptAction): Promise<void> {
    if (pending.value) return;
    const blocked = scriptBlockReason(action);
    if (blocked) { error.value = blocked; return; }
    pending.value = true;
    error.value = "";
    try {
      await prepare();
      const reason = scriptBlockReason(action, false);
      if (reason) throw new Error(reason);
      await window.poe2?.combat?.stop();
      const kind = scriptKinds[action][game.dryRun.value ? "preview" : "live"];
      const result = await scriptApi!.runScript!(kind);
      if (!result.started) throw new Error(result.reason || "The action could not start.");
      latestLog.value = "";
    } catch (reason) {
      error.value = message(reason);
    } finally {
      await refresh();
      pending.value = false;
    }
  }

  async function listenOnce(): Promise<void> {
    if (pending.value) return;
    const blocked = voiceBlockReason();
    if (blocked) { error.value = blocked; return; }
    pending.value = true;
    error.value = "";
    try {
      await prepare();
      const reason = voiceBlockReason(false);
      if (reason) throw new Error(reason);
      await window.poe2?.combat?.stop();
      // The global preview switch applies to a quick voice run too. Keep its
      // saved recognition, key binding, allowlist and item limits intact.
      voiceStatus.value = await voiceApi!.configure({
        ...voiceStatus.value!.config, dryRun: game.dryRun.value,
      });
      await voiceApi!.trigger();
    } catch (reason) {
      error.value = message(reason);
    } finally {
      await refresh();
      pending.value = false;
    }
  }

  async function cancelVoice(): Promise<void> {
    try { await voiceApi?.cancel(); await refresh(); }
    catch (reason) { error.value = message(reason); }
  }

  async function stopScripts(): Promise<void> {
    try { await scriptApi?.stopScript?.(); await refresh(); }
    catch (reason) { error.value = message(reason); }
  }

  async function poll(): Promise<void> {
    await refresh();
    if (!disposed) timer = setTimeout(() => void poll(), 2_000);
  }

  onMounted(() => {
    unsubscribeScript = scriptApi?.onEvent((event) => {
      if (event.kind === "phase") scriptStatus.value = { ...scriptStatus.value, phase: event.phase, running: event.phase !== "idle" };
      if (event.kind === "log") latestLog.value = event.line;
      if (event.kind === "error") error.value = event.message;
    });
    unsubscribeVoice = voiceApi?.onState((status) => { voiceStatus.value = status; });
    void poll();
  });
  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(timer);
    unsubscribeScript?.();
    unsubscribeVoice?.();
  });

  return {
    scriptStatus, shopConfigured, voiceStatus, voiceActive, loading, pending,
    error, latestLog, canRunScript, scriptBlockReason, canListen, voiceBlockReason,
    refresh, runScript, listenOnce, cancelVoice, stopScripts,
  };
}
