<script setup lang="ts">
/**
 * Overlay placement and presentation. Every control writes straight through
 * `settings:set("overlay", …)`; main's overlay service applies the sanitized
 * value live, so the section renders whatever came back rather than its own
 * optimistic copy.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  normalizeOverlaySettings,
  type OverlayContract,
  type OverlayEvents,
  type OverlaySettings,
  type OverlayState,
} from "../../../shared/overlay.js";
import { createFeatureApi } from "../../services/featureApi";
import { getAppSettingsApi } from "./appSettingsApi";
import { useAppSettings } from "./useAppSettings";

const store = useAppSettings();
const api = getAppSettingsApi();
const overlayApi = createFeatureApi<OverlayContract, OverlayEvents>();

const settings = store.slice<OverlaySettings>("overlay", normalizeOverlaySettings);
const state = ref<OverlayState | null>(null);
const busy = ref(false);
const error = ref("");
const note = ref("");
let stopState: (() => void) | undefined;

const scaleText = computed(() => `scale ${settings.value.scale.toFixed(2)}×`);
const opacityText = computed(() => `opacity ${Math.round(settings.value.opacity * 100)} %`);
const summaryChip = computed(() => `${scaleText.value} · ${opacityText.value}`);

async function patch(value: Partial<OverlaySettings>): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await store.patch<OverlaySettings>("overlay", value);
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "That change could not be saved.";
  } finally {
    busy.value = false;
  }
}

function onNumber(key: "scale" | "opacity", event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  void patch({ [key]: raw } as Partial<OverlaySettings>);
}

function onFlag(key: keyof OverlaySettings, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  void patch({ [key]: checked } as Partial<OverlaySettings>);
}

async function testOverlay(): Promise<void> {
  if (!api) return;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    await api.invoke("app:test-overlay");
    note.value = "A test panel was shown on the overlay display.";
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The test panel could not be shown.";
  } finally {
    busy.value = false;
  }
}

async function hideAll(): Promise<void> {
  if (!overlayApi) return;
  busy.value = true;
  try {
    await overlayApi.invoke("overlay:hide-all");
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The panels could not be hidden.";
  } finally {
    busy.value = false;
  }
}

async function loadState(): Promise<void> {
  if (!overlayApi) return;
  try {
    state.value = await overlayApi.invoke("overlay:state");
  } catch {
    state.value = null;
  }
}

onMounted(() => {
  void loadState();
  stopState = overlayApi?.on("overlay:state-changed", (next) => (state.value = next));
});
onBeforeUnmount(() => stopState?.());
</script>

<template>
  <details class="advanced-options" open>
    <summary>
      Overlay
      <span class="status-chip neutral">{{ summaryChip }}</span>
    </summary>

    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <div class="form-grid">
      <label>
        <span>Panel scale</span>
        <input
          type="range"
          min="0.6"
          max="2"
          step="0.05"
          :value="settings.scale"
          :disabled="busy"
          :aria-valuetext="scaleText"
          @change="onNumber('scale', $event)"
        />
        <small class="muted">{{ scaleText }}</small>
      </label>
      <label>
        <span>Panel opacity</span>
        <input
          type="range"
          min="0.4"
          max="1"
          step="0.02"
          :value="settings.opacity"
          :disabled="busy"
          :aria-valuetext="opacityText"
          @change="onNumber('opacity', $event)"
        />
        <small class="muted">{{ opacityText }}</small>
      </label>
    </div>

    <div class="choice-row" role="radiogroup" aria-label="Ultrawide handling">
      <label class="inline-toggle">
        <input
          type="radio"
          name="ultrawide-mode"
          value="unrestricted"
          :checked="settings.ultrawideMode === 'unrestricted'"
          :disabled="busy"
          @change="patch({ ultrawideMode: 'unrestricted' })"
        />
        <span>Unrestricted — use the whole display</span>
      </label>
      <label class="inline-toggle">
        <input
          type="radio"
          name="ultrawide-mode"
          value="restricted"
          :checked="settings.ultrawideMode === 'restricted'"
          :disabled="busy"
          @change="patch({ ultrawideMode: 'restricted' })"
        />
        <span>Restricted — keep panels inside a centred 16:9 box</span>
      </label>
    </div>

    <label class="toggle-field">
      <input
        type="checkbox"
        :checked="settings.primaryMonitorOnly"
        :disabled="busy"
        @change="onFlag('primaryMonitorOnly', $event)"
      />
      <span>Keep overlay panels on the primary monitor</span>
    </label>
    <label class="toggle-field">
      <input
        type="checkbox"
        :checked="settings.closeOnClickOutside"
        :disabled="busy"
        @change="onFlag('closeOnClickOutside', $event)"
      />
      <span>Close panels when you click outside them</span>
    </label>
    <label class="toggle-field">
      <input
        type="checkbox"
        :checked="settings.showOnlyWhilePoeRuns"
        :disabled="busy"
        @change="onFlag('showOnlyWhilePoeRuns', $event)"
      />
      <span>Show overlay panels only while Path of Exile runs</span>
    </label>

    <div class="button-row">
      <button type="button" class="button secondary compact" :disabled="busy || !api" @click="testOverlay">
        Test overlay
      </button>
      <button type="button" class="button ghost compact" :disabled="busy || !overlayApi" @click="hideAll">
        Hide all panels
      </button>
      <span v-if="note" class="success-text" role="status">{{ note }}</span>
    </div>

    <dl class="property-list">
      <div>
        <dt>Overlay display</dt>
        <dd>
          <template v-if="state?.display">
            #{{ state.display.id }} · {{ state.display.bounds.width }}×{{ state.display.bounds.height }} ·
            ×{{ state.display.scaleFactor }}
          </template>
          <template v-else>not resolved yet</template>
        </dd>
      </div>
      <div>
        <dt>Game detected</dt>
        <dd>{{ state?.poeDetected ? "yes" : "no" }}</dd>
      </div>
      <div>
        <dt>Open panels</dt>
        <dd>{{ state ? state.visiblePanels.length : 0 }}</dd>
      </div>
    </dl>

    <p class="muted">
      Close on click outside closes panels that took keyboard focus (search fields) when you click the
      game; other panels close with Escape or the Hide-all hotkey — the game always keeps its clicks.
    </p>
  </details>
</template>

<style scoped>
.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0.45rem 0;
}
.property-list {
  margin-top: 0.6rem;
}
</style>
