import { computed, onMounted, onUnmounted, ref } from "vue";
import { requireCombatCalibration, type CombatBridge, type CombatModule, type CombatStatus } from "../../core/combatAssist.js";

/** Quick controls always edit the saved configuration, never a calibration draft. */
export function useCombatControls() {
  const api = window.poe2?.combat;
  const available = Boolean(api);
  const state = ref<CombatStatus>();
  const loading = ref(available);
  const pending = ref(false);
  const actionError = ref("");
  const statusError = ref("");
  const error = computed(() => actionError.value || statusError.value);
  const readiness = computed(() => {
    if (!available) return "Open the desktop app to use combat controls.";
    if (!state.value) return "Loading saved combat settings…";
    try { requireCombatCalibration(state.value.config); return ""; }
    catch (cause) { return message(cause); }
  });
  let mounted = false;
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
  function publish(next: CombatStatus) { if (!disposed) state.value = next; }
  function schedulePoll() {
    clearTimeout(timer);
    if (mounted && !disposed && api) timer = setTimeout(() => void poll(), 750);
  }
  async function poll() {
    await refresh();
    schedulePoll();
  }
  async function refresh() {
    if (!api || disposed || pending.value) return;
    const request = ++revision;
    try {
      const next = await api.status();
      if (request === revision && !disposed) { publish(next); statusError.value = ""; }
    } catch (cause) {
      if (request === revision && !disposed) statusError.value = message(cause);
    } finally {
      if (request === revision && !disposed) loading.value = false;
    }
  }
  async function mutate(action: (bridge: CombatBridge) => Promise<void>) {
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
      // Configure stops the loop before saving; a failed resume must show that state.
      try { publish(await api.status()); }
      catch (statusCause) { if (!disposed) statusError.value = message(statusCause); }
    } finally {
      if (!disposed) { pending.value = false; loading.value = false; }
      schedulePoll();
    }
  }
  async function toggleModule(name: CombatModule, enabled?: boolean) {
    await mutate(async (bridge) => {
      const latest = await bridge.status();
      publish(latest);
      const nextEnabled = enabled ?? !latest.config[name].enabled;
      if (nextEnabled === latest.config[name].enabled) return;
      const config = structuredClone(latest.config);
      config[name].enabled = nextEnabled;
      publish(await bridge.configure(config));
      if (latest.running && [config.health, config.mana, config.unleash].some((module) => module.enabled)) {
        publish(await bridge.start());
      }
    });
  }
  async function start() {
    await mutate(async (bridge) => {
      const latest = await bridge.status();
      publish(latest);
      if (latest.running) return;
      requireCombatCalibration(latest.config);
      publish(await bridge.start());
    });
  }
  async function stop() { await mutate(async (bridge) => { publish(await bridge.stop()); }); }

  onMounted(() => { mounted = true; if (api) void poll(); });
  onUnmounted(() => { disposed = true; ++revision; clearTimeout(timer); });

  return { state, available, loading, pending, error, readiness, refresh, toggleModule, start, stop };
}
