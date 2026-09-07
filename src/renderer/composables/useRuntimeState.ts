import { computed, ref } from "vue";
import type { RuntimeMode } from "@core/types";
import { rendererApi } from "../services/rendererApi";

const RUNTIME_POLL_FOCUSED_MS = 2_500;
const RUNTIME_POLL_BLURRED_MS = 5_000;

const mode = ref<RuntimeMode>(__POE2_BUILD_MODE__);
const killLatched = ref(false);
const poeWindows = ref<Array<{ name: string; title: string }>>([]);
const loading = ref(true);
const error = ref("");
let initialized = false;
let refreshTimer: number | undefined;
// Bumped on every start/stop so a refresh still in flight when polling was
// stopped (or restarted) cannot reschedule a stale chain.
let pollGeneration = 0;

/**
 * Every refresh asks main for the Path of Exile window list (a process
 * enumeration), so the poll backs off while this window is not the one the
 * user is looking at.
 */
export function runtimePollDelayMs(focused: boolean): number {
  return focused ? RUNTIME_POLL_FOCUSED_MS : RUNTIME_POLL_BLURRED_MS;
}

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

function scheduleRuntimePoll(generation: number): void {
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refreshRuntime().then(() => {
      if (generation === pollGeneration) scheduleRuntimePoll(generation);
    });
  }, runtimePollDelayMs(document.hasFocus()));
}

async function initializeRuntime(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshRuntime();
  if (rendererApi.isNative) {
    pollGeneration += 1;
    scheduleRuntimePoll(pollGeneration);
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
    isAuthorizedQa: computed(() => true),
    targetDetected: computed(() => poeWindows.value.length > 0),
    initializeRuntime,
    refreshRuntime,
    rearm,
  };
}

export function stopRuntimePolling(): void {
  pollGeneration += 1;
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  initialized = false;
}
