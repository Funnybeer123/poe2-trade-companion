<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DEFAULT_HIDE_NORMAL_BELOW_ITEM_LEVEL,
  DEFAULT_LOOT_FILTER_TIERS,
  type LootFilterSummary,
} from "@core/lootFilter";
import { formatAmbiguousLeagueMessage } from "@core/priceFeed";
import { useRendererPreferences } from "../../composables/useRendererPreferences";
import { useRuntimeState } from "../../composables/useRuntimeState";
import {
  getPriceFeedApi,
  rendererApi,
  type PriceFeedStatusView,
} from "../../services/rendererApi";
import TradeWebhooksCard from "../../features/trade/components/TradeWebhooksCard.vue";
import { getTradeApi } from "../../features/trade/api/tradeApi";
import AppSettingsSections from "../../features/appSettings/AppSettingsSections.vue";
import EvaluateSettingsSection from "../../features/evaluate/EvaluateSettingsSection.vue";
import InspectSettingsSection from "../../features/inspect/InspectSettingsSection.vue";
import SessionSettingsSection from "../../features/session/components/SessionSettingsSection.vue";

/** Trade owns the only webhook editor (compliance: one secret store). */
const tradeApi = getTradeApi();

const props = defineProps<{
  panel: "filter" | "settings";
}>();

const runtime = useRuntimeState();
const {
  processAllowlist,
  transferActionsPerMinute,
  sortActionsPerMinute,
} = useRendererPreferences();
const filterName = ref("poe2-companion");
const chaseAt = ref(DEFAULT_LOOT_FILTER_TIERS.chaseAtOrAbove);
const valuableAt = ref(DEFAULT_LOOT_FILTER_TIERS.valuableAtOrAbove);
const pickupAt = ref(DEFAULT_LOOT_FILTER_TIERS.pickupAtOrAbove);
const hideNormalBelow = ref(DEFAULT_HIDE_NORMAL_BELOW_ITEM_LEVEL);
const hideMagicBelow = ref(0);
const alwaysShowUniques = ref(true);
const filterText = ref("");
const filterSummary = ref<LootFilterSummary | null>(null);
const filterError = ref("");
const filterBusy = ref(false);
const saving = ref(false);
const copied = ref(false);
const savedPath = ref("");
const canSave = rendererApi.canSaveFilter();
let previewTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Every threshold edit rebuilds the preview; only the newest build may land
 * so a slow earlier one never overwrites a newer preview (or an unmounted
 * panel).
 */
let buildSeq = 0;
let disposed = false;

function positive(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

const filterRequest = computed(() => ({
  name: filterName.value.trim() || "poe2-companion",
  tiers: {
    chaseAtOrAbove: positive(chaseAt.value, DEFAULT_LOOT_FILTER_TIERS.chaseAtOrAbove),
    valuableAtOrAbove: positive(valuableAt.value, DEFAULT_LOOT_FILTER_TIERS.valuableAtOrAbove),
    pickupAtOrAbove: positive(pickupAt.value, DEFAULT_LOOT_FILTER_TIERS.pickupAtOrAbove),
  },
  hideNormalBelowItemLevel: Math.max(0, Math.floor(Number(hideNormalBelow.value) || 0)),
  hideMagicBelowItemLevel: Math.max(0, Math.floor(Number(hideMagicBelow.value) || 0)),
  alwaysShowUniques: alwaysShowUniques.value,
}));

const tierCounts = computed(() => {
  const tiers = filterSummary.value?.tiers;
  if (!tiers) return [];
  return (["chase", "valuable", "pickup"] as const).map((tier) => ({
    tier,
    total: tiers[tier].uniqueBases + tiers[tier].currency + tiers[tier].bases,
    uniqueBases: tiers[tier].uniqueBases,
    currency: tiers[tier].currency,
  }));
});

async function buildFilter(): Promise<void> {
  const seq = ++buildSeq;
  filterError.value = "";
  copied.value = false;
  savedPath.value = "";
  filterBusy.value = true;
  try {
    const output = await rendererApi.generateFilter(filterRequest.value);
    if (seq !== buildSeq) return;
    filterText.value = output.text;
    filterSummary.value = output.summary;
  } catch (reason) {
    if (seq !== buildSeq) return;
    filterError.value =
      reason instanceof Error ? reason.message : "Filter generation failed.";
  } finally {
    if (seq === buildSeq) filterBusy.value = false;
  }
}

function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void buildFilter(), 250);
}

watch(filterRequest, schedulePreview, { deep: true });

onMounted(() => {
  if (props.panel === "filter") void buildFilter();
});

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  buildSeq += 1;
  disposed = true;
});

