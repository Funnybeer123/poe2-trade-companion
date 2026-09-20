import { computed, onMounted, onUnmounted, ref } from "vue";
import type { FollowerBridge, FollowerDriveStatus } from "../../shared/follower.js";

/**
 * Start and stop the overlay-map follower from the dashboard.
 *
 * Deliberately read-only about configuration: calibration is a capture of one party label on the
 * overlay map and belongs on the follower setup page, which is why the button here refuses to start
 * without it and says so rather than trying to calibrate behind the operator's back.
 *
 * Polls faster while running, because that is when the status line is worth watching.
 */
export function useFollowControls() {
  const api = window.poe2?.follower;
  const available = Boolean(api);
  const state = ref<FollowerDriveStatus>();
  const loading = ref(available);
  const pending = ref(false);
  const actionError = ref("");
  const statusError = ref("");
  const error = computed(() => actionError.value || statusError.value);
  /** Empty when the follower can start; otherwise why it cannot, phrased for the dashboard. */
  const readiness = computed(() => {
    if (!available) return "Open the desktop app to use the follower.";
    if (!state.value) return "Loading follow settings…";
    if (state.value.calibrationIssue) return state.value.calibrationIssue;
    if (!state.value.calibration) return "Calibrate on the overlay map first, in follower setup.";
    return "";
  });
  const running = computed(() => state.value?.running === true);
  /** A preview decides and traces but sends no clicks, so the button must never claim otherwise. */
  const previewOnly = computed(() => state.value?.dryRun ?? true);
  let mounted = false;
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
  function publish(next: FollowerDriveStatus) { if (!disposed) state.value = next; }
  function schedulePoll() {
    clearTimeout(timer);
    if (mounted && !disposed && api) timer = setTimeout(() => void poll(), running.value ? 250 : 1000);
  }
  async function poll() {
    await refresh();
    schedulePoll();
  }
  async function refresh() {
    if (!api || disposed || pending.value) return;
    const request = ++revision;
    try {
      const next = await api.driveStatus();
      if (request === revision && !disposed) { publish(next); statusError.value = ""; }
    } catch (cause) {
      if (request === revision && !disposed) statusError.value = message(cause);
    } finally {
      if (request === revision && !disposed) loading.value = false;
    }
  }
  async function mutate(action: (bridge: FollowerBridge) => Promise<void>) {
    if (!api || disposed || pending.value) return;
    pending.value = true;
    actionError.value = "";
    ++revision; // A status request already in flight must not overwrite this action.
    clearTimeout(timer);
    try {
      await action(api);
      if (!disposed) statusError.value = "";
    } catch (cause) {
      if (!disposed) actionError.value = message(cause);
      // The service refuses a start it cannot honour; show the state it actually settled in.
      try { publish(await api.driveStatus()); }
      catch (statusCause) { if (!disposed) statusError.value = message(statusCause); }
    } finally {
      if (!disposed) { pending.value = false; loading.value = false; }
      schedulePoll();
    }
  }
  async function start() {
    await mutate(async (bridge) => {
      const latest = await bridge.driveStatus();
      publish(latest);
      if (latest.running) return;
      publish(await bridge.driveStart());
    });
  }
  async function stop() { await mutate(async (bridge) => { publish(await bridge.driveStop()); }); }
  async function toggle() { if (running.value) await stop(); else await start(); }

  onMounted(() => { mounted = true; if (api) void poll(); });
  onUnmounted(() => { disposed = true; ++revision; clearTimeout(timer); });

  return { state, available, loading, pending, error, readiness, running, previewOnly, refresh, start, stop, toggle };
}
