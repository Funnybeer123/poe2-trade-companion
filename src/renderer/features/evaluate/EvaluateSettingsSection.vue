<script setup lang="ts">
/**
 * "Evaluate (price check)" settings for Tools → Settings.
 *
 * Everyday switches stay visible (auto-search per item kind, the search
 * defaults, the capture mode); the profile percentages sit behind an expert
 * disclosure. Saves on change through the scaffold's settings channels —
 * main's sanitizer decides what survives.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  DEFAULT_EVALUATE_SETTINGS,
  EVALUATE_AUTO_SEARCH_KEYS,
  EVALUATE_PROFILE_IDS,
  EVALUATE_PROFILE_LABELS,
  EVALUATE_SETTINGS_ID,
  normalizeEvaluateSettings,
  type EvaluateAutoSearchKey,
  type EvaluateProfileId,
  type EvaluateSettings,
} from "../../../shared/evaluate.js";
import { getAppFeatureApi } from "../../services/featureApi";

const appApi = getAppFeatureApi();

const settings = ref<EvaluateSettings>({ ...DEFAULT_EVALUATE_SETTINGS });
const loading = ref(true);
const error = ref("");
const notice = ref("");
let stopChanges: (() => void) | undefined;
let disposed = false;

const AUTO_SEARCH_LABELS: Readonly<Record<EvaluateAutoSearchKey, string>> = {
  rare: "Rare items",
  magic: "Magic items",
  normal: "Normal bases",
  unique: "Uniques",
  currency: "Currency & stackables",
  waystone: "Waystones",
  gem: "Gems",
  other: "Flasks, jewels, tablets, relics",
};

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function load(): Promise<void> {
  if (!appApi) return;
  try {
    const snapshot = await appApi.invoke("settings:get");
    if (disposed) return;
    settings.value = normalizeEvaluateSettings(snapshot[EVALUATE_SETTINGS_ID]).value;
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The Evaluate settings could not be loaded.");
  }
}

async function save(patch: Partial<EvaluateSettings>): Promise<void> {
  if (!appApi) return;
  settings.value = normalizeEvaluateSettings({ ...settings.value, ...patch }).value;
  try {
    await appApi.invoke("settings:set", EVALUATE_SETTINGS_ID, patch);
    if (disposed) return;
    notice.value = "Saved.";
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The Evaluate settings could not be saved.");
  }
}

function setAutoSearch(key: EvaluateAutoSearchKey, enabled: boolean): void {
  void save({ autoSearch: { ...settings.value.autoSearch, [key]: enabled } });
}

function setProfile(id: EvaluateProfileId, field: "slack" | "maxMods", raw: string): void {
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  const profiles = {
    ...settings.value.profiles,
    [id]: { ...settings.value.profiles[id], [field]: field === "slack" ? value / 100 : value },
  };
  void save({ profiles });
}

onMounted(async () => {
  if (!appApi) {
    loading.value = false;
    return;
  }
  stopChanges = appApi.on("settings:changed", (event) => {
    if (event.id !== EVALUATE_SETTINGS_ID) return;
    settings.value = normalizeEvaluateSettings(event.value).value;
  });
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopChanges?.();
});
</script>

<template>
  <section class="card tool-panel evaluate-settings" aria-labelledby="evaluate-settings-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Overlay</span>
        <h2 id="evaluate-settings-title">Evaluate (price check)</h2>
      </div>
      <span class="status-chip neutral">One search + one fetch per press</span>
    </div>
    <p class="muted">
      Hover an item and press the Evaluate hotkey (<kbd>Alt+E</kbd> by default). Auto-search decides which item kinds
      spend a trade2 lookup on their own; everything else waits for Search.
    </p>

    <div v-if="!appApi" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Evaluate settings need the desktop app</strong>
      <p>This preview has no settings bridge.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading Evaluate settings…</p>
    </div>
    <template v-else>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="muted" role="status">{{ notice }}</p>

      <h3>Search automatically for</h3>
      <div class="check-row">
        <label v-for="key in EVALUATE_AUTO_SEARCH_KEYS" :key="key" class="inline-toggle">
          <input
            type="checkbox"
            :checked="settings.autoSearch[key]"
            @change="setAutoSearch(key, ($event.target as HTMLInputElement).checked)"
          />
          {{ AUTO_SEARCH_LABELS[key] }}
        </label>
      </div>

      <div class="form-grid">
        <label>
          Default profile
          <select
            :value="settings.defaultProfile"
            @change="save({ defaultProfile: ($event.target as HTMLSelectElement).value as EvaluateProfileId })"
          >
            <option v-for="id in EVALUATE_PROFILE_IDS" :key="id" :value="id">
              {{ EVALUATE_PROFILE_LABELS[id] }}
            </option>
          </select>
        </label>
        <label>
          Seller status
          <select
            :value="settings.defaultStatus"
            @change="save({ defaultStatus: ($event.target as HTMLSelectElement).value as EvaluateSettings['defaultStatus'] })"
          >
            <option value="online">Online</option>
            <option value="onlineleague">Online in league</option>
            <option value="any">Any</option>
          </select>
        </label>
        <label>
          Listing age
          <select
            :value="settings.defaultIndexed"
            @change="save({ defaultIndexed: ($event.target as HTMLSelectElement).value as EvaluateSettings['defaultIndexed'] })"
          >
            <option value="">Any age</option>
            <option value="1day">Last day</option>
            <option value="3days">Last 3 days</option>
            <option value="1week">Last week</option>
            <option value="2weeks">Last 2 weeks</option>
            <option value="1month">Last month</option>
            <option value="3months">Last 3 months</option>
          </select>
        </label>
        <label>
          Listed in
          <select
            :value="settings.defaultCurrency"
            @change="save({ defaultCurrency: ($event.target as HTMLSelectElement).value as EvaluateSettings['defaultCurrency'] })"
          >
            <option value="">Any currency</option>
            <option value="exalted">Exalted Orbs</option>
            <option value="divine">Divine Orbs</option>
            <option value="chaos">Chaos Orbs</option>
          </select>
        </label>
        <label>
          Hotkey capture
          <select
            :value="settings.captureMode"
            @change="save({ captureMode: ($event.target as HTMLSelectElement).value as EvaluateSettings['captureMode'] })"
          >
            <option value="auto">One audited Ctrl+C on the hovered item</option>
            <option value="clipboard-only">Clipboard only (no game input)</option>
          </select>
        </label>
        <label>
          Listings per page
          <input
            type="number"
            min="1"
            max="10"
            :value="settings.pageSize"
            @change="save({ pageSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>

      <div class="check-row">
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="settings.pseudoMods"
            @change="save({ pseudoMods: ($event.target as HTMLInputElement).checked })"
          />
          Offer pseudo totals (total resistance, total life …)
        </label>
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="settings.exchangeForCurrency"
            @change="save({ exchangeForCurrency: ($event.target as HTMLInputElement).checked })"
          />
          Use the bulk exchange for currency
        </label>
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="settings.groupBySeller"
            @change="save({ groupBySeller: ($event.target as HTMLInputElement).checked })"
          />
          Group listings by seller
        </label>
      </div>

      <details class="advanced-options">
        <summary>Profile percentages and mod caps</summary>
        <p class="muted">
          A profile asks a listing to reach this share of our roll on each ticked line, and ticks at most this many
          mods. 100 % is an exact match; 99 mods means every searchable line.
        </p>
        <div class="form-grid three-up">
          <template v-for="id in EVALUATE_PROFILE_IDS" :key="id">
            <label>
              {{ EVALUATE_PROFILE_LABELS[id] }} — roll share %
              <input
                type="number"
                min="50"
                max="100"
                :value="Math.round(settings.profiles[id].slack * 100)"
                @change="setProfile(id, 'slack', ($event.target as HTMLInputElement).value)"
              />
            </label>
            <label>
              {{ EVALUATE_PROFILE_LABELS[id] }} — mods
              <input
                type="number"
                min="0"
                max="99"
                :value="settings.profiles[id].maxMods"
                @change="setProfile(id, 'maxMods', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </template>
        </div>
      </details>

      <p class="disclaimer">
        Every price Evaluate shows is an estimate from current listings. Nothing is whispered, bought or listed
        automatically.
      </p>
    </template>
  </section>
</template>

<style scoped>
.evaluate-settings {
  display: grid;
  gap: 0.6rem;
}
.check-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.inline-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.inline-toggle input {
  width: auto;
  min-height: 0;
}
</style>