async function saveFilter(): Promise<void> {
  // The OS dialog is modal; a second click while it is open would queue another.
  if (saving.value || !filterText.value) return;
  saving.value = true;
  filterError.value = "";
  savedPath.value = "";
  try {
    const result = await rendererApi.saveFilter({
      text: filterText.value,
      name: filterRequest.value.name,
    });
    if (result.saved) {
      savedPath.value = result.path;
    } else if (result.reason === "unsupported") {
      filterError.value = "Saving needs the Electron app; copy the text instead.";
    }
  } catch (reason) {
    filterError.value =
      reason instanceof Error ? reason.message : "The filter could not be saved.";
  } finally {
    saving.value = false;
  }
}

const feedApi = getPriceFeedApi();
const feedStatus = ref<PriceFeedStatusView | null>(null);
const feedLeague = ref("auto");
const feedAutoRefresh = ref(false);
const feedSessid = ref("");
const feedSaved = ref("");
const feedError = ref("");
const feedChecking = ref(false);
const feedSaving = ref(false);

function describeFeedError(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

onMounted(async () => {
  if (!feedApi) return;
  try {
    const status = await feedApi.status();
    if (disposed) return;
    feedStatus.value = status;
    feedLeague.value = status.config.league;
    feedAutoRefresh.value = status.config.autoRefreshDaily;
  } catch (reason) {
    if (!disposed) feedError.value = describeFeedError(reason, "Market data settings could not be read.");
  }
});

/**
 * League picker rows: every current league poe2scout listed (with its
 * divine rate, the quickest tell between an old and a new league) plus the
 * saved pick when it is not among them, so the select never shows blank.
 */
const feedLeagueOptions = computed(() => {
  const options = (feedStatus.value?.leagueCandidates ?? []).map((candidate) => ({
    value: candidate.value,
    label:
      candidate.divinePrice !== undefined
        ? `${candidate.value} (divine ≈ ${Math.round(candidate.divinePrice)} ex)`
        : candidate.value,
  }));
  const saved = feedLeague.value.trim();
  if (saved && saved !== "auto" && !options.some((option) => option.value === saved)) {
    options.push({ value: saved, label: `${saved} (saved)` });
  }
  return options;
});

const feedAmbiguityMessage = computed(() =>
  feedStatus.value?.leagueAmbiguous
    ? formatAmbiguousLeagueMessage(feedStatus.value.leagueCandidates)
    : "",
);

const feedResolvedLine = computed(() => {
  const status = feedStatus.value;
  if (!status || status.leagueAmbiguous) return "";
  if (status.resolvedLeague) {
    return `Pricing league: ${status.resolvedLeague}${status.config.league === "auto" ? " (auto)" : ""}`;
  }
  return "Pricing league: not resolved yet — check leagues or refresh market prices.";
});

/** One small poe2scout read so the picker can list the current leagues. */
async function checkLeagues(): Promise<void> {
  if (!feedApi || feedChecking.value) return;
  feedChecking.value = true;
  feedError.value = "";
  try {
    await feedApi.leagues();
    const status = await feedApi.status();
    if (!disposed) feedStatus.value = status;
  } catch (reason) {
    if (!disposed) feedError.value = describeFeedError(reason, "League check failed.");
  } finally {
    feedChecking.value = false;
  }
}

async function saveFeedConfig(): Promise<void> {
  if (!feedApi || feedSaving.value) return;
  feedSaving.value = true;
  feedSaved.value = "";
  feedError.value = "";
  try {
    const status = await feedApi.configure({
      league: feedLeague.value.trim() || "auto",
      autoRefreshDaily: feedAutoRefresh.value,
      // Only send the cookie when the user typed one; blank leaves it as-is.
      ...(feedSessid.value.trim() ? { poesessid: feedSessid.value.trim() } : {}),
    });
    if (disposed) return;
    feedStatus.value = status;
    feedSessid.value = "";
    feedSaved.value = "Market data settings saved.";
  } catch (reason) {
    if (!disposed) feedError.value = describeFeedError(reason, "Market data settings could not be saved.");
  } finally {
    feedSaving.value = false;
  }
}

async function clearSavedCookie(): Promise<void> {
  if (!feedApi || feedSaving.value) return;
  feedSaving.value = true;
  feedSaved.value = "";
  feedError.value = "";
  try {
    const status = await feedApi.configure({ poesessid: "" });
    if (disposed) return;
    feedStatus.value = status;
    feedSaved.value = "Saved cookie cleared.";
  } catch (reason) {
    if (!disposed) feedError.value = describeFeedError(reason, "The saved cookie could not be cleared.");
  } finally {
    feedSaving.value = false;
  }
}

async function copyFilter(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard writing is unavailable.");
    }
    await navigator.clipboard.writeText(filterText.value);
    copied.value = true;
  } catch (reason) {
    filterError.value =
      reason instanceof Error ? reason.message : "The filter could not be copied.";
  }
}
</script>

