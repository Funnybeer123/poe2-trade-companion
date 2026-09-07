<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { MOD_FAMILIES } from "@core/modKnowledge";
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MIN_SAMPLE,
  DEFAULT_THRESHOLD_PERCENT,
  WATCH_ITEM_CLASSES,
  defaultLabel,
  formatAsk,
  newWatchId,
  type DealAlert,
  type Watch,
  type WatchKind,
  type WatchQuery,
  type WatchStat,
} from "@core/watchlist";
import {
  getWatchlistApi,
  type WatchlistOverviewView,
  type WatchlistScanOutcome,
} from "../../services/rendererApi";
import { formatAmount, formatDate } from "../../utils/intelligence";

const api = getWatchlistApi();
const view = ref<WatchlistOverviewView | null>(null);
const fetchedAt = ref(0);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
const clock = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  if (!api) return;
  try {
    view.value = await api.overview();
    fetchedAt.value = Date.now();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The watchlist could not be loaded.";
  }
}

onMounted(async () => {
  await load();
  loading.value = false;
  // Cheap IPC reads (no network) keep the ETA, budget and alerts current.
  pollTimer = setInterval(() => void load(), 15_000);
  clockTimer = setInterval(() => (clock.value = Date.now()), 1_000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
});

async function apply(action: () => Promise<WatchlistOverviewView | undefined>): Promise<void> {
  if (!api) return;
  busy.value = true;
  error.value = "";
  try {
    const next = await action();
    if (next) {
      view.value = next;
      fetchedAt.value = Date.now();
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The watchlist could not be saved.";
  } finally {
    busy.value = false;
  }
}

function saveWatches(watches: Watch[]): Promise<void> {
  return apply(() => api!.save({ watches }));
}

function setEnabled(enabled: boolean): Promise<void> {
  return apply(() => api!.save({ enabled }));
}

function setNotifications(notifications: boolean): Promise<void> {
  return apply(() => api!.save({ notifications }));
}

// ---- add-watch form ------------------------------------------------------

const preset = ref<WatchKind>("unique");
const formName = ref("");
const formBaseType = ref("");
const formItemClass = ref("");
const formMinItemLevel = ref(0);
const formLabel = ref("");
const formThreshold = ref(DEFAULT_THRESHOLD_PERCENT);
const formMinSample = ref(DEFAULT_MIN_SAMPLE);
const formInterval = ref(DEFAULT_INTERVAL_MINUTES);
const formStats = ref<Array<{ familyId: string; min: number }>>([
  { familyId: "", min: 0 },
  { familyId: "", min: 0 },
  { familyId: "", min: 0 },
]);

const familyOptions = [...MOD_FAMILIES]
  .map((family) => ({ id: family.id, label: family.label }))
  .sort((a, b) => a.label.localeCompare(b.label));

const presets: Array<{ id: WatchKind; label: string; hint: string }> = [
  { id: "unique", label: "Unique by name", hint: "Reference: the poe2scout feed price when the table has it, else the median ask." },
  { id: "base-type", label: "Base type", hint: "Rare/magic listings of one base (or class) at an item-level floor; reference is the median ask." },
  { id: "stat-filtered", label: "Stat-filtered rare", hint: "Listings of a base carrying up to three mod families at a minimum roll." },
];

const draftQuery = computed<WatchQuery>(() => {
  const stats: WatchStat[] = formStats.value
    .filter((row) => row.familyId)
    .map((row) => ({ familyId: row.familyId, min: Math.max(0, Math.floor(Number(row.min) || 0)) }));
  const minItemLevel = Math.max(0, Math.floor(Number(formMinItemLevel.value) || 0));
  return {
    ...(formName.value.trim() ? { name: formName.value.trim() } : {}),
    ...(formBaseType.value.trim() ? { baseType: formBaseType.value.trim() } : {}),
    ...(formItemClass.value.trim() ? { itemClass: formItemClass.value.trim() } : {}),
    ...(preset.value === "unique" ? {} : { rarity: "nonunique" }),
    ...(preset.value !== "unique" && minItemLevel > 0 ? { minItemLevel } : {}),
    ...(preset.value === "stat-filtered" && stats.length > 0 ? { stats } : {}),
  };
});

const draftProblem = computed(() => {
  const query = draftQuery.value;
  if (preset.value === "unique") return query.name ? "" : "A unique watch needs the item name.";
  if (!query.baseType && !query.itemClass) return "Enter a base type or pick an item class.";
  if (preset.value === "stat-filtered" && !(query.stats?.length)) return "Pick at least one mod family.";
  return "";
});

async function addWatch(): Promise<void> {
  if (!api || !view.value || draftProblem.value) return;
  const query = draftQuery.value;
  const watch: Watch = {
    id: newWatchId(),
    label: formLabel.value.trim() || defaultLabel(preset.value, query),
    enabled: true,
    kind: preset.value,
    query,
    thresholdPercent: Math.min(100, Math.max(1, Math.round(Number(formThreshold.value) || DEFAULT_THRESHOLD_PERCENT))),
    minSample: Math.min(10, Math.max(1, Math.round(Number(formMinSample.value) || DEFAULT_MIN_SAMPLE))),
    intervalMinutes: Math.max(1, Math.round(Number(formInterval.value) || DEFAULT_INTERVAL_MINUTES)),
  };
  await saveWatches([...view.value.watches, watch]);
  if (!error.value) {
    formName.value = "";
    formBaseType.value = "";
    formLabel.value = "";
    notice.value = `Watching "${watch.label}".`;
  }
}

// ---- watch rows ----------------------------------------------------------

async function toggleWatch(watch: Watch, enabled: boolean): Promise<void> {
  if (!view.value) return;
  await saveWatches(view.value.watches.map((entry) => (entry.id === watch.id ? { ...entry, enabled } : entry)));
}

async function removeWatch(watch: Watch): Promise<void> {
  if (!view.value) return;
  if (pendingDeleteId.value !== watch.id) {
    pendingDeleteId.value = watch.id;
    return;
  }
  pendingDeleteId.value = "";
  await saveWatches(view.value.watches.filter((entry) => entry.id !== watch.id));
}

function describeOutcome(outcome: WatchlistScanOutcome): string {
  if (outcome.skipped) return `Not scanned: ${outcome.skipped}.`;
  if (!outcome.ok) return outcome.error ?? "The scan failed.";
  const reference =
    outcome.referenceExalted !== undefined
      ? ` · reference ${formatAmount(outcome.referenceExalted)} ex (${outcome.referenceBasis ?? "?"})`
      : "";
  return `Scanned "${outcome.label}": ${outcome.sample ?? 0} priced of ${outcome.total ?? 0} matches${reference} · ${outcome.newAlerts} new alert${outcome.newAlerts === 1 ? "" : "s"}.`;
}

async function scanNow(watchId?: string): Promise<void> {
  if (!api) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const outcome = await api.scanNow(watchId);
    const text = describeOutcome(outcome);
    if (outcome.ok) notice.value = text;
    else error.value = text;
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The scan failed.";
  } finally {
    busy.value = false;
  }
}

// ---- alerts --------------------------------------------------------------

async function copyWhisper(alert: DealAlert): Promise<void> {
  if (!api) return;
  error.value = "";
  const result = await api.copyWhisper(alert.id);
  if (result.ok) {
    notice.value = "Whisper copied — paste it into the game's chat yourself.";
  } else {
    error.value = result.error ?? "The whisper could not be copied.";
  }
}

function dismiss(alert: DealAlert): Promise<void> {
  return apply(() => api!.dismiss(alert.id));
}

function discountChip(alert: DealAlert): string {
  return alert.discountPercent >= 50 ? "safe" : alert.discountPercent >= 30 ? "warning" : "neutral";
}

function kindLabel(kind: WatchKind): string {
  return kind === "unique" ? "unique" : kind === "base-type" ? "base" : "stats";
}

function describeWatch(watch: Watch): string {
  const query = watch.query;
  const parts: string[] = [];
  if (query.name) parts.push(query.name);
  if (query.baseType) parts.push(query.baseType);
  else if (query.itemClass) parts.push(query.itemClass);
  if (query.minItemLevel) parts.push(`ilvl ${query.minItemLevel}+`);
  for (const stat of query.stats ?? []) {
    const family = MOD_FAMILIES.find((entry) => entry.id === stat.familyId);
    parts.push(`${family?.label ?? stat.familyId}${stat.min > 0 ? ` ≥ ${stat.min}` : ""}`);
  }
  return parts.join(" · ");
}

const etaSeconds = computed(() => {
  const current = view.value;
  if (!current || current.nextScanEtaMs === undefined) return undefined;
  const elapsed = clock.value - fetchedAt.value;
  return Math.max(0, Math.round((current.nextScanEtaMs - elapsed) / 1000));
});

const budgetLine = computed(() => {
  const current = view.value;
  if (!current) return "";
  const spare = `${current.budget.lookups} lookup${current.budget.lookups === 1 ? "" : "s"} spare`;
  const parts = [spare];
  if (current.budget.restrictedUntilIso) {
    parts.push(`trade2 penalty until ${formatDate(current.budget.restrictedUntilIso)}`);
  } else if (!current.enabled) {
    parts.push("automatic scans off");
  } else if (current.scanning) {
    parts.push("scanning now");
  } else if (etaSeconds.value !== undefined) {
    parts.push(etaSeconds.value === 0 ? "next scan on the next tick" : `next scan in ${formatEta(etaSeconds.value)}`);
  } else {
    parts.push("no watch enabled");
  }
  parts.push(`${current.scansThisHour}/${current.maxScansPerHour} scans this hour`);
  return parts.join(" · ");
});

function formatEta(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds - minutes * 60}s`;
}
</script>

<template>
  <section class="card tool-panel watchlist-tool" aria-labelledby="deals-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Deal sniper</span>
        <h2 id="deals-title">Deals watchlist</h2>
      </div>
      <span class="status-chip neutral">Manual decision support</span>
    </div>
    <p class="muted">
      Each watch re-runs one trade2 search on its own interval, prices the cheapest
      listings in exalted, and raises an alert when an ask sits at or under the threshold
      share of the reference price. One search plus one fetch per scan, paced from the
      server's own rate-limit headers, never more than one scan per half minute, and only
      while enough lookups are spare for a bag listing run.
    </p>
    <p class="privacy-note">
      The app never sends a whisper, buys, or lists — "Copy whisper" only puts the
      seller's message on your clipboard for you to paste in game.
    </p>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>The watchlist needs the desktop app</strong>
      <p>This preview has no trade2 bridge or clipboard.</p>
    </div>

    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading the watchlist…</p>
    </div>

    <template v-else-if="view">
      <div class="button-row watch-controls">
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="view.enabled"
            :disabled="busy"
            @change="setEnabled(($event.target as HTMLInputElement).checked)"
          />
          <span>Scan watches automatically</span>
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="view.notifications"
            :disabled="busy"
            @change="setNotifications(($event.target as HTMLInputElement).checked)"
          />
          <span>Desktop notification on a new deal</span>
        </label>
        <button
          type="button"
          class="button secondary compact"
          :disabled="busy || view.scanning || !view.watches.length"
          @click="scanNow()"
        >
          {{ view.scanning ? "Scanning…" : "Scan now" }}
        </button>
      </div>
      <p class="muted budget-line" role="status">{{ budgetLine }}</p>
      <p v-if="view.lastSkip && view.enabled" class="muted">Last tick: {{ view.lastSkip }}.</p>
      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="view.lastError" class="inline-notice warning">{{ view.lastError }}</p>

      <h3>Add a watch</h3>
      <div class="preset-row" role="radiogroup" aria-label="Watch preset">
        <label v-for="option in presets" :key="option.id" class="toggle-field">
          <input v-model="preset" type="radio" name="watch-preset" :value="option.id" />
          <span>{{ option.label }}</span>
        </label>
      </div>
      <p class="muted">{{ presets.find((option) => option.id === preset)?.hint }}</p>
      <div class="form-grid">
        <label v-if="preset === 'unique'">
          Unique name
          <input v-model="formName" placeholder="Temporalis" />
        </label>
        <label>
          Base type <span v-if="preset !== 'unique'" class="optional">(or pick a class)</span>
          <input v-model="formBaseType" :placeholder="preset === 'unique' ? 'Silk Robe' : 'Ruby Ring'" />
        </label>
        <label v-if="preset !== 'unique'">
          Item class
          <select v-model="formItemClass">
            <option value="">Any (from the base type)</option>
            <option v-for="itemClass in WATCH_ITEM_CLASSES" :key="itemClass" :value="itemClass">{{ itemClass }}</option>
          </select>
        </label>
        <label v-if="preset !== 'unique'">
          Minimum item level <span class="optional">(0 = any)</span>
          <input v-model.number="formMinItemLevel" type="number" min="0" max="100" />
        </label>
        <label>
          Alert at or under (% of reference)
          <input v-model.number="formThreshold" type="number" min="1" max="100" />
        </label>
        <label>
          Minimum priced listings
          <input v-model.number="formMinSample" type="number" min="1" max="10" />
        </label>
        <label>
          Scan every (minutes)
          <input v-model.number="formInterval" type="number" min="1" max="1440" />
        </label>
        <label>
          Label <span class="optional">(optional)</span>
          <input v-model="formLabel" placeholder="Auto from the fields" />
        </label>
      </div>
      <div v-if="preset === 'stat-filtered'" class="form-grid stat-rows">
        <label v-for="(row, index) in formStats" :key="index">
          Mod family {{ index + 1 }}
          <select v-model="row.familyId">
            <option value="">—</option>
            <option v-for="family in familyOptions" :key="family.id" :value="family.id">{{ family.label }}</option>
          </select>
          <input v-model.number="row.min" type="number" min="0" placeholder="minimum roll" :disabled="!row.familyId" />
        </label>
      </div>
      <div class="button-row">
        <button type="button" class="button primary compact" :disabled="busy || !!draftProblem" @click="addWatch">
          Add watch
        </button>
        <span v-if="draftProblem" class="muted">{{ draftProblem }}</span>
      </div>

      <h3>Watches <span class="count-badge">{{ view.watches.length }}</span></h3>
      <p v-if="!view.watches.length" class="empty-copy">
        No watches yet. Add one above, or use "Watch this item" on the Item log page.
      </p>
      <ul v-else class="watch-list">
        <li v-for="watch in view.watches" :key="watch.id" :class="{ disabled: !watch.enabled }">
          <label class="toggle-field watch-toggle">
            <input
              type="checkbox"
              :checked="watch.enabled"
              :disabled="busy"
              @change="toggleWatch(watch, ($event.target as HTMLInputElement).checked)"
            />
            <span class="sr-only">Enable {{ watch.label }}</span>
          </label>
          <div class="watch-copy">
            <strong>{{ watch.label }}</strong>
            <span class="status-chip neutral">{{ kindLabel(watch.kind) }}</span>
            <small class="muted">{{ describeWatch(watch) }}</small>
            <small class="muted">
              ≤ {{ watch.thresholdPercent }}% of reference · every {{ watch.intervalMinutes }} min ·
              {{ watch.lastScanAt ? `last scan ${formatDate(watch.lastScanAt)}` : "not scanned yet" }}
              <template v-if="watch.lastReferenceExalted !== undefined">
                · reference {{ formatAmount(watch.lastReferenceExalted) }} ex
              </template>
            </small>
          </div>
          <div class="button-row watch-actions">
            <button type="button" class="button ghost compact" :disabled="busy || view.scanning" @click="scanNow(watch.id)">
              Scan
            </button>
            <button
              type="button"
              class="button ghost compact"
              :disabled="busy"
              :title="pendingDeleteId === watch.id ? 'Click again to confirm' : 'Delete watch'"
              @click="removeWatch(watch)"
            >
              {{ pendingDeleteId === watch.id ? "Confirm delete" : "Delete" }}
            </button>
          </div>
        </li>
      </ul>

      <h3>Alerts <span class="count-badge">{{ view.alerts.length }}</span></h3>
      <p v-if="!view.alerts.length" class="empty-copy">
        No deals yet. Alerts appear here newest first as scans find listings under the threshold.
      </p>
      <ul v-else class="alert-list">
        <li v-for="alert in view.alerts" :key="alert.id">
          <span class="status-chip" :class="discountChip(alert)">−{{ alert.discountPercent }}%</span>
          <div class="alert-copy">
            <strong>{{ alert.name || alert.baseType }}</strong>
            <small v-if="alert.name && alert.baseType && alert.name !== alert.baseType" class="muted">{{ alert.baseType }}</small>
            <span>
              Ask <strong>{{ formatAsk(alert) }}</strong>
              (≈ {{ formatAmount(alert.askExalted) }} ex) · reference {{ formatAmount(alert.referenceExalted) }} ex
            </span>
            <small class="muted">
              {{ formatDate(alert.at) }}
              <template v-if="alert.accountName"> · seller {{ alert.accountName }}</template>
              <template v-if="alert.indexed"> · listed {{ formatDate(alert.indexed) }}</template>
            </small>
          </div>
          <div class="button-row alert-actions">
            <button
              type="button"
              class="button secondary compact"
              :disabled="!alert.whisper"
              :title="alert.whisper ? 'Copy the seller\'s whisper to the clipboard' : 'This listing came without a whisper'"
              @click="copyWhisper(alert)"
            >
              Copy whisper
            </button>
            <button type="button" class="button ghost compact" :disabled="busy" @click="dismiss(alert)">Dismiss</button>
          </div>
        </li>
      </ul>
      <p class="disclaimer">
        Reference prices are estimates: the feed's number for a unique, otherwise the median of
        the cheapest listings found. A deep discount can be a bait listing, a bad roll, or a
        corrupted item — read the listing before you whisper.
      </p>
    </template>
  </section>
</template>

<style scoped>
.watchlist-tool { display: flex; flex-direction: column; gap: 0.9rem; }
.watchlist-tool h3 { margin: 0.4rem 0 0.1rem; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; }
.watch-controls { align-items: center; }
.budget-line { font-variant-numeric: tabular-nums; }
.preset-row { display: flex; flex-wrap: wrap; gap: 1rem; }
.stat-rows label { grid-template-columns: 1fr; }
.watch-list, .alert-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.watch-list li, .alert-list li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.7rem;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(140, 140, 160, 0.2);
}
.watch-list li.disabled .watch-copy { opacity: 0.6; }
.watch-copy, .alert-copy { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.watch-copy strong { display: inline-flex; align-items: center; gap: 0.5rem; }
.watch-actions, .alert-actions { flex-wrap: nowrap; }
.watch-toggle { margin: 0; }
</style>
