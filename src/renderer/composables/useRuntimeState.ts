import { computed, ref } from "vue";
import type { RuntimeMode } from "@core/types";
import { rendererApi } from "../services/rendererApi";

const mode = ref<RuntimeMode>(__POE2_BUILD_MODE__);
const killLatched = ref(false);
const poeWindows = ref<Array<{ name: string; title: string }>>([]);
const loading = ref(true);
const error = ref("");
let initialized = false;
let refreshTimer: number | undefined;

async function refreshRuntime(): Promise<void> {
  try {
    const [nextMode, nextKillState, windows] = await Promise.all([
      rendererApi.mode(),
      rendererApi.killLatched(),
      rendererApi.windows(),
    ]);
    mode.value = nextMode;
    killLatched.value = nextKillState;
    poeWindows.value = windows;
    error.value = "";
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : "Runtime status is unavailable.";
  } finally {
    loading.value = false;
  }
}

async function initializeRuntime(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshRuntime();
  if (rendererApi.isNative) {
    refreshTimer = window.setInterval(() => {
      void refreshRuntime();
    }, 2_500);
  }
}

async function rearm(): Promise<void> {
  error.value = "";
  try {
    await rendererApi.rearm();
    await refreshRuntime();
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : "The emergency stop could not be re-armed.";
  }
}

export function useRuntimeState() {
  return {
    mode,
    killLatched,
    poeWindows,
    loading,
    error,
    isNative: computed(() => rendererApi.isNative),
    isAuthorizedQa: computed(() => mode.value === "authorized-qa"),
    targetDetected: computed(() => poeWindows.value.length > 0),
    initializeRuntime,
    refreshRuntime,
    rearm,
  };
}

export function stopRuntimePolling(): void {
  if (refreshTimer !== undefined) {
    window.clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  initialized = false;
}