<template>
  <section v-if="panel === 'filter'" class="card tool-panel filter-tool" aria-labelledby="filter-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Live prices → item filter</span>
        <h2 id="filter-title">Loot filter generator</h2>
      </div>
      <span class="status-chip neutral">No account sync</span>
    </div>
    <p class="muted">
      Builds a Path of Exile 2 item filter from the price table (poe2scout feed plus your
      own rows). Uniques are rated per base type — a filter cannot see names — and
      currency, waystones, gems and anything unpriced are never hidden. Thresholds are
      in exalted. Refresh market prices on the Sort → Prices tab first for current values.
    </p>
    <div class="form-grid">
      <label>
        Filter name
        <input v-model="filterName" />
      </label>
      <label>
        Chase at or above (ex)
        <input v-model.number="chaseAt" type="number" min="0.01" step="1" />
      </label>
      <label>
        Valuable at or above (ex)
        <input v-model.number="valuableAt" type="number" min="0.01" step="0.5" />
      </label>
      <label>
        Pickup at or above (ex)
        <input v-model.number="pickupAt" type="number" min="0.01" step="0.1" />
      </label>
      <label>
        Hide Normal gear below item level <span class="optional">(0 = never)</span>
        <input v-model.number="hideNormalBelow" type="number" min="0" max="100" />
      </label>
      <label>
        Hide Magic gear below item level <span class="optional">(0 = never)</span>
        <input v-model.number="hideMagicBelow" type="number" min="0" max="100" />
      </label>
    </div>
    <label class="toggle-field">
      <input v-model="alwaysShowUniques" type="checkbox" />
      <span>Always show every unique, rated or not</span>
    </label>
    <div class="button-row">
      <button type="button" class="button primary" :disabled="filterBusy" @click="buildFilter">
        {{ filterBusy ? "Building…" : "Rebuild preview" }}
      </button>
      <button
        type="button"
        class="button secondary"
        :disabled="!filterText"
        @click="copyFilter"
      >
        {{ copied ? "Copied" : "Copy" }}
      </button>
      <button
        v-if="canSave"
        type="button"
        class="button secondary"
        :disabled="!filterText || saving"
        @click="saveFilter"
      >
        {{ saving ? "Saving…" : "Save…" }}
      </button>
      <span v-if="savedPath" class="success-text" role="status">Saved to {{ savedPath }}</span>
    </div>
    <p class="muted">
      Save… opens a file dialog (defaults to Documents\My Games\Path of Exile 2). Nothing is
      written without your pick; select the file in the game's Options → Game → Item filter.
    </p>
    <p v-if="filterError" class="inline-notice danger" role="alert">{{ filterError }}</p>
    <dl v-if="filterSummary" class="property-list filter-summary" aria-label="Filter summary">
      <div>
        <dt>Highlighted bases</dt>
        <dd>{{ filterSummary.highlightedBases }}</dd>
      </div>
      <div v-for="entry in tierCounts" :key="entry.tier">
        <dt>{{ entry.tier }}</dt>
        <dd>
          {{ entry.total }}
          <small class="muted">({{ entry.uniqueBases }} unique bases · {{ entry.currency }} currency)</small>
        </dd>
      </div>
      <div>
        <dt>Price rows</dt>
        <dd>
          {{ filterSummary.priceRows }}
          <small class="muted">({{ filterSummary.feedRows }} from the feed · {{ filterSummary.skippedEntries }} not expressible)</small>
        </dd>
      </div>
      <div v-if="filterSummary.league">
        <dt>League</dt>
        <dd>{{ filterSummary.league }}</dd>
      </div>
    </dl>
    <pre v-if="filterText" class="filter-output" tabindex="0">{{ filterText }}</pre>
    <div v-else class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">▽</span>
      <strong>No filter yet</strong>
      <p>The preview builds as you change thresholds.</p>
    </div>
  </section>

  <section v-else class="settings-grid" aria-labelledby="settings-title">
    <div class="card tool-panel">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Safe defaults</span>
          <h2 id="settings-title">Automation defaults</h2>
        </div>
      </div>
      <p class="muted">
        Every transfer, sort, and scan uses these defaults. The Dry-run switch
        lives in the top bar and applies everywhere at once.
      </p>
      <div class="form-grid">
        <label>
          Process allowlist
          <input v-model="processAllowlist" placeholder="PathOfExileSteam.exe, PathOfExile.exe" />
        </label>
        <label>
          Transfer actions per minute
          <input v-model.number="transferActionsPerMinute" type="number" min="1" max="600" />
        </label>
        <label>
          Sort actions per minute
          <input v-model.number="sortActionsPerMinute" type="number" min="1" max="1200" />
        </label>
      </div>

      <template v-if="feedApi">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Market data</span>
            <h3>Live prices</h3>
          </div>
        </div>
        <p class="muted">
          The price feed pulls poe2scout prices into the price table on demand
          (Prices tab) or daily. Market comps for one item use the official
          trade2 API and work without a session cookie; adding your
          <code>POESESSID</code> is optional and only ever sent to
          pathofexile.com.
        </p>
        <div class="form-grid">
          <label>
            League <span class="optional">("auto" follows the single current league)</span>
            <select v-model="feedLeague">
              <option value="auto">auto</option>
              <option v-for="option in feedLeagueOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            POESESSID <span class="optional">(optional{{ feedStatus?.config.poesessid ? " · saved" : "" }})</span>
            <input v-model="feedSessid" type="password" autocomplete="off" placeholder="leave blank to keep current" />
          </label>
        </div>
        <p v-if="feedAmbiguityMessage" class="inline-notice danger" role="alert">
          {{ feedAmbiguityMessage }}
        </p>
        <p v-else-if="feedResolvedLine" class="muted">{{ feedResolvedLine }}</p>
        <p v-if="feedError" class="inline-notice danger" role="alert">{{ feedError }}</p>
        <label class="toggle-field">
          <input v-model="feedAutoRefresh" type="checkbox" />
        <span>Refresh market prices daily while the app is open</span>
        </label>
        <div class="button-row">
          <button type="button" class="button secondary" :disabled="feedSaving" @click="saveFeedConfig">
            {{ feedSaving ? "Saving…" : "Save market settings" }}
          </button>
          <button
            type="button"
            class="button ghost compact"
            :disabled="feedChecking"
            title="One small poe2scout request listing the current leagues"
            @click="checkLeagues"
          >
            {{ feedChecking ? "Checking…" : "Check leagues" }}
          </button>
          <button
            v-if="feedStatus?.config.poesessid"
            type="button"
            class="button ghost compact"
            :disabled="feedSaving"
            @click="clearSavedCookie"
          >
            Clear saved cookie
          </button>
          <span v-if="feedSaved" class="success-text" role="status">{{ feedSaved }}</span>
        </div>
      </template>

      <TradeWebhooksCard v-if="tradeApi" />
      <AppSettingsSections />
      <EvaluateSettingsSection />
      <InspectSettingsSection />
      <SessionSettingsSection />

      <div class="settings-facts">
        <article>
          <span class="nav-glyph" aria-hidden="true">PC</span>
          <div>
            <strong>Price-check hotkey</strong>
            <p>Hover an item, copy it in PoE2, then use Ctrl+D in the Electron app.</p>
          </div>
        </article>
        <article>
          <span class="nav-glyph" aria-hidden="true">ES</span>
          <div>
            <strong>Emergency stop</strong>
            <p>Ctrl+Shift+Esc immediately latches generated input in authorized QA mode.</p>
          </div>
        </article>
        <article>
          <span class="nav-glyph" aria-hidden="true">VO</span>
          <div>
            <strong>Voice transfer</strong>
            <p>Ctrl+Alt+V by default; configure exact behavior in Transfers.</p>
          </div>
        </article>
      </div>
    </div>

    <aside class="card runtime-card">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Environment</span>
          <h2>Runtime status</h2>
        </div>
        <span class="status-chip" :class="runtime.isNative.value ? 'safe' : 'neutral'">
          {{ runtime.isNative.value ? "Electron bridge" : "Browser preview" }}
        </span>
      </div>
      <dl class="property-list">
        <div><dt>Mode</dt><dd>{{ runtime.mode.value }}</dd></div>
        <div><dt>Emergency stop</dt><dd>{{ runtime.killLatched.value ? "Latched" : "Ready" }}</dd></div>
        <div><dt>PoE windows</dt><dd>{{ runtime.poeWindows.value.length }}</dd></div>
      </dl>
      <ul v-if="runtime.poeWindows.value.length" class="window-list">
        <li v-for="entry in runtime.poeWindows.value" :key="`${entry.name}-${entry.title}`">
          <strong>{{ entry.name }}</strong>
          <span>{{ entry.title }}</span>
        </li>
      </ul>
      <p v-else class="muted">
        {{ runtime.isNative.value ? "No configured Path of Exile window is currently detected." : "Preview mode never generates game input." }}
      </p>
      <button
        type="button"
        class="button secondary full-button"
        @click="runtime.refreshRuntime"
      >
        Refresh runtime status
      </button>
    </aside>
  </section>
</template>
