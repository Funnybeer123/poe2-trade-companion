<script setup lang="ts">
/**
 * "Inspect overlay" settings for Tools → Settings: where the panel opens,
 * the two display toggles, the opt-in copy-on-hotkey gesture, and the
 * per-modifier map warning overrides.
 *
 * Saves through the scaffold's settings channels on every change (the
 * automation-defaults pattern — no Save button), and main's sanitizer
 * decides what actually survives.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getAppFeatureApi } from "../../services/featureApi";
import {
  DEFAULT_INSPECT_SETTINGS,
  INSPECT_SETTINGS_ID,
  normalizeInspectSettings,
  type DangerousMapModView,
  type InspectSettings,
  type MapModSeverity,
} from "../../../shared/inspect.js";
import { getInspectApi } from "./inspectApi";

const appApi = getAppFeatureApi();
const inspectApi = getInspectApi();

const settings = ref<InspectSettings>({ ...DEFAULT_INSPECT_SETTINGS });
const mapMods = ref<DangerousMapModView[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
let stopChanges: (() => void) | undefined;
let disposed = false;
/** The "Saved." line is a confirmation, not a permanent state. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const NOTICE_MS = 2_500;

const ANCHORS: ReadonlyArray<{ value: InspectSettings["anchor"]; label: string }> = [
  { value: "cursor", label: "At the cursor" },
  { value: "right", label: "Right edge" },
  { value: "left", label: "Left edge" },
  { value: "top-right", label: "Top right" },
];

const SEVERITIES: ReadonlyArray<MapModSeverity | "ignore"> = [
  "deadly",
  "dangerous",
  "caution",
  "info",
  "ignore",
];

const overriddenCount = computed(() => Object.keys(settings.value.mapModOverrides).length);

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function load(): Promise<void> {
  if (!appApi) return;
  try {
    const snapshot = await appApi.invoke("settings:get");
    if (disposed) return;
    settings.value = normalizeInspectSettings(snapshot[INSPECT_SETTINGS_ID]);
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The Inspect settings could not be loaded.");
  }
  if (!inspectApi) return;
  try {
    const rows = await inspectApi.invoke("inspect:map-mods");
    if (disposed) return;
    mapMods.value = rows;
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The map modifier table could not be loaded.");
  }
}

async function save(patch: Partial<InspectSettings>): Promise<void> {
  if (!appApi) return;
  const next = normalizeInspectSettings({ ...settings.value, ...patch });
  settings.value = next;
  try {
    await appApi.invoke("settings:set", INSPECT_SETTINGS_ID, patch);
    if (disposed) return;
    notice.value = "Saved.";
    error.value = "";
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (!disposed) notice.value = "";
    }, NOTICE_MS);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The Inspect settings could not be saved.");
  }
}

function setOverride(id: string, value: string): void {
  const overrides = { ...settings.value.mapModOverrides };
  if (!value) delete overrides[id];
  else overrides[id] = value as MapModSeverity | "ignore";
  void save({ mapModOverrides: overrides });
}

onMounted(async () => {
  if (!appApi) {
    loading.value = false;
    return;
  }
  stopChanges = appApi.on("settings:changed", (event) => {
    if (event.id !== INSPECT_SETTINGS_ID) return;
    settings.value = normalizeInspectSettings(event.value);
  });
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  if (noticeTimer) clearTimeout(noticeTimer);
  stopChanges?.();
});
</script>

<template>
  <section class="card tool-panel inspect-settings" aria-labelledby="inspect-settings-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Overlay</span>
        <h2 id="inspect-settings-title">Inspect overlay</h2>
      </div>
      <span class="status-chip neutral">Reads the clipboard only</span>
    </div>
    <p class="muted">
      Hover an item in game, press <kbd>Ctrl+C</kbd>, then the Inspect hotkey. Inspect makes no network request and
      sends no game input.
    </p>

    <div v-if="!appApi" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Inspect settings need the desktop app</strong>
      <p>This preview has no settings bridge.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading Inspect settings…</p>
    </div>
    <template v-else>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="inline-notice" role="status">{{ notice }}</p>

      <div class="form-grid">
        <label>
          Panel position
          <select
            :value="settings.anchor"
            @change="save({ anchor: ($event.target as HTMLSelectElement).value as InspectSettings['anchor'] })"
          >
            <option v-for="anchor in ANCHORS" :key="anchor.value" :value="anchor.value">{{ anchor.label }}</option>
          </select>
        </label>
      </div>

      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.showQualityNormalised"
          @change="save({ showQualityNormalised: ($event.target as HTMLInputElement).checked })"
        />
        Show DPS and defences at 20 % quality (estimates)
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.followClipboardWhilePinned"
          @change="save({ followClipboardWhilePinned: ($event.target as HTMLInputElement).checked })"
        />
        Follow the clipboard while the panel is pinned (reads once a second, never writes)
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.copyOnHotkey"
          @change="save({ copyOnHotkey: ($event.target as HTMLInputElement).checked })"
        />
        Copy the hovered item on the hotkey — sends one <kbd>Ctrl+C</kbd> through the audited chat-command gates
      </label>

      <details class="advanced-options">
        <summary>Map warning overrides <span class="count-badge">{{ overriddenCount }}</span></summary>
        <p class="muted">
          The danger table is community-maintained and unverified. Re-rate anything that does not match your build,
          or ignore it entirely.
        </p>
        <p v-if="!mapMods.length" class="empty-copy">The map modifier table is not available here.</p>
        <div v-else class="table-scroll">
          <table class="inspect-map-table">
            <thead>
              <tr>
                <th scope="col">Modifier</th>
                <th scope="col">Default</th>
                <th scope="col">Your rating</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="mod in mapMods" :key="mod.id" :data-map-mod-id="mod.id">
                <td>
                  <strong>{{ mod.label }}</strong>
                  <div class="muted">{{ mod.reason }}</div>
                </td>
                <td>{{ mod.severity }}</td>
                <td>
                  <select
                    :value="settings.mapModOverrides[mod.id] ?? ''"
                    :aria-label="`Rating for ${mod.label}`"
                    @change="setOverride(mod.id, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Default</option>
                    <option v-for="severity in SEVERITIES" :key="severity" :value="severity">{{ severity }}</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

      <p class="disclaimer">Map ratings are opinions, not guarantees — always read the modifiers yourself.</p>
    </template>
  </section>
</template>

<style scoped>
.inspect-settings {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.table-scroll {
  overflow-x: auto;
}
.inspect-map-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.inspect-map-table th,
.inspect-map-table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
  vertical-align: top;
}
.inspect-map-table th {
  text-transform: uppercase;
  font-size: 0.72rem;
  opacity: 0.7;
}
</style>
