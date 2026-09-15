<script setup lang="ts">
/**
 * The Evaluate workbench: one item, one editable query, one set of results.
 *
 * The same component renders over the game (compact, inside the overlay
 * panel) and inside Item log (embedded). It never searches on its own — the
 * user presses Search (or the auto-search rule in main already did) — and it
 * always shows what the next press will cost: spare lookups, the penalty
 * countdown, and which league the numbers come from.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  EvaluateBudgetView,
  EvaluateProfileId,
  EvaluateQueryState,
  EvaluateSession,
} from "../../../shared/evaluate.js";
import { EVALUATE_PROFILE_IDS, EVALUATE_PROFILE_LABELS } from "../../../shared/evaluate.js";
import { formatDate } from "../../utils/intelligence";
import EstimateBand from "./EstimateBand.vue";
import ExchangePanel from "./ExchangePanel.vue";
import HistorySparkline from "./HistorySparkline.vue";
import QueryBuilder from "./QueryBuilder.vue";
import ResultsTable from "./ResultsTable.vue";
import { useEvaluateSession } from "./useEvaluateSession";

const props = defineProps<{
  session: EvaluateSession;
  compact?: boolean;
  embedded?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const HINT_KEY = "poe2-evaluate-hint-v1";
const BUDGET_POLL_MS = 15_000;

const store = useEvaluateSession();
const draft = ref<EvaluateQueryState>(clone(props.session.query));
const liveBudget = ref<EvaluateBudgetView | undefined>(undefined);
const clock = ref(Date.now());
const hintDismissed = ref(readHint());
let pollTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

function clone(state: EvaluateQueryState): EvaluateQueryState {
  return JSON.parse(JSON.stringify(state)) as EvaluateQueryState;
}

/** Per-viewer convenience only; a blocked storage must never break the panel. */
function readHint(): boolean {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissHint(): void {
  hintDismissed.value = true;
  try {
    globalThis.localStorage?.setItem(HINT_KEY, "1");
  } catch {
    // A private window or blocked site data: the hint simply returns.
  }
}

watch(
  () => [props.session.id, props.session.query],
  () => {
    store.adopt(props.session);
    draft.value = clone(props.session.query);
  },
  { deep: false, immediate: true },
);

const budget = computed(() => liveBudget.value ?? props.session.budget);

const penaltyMs = computed(() => {
  const until = budget.value.restrictedUntilIso ? Date.parse(budget.value.restrictedUntilIso) : Number.NaN;
  return Number.isFinite(until) ? Math.max(0, until - clock.value) : 0;
});

const penaltyText = computed(() => {
  if (penaltyMs.value <= 0) return "";
  const seconds = Math.ceil(penaltyMs.value / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
});

const blocked = computed(() => {
  if (penaltyMs.value > 0) return `trade2 penalty — ${penaltyText.value} left`;
  if (budget.value.leagueAmbiguous) {
    return "Two current leagues are live — pin one in Tools → Settings → Market data";
  }
  if (!budget.value.league) return "No league resolved yet — refresh market prices in Tools → Settings";
  if (budget.value.lookups < 1) return "No spare trade2 lookup right now";
  return "";
});

const busy = computed(() => props.session.busy !== "idle");

const budgetChip = computed(() => {
  if (penaltyMs.value > 0) return { tone: "danger", text: `penalty ${penaltyText.value}` };
  if (budget.value.leagueAmbiguous) return { tone: "warning", text: "league ambiguous" };
  return {
    tone: budget.value.lookups > 0 ? "safe" : "warning",
    text: `${budget.value.lookups} lookup${budget.value.lookups === 1 ? "" : "s"} spare`,
  };
});

const captureChip = computed(() => {
  const capture = props.session.capture;
  if (!capture) return undefined;
  switch (capture.status) {
    case "dry-run":
      return { tone: "neutral", text: "Dry-run · clipboard · lookups still run" };
    case "clipboard":
      return { tone: "neutral", text: "From the clipboard" };
    case "copied":
      return { tone: "safe", text: "Copied with one Ctrl+C" };
    default:
      return { tone: "warning", text: capture.reason };
  }
});

const identityChips = computed(() => {
  const item = props.session.item;
  const chips: Array<{ text: string; tone: string }> = [{ text: item.kind, tone: "neutral" }];
  if (item.itemLevel !== undefined) chips.push({ text: `iLvl ${item.itemLevel}`, tone: "neutral" });
  if (item.quality) chips.push({ text: `Q${item.quality}%`, tone: "neutral" });
  if (item.corrupted) chips.push({ text: "Corrupted", tone: "danger" });
  if (item.mirrored) chips.push({ text: "Mirrored", tone: "danger" });
  if (item.sanctified) chips.push({ text: "Sanctified", tone: "warning" });
  if (!item.identified) chips.push({ text: "Unidentified", tone: "warning" });
  if (item.maxAffixes > 0) {
    chips.push({ text: `${item.openAffixes} open affix${item.openAffixes === 1 ? "" : "es"}`, tone: "neutral" });
  }
  return chips;
});

const results = computed(() => props.session.results);
const estimate = computed(() => results.value?.estimate ?? props.session.localEstimate);
const ourMods = computed(() => draft.value.rows.filter((row) => row.kind === "mod").map((row) => row.label));

function patchQuery(patch: Partial<EvaluateQueryState>): void {
  draft.value = { ...draft.value, ...patch };
}

function patchRow(key: string, patch: { enabled?: boolean; min?: number; max?: number }): void {
  draft.value = {
    ...draft.value,
    rows: draft.value.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
  };
}

async function search(): Promise<void> {
  if (blocked.value || busy.value) return;
  await store.search(draft.value);
}

async function changeProfile(event: Event): Promise<void> {
  const profile = (event.target as HTMLSelectElement).value as EvaluateProfileId;
  await store.setProfile(profile);
}

function openMarketTrends(): void {
  // Only inside the desktop window: the overlay must never navigate itself.
  if (!props.embedded) return;
  try {
    globalThis.location.hash = "#/tools/market";
  } catch {
    // No location (tests): nothing to do.
  }
}

async function refreshBudget(): Promise<void> {
  const next = await store.budget();
  if (next) liveBudget.value = next;
}

onMounted(() => {
  void refreshBudget();
  pollTimer = setInterval(() => void refreshBudget(), BUDGET_POLL_MS);
  tickTimer = setInterval(() => {
    clock.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<template>
  <div class="evaluate-workbench" :class="{ compact }">
    <header class="evaluate-head">
      <div class="item-identity">
        <span class="eyebrow">{{ session.item.itemClass }}</span>
        <h3 :class="`rarity-${session.item.rarity.toLowerCase()}`">{{ session.item.name }}</h3>
        <p class="muted">{{ session.item.baseType }}</p>
        <div class="identity-chips">
          <span v-for="chip in identityChips" :key="chip.text" class="pill" :class="chip.tone">{{ chip.text }}</span>
        </div>
      </div>
      <div class="head-controls">
        <label class="profile-select">
          <span class="sr-only">Search profile</span>
          <select :value="session.query.profile" :disabled="busy" @change="changeProfile">
            <option v-for="id in EVALUATE_PROFILE_IDS" :key="id" :value="id">
              {{ EVALUATE_PROFILE_LABELS[id] }}
            </option>
          </select>
        </label>
        <span class="status-chip" :class="budgetChip.tone" role="status">{{ budgetChip.text }}</span>
        <span v-if="captureChip" class="status-chip" :class="captureChip.tone">{{ captureChip.text }}</span>
      </div>
    </header>

    <p v-if="!hintDismissed" class="inline-notice hint">
      Tick the lines that define this item, then press <kbd>Enter</kbd>. "Copy query URL" hands the same search to
      the trade site or to Market → Import.
      <button type="button" class="text-link" @click="dismissHint">Got it</button>
    </p>

    <p v-if="session.busy === 'capturing'" class="muted" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span> Copying the hovered item…
    </p>

    <p v-if="blocked" class="inline-notice warning" role="status">{{ blocked }}</p>
    <p v-if="session.error" class="inline-notice danger" role="alert">{{ session.error }}</p>
    <p v-else-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>
    <p v-if="results?.complexityError" class="inline-notice warning" role="status">
      {{ results.complexityError }}
    </p>
    <p v-if="store.notice.value" class="muted" role="status">{{ store.notice.value }}</p>

    <details v-if="compact" class="advanced-options" :open="!results">
      <summary>Query ({{ draft.rows.filter((row) => row.enabled).length }} filters)</summary>
      <QueryBuilder
        :query="draft"
        :item="session.item"
        :catalogue-ready="session.catalogueReady"
        @patch="patchQuery"
        @row="patchRow"
        @submit="search"
      />
    </details>
    <QueryBuilder
      v-else
      :query="draft"
      :item="session.item"
      :catalogue-ready="session.catalogueReady"
      @patch="patchQuery"
      @row="patchRow"
      @submit="search"
    />

    <div class="button-row">
      <button type="button" class="button primary compact" :disabled="busy || !!blocked" @click="search">
        {{ session.busy === "searching" || session.busy === "fetching" ? "Searching…" : "Search" }}
      </button>
      <button
        type="button"
        class="button compact"
        :disabled="busy || !!blocked || !results || results.remainingIds === 0"
        @click="store.more()"
      >
        Load {{ Math.min(results?.remainingIds ?? 0, 10) }} more
      </button>
      <button type="button" class="button compact ghost" :disabled="busy" @click="store.openSite()">
        Open on trade site
      </button>
      <button type="button" class="button compact ghost" @click="store.copy('query-url')">Copy query URL</button>
      <button type="button" class="button compact ghost" @click="store.watch()">Watch this item</button>
      <button v-if="compact" type="button" class="button compact ghost" @click="emit('close')">Close</button>
    </div>

    <EstimateBand v-if="estimate" :estimate="estimate" />

    <ResultsTable
      v-if="results"
      :rows="results.rows"
      :item="session.item"
      :search-id="results.searchId"
      :our-mods="ourMods"
      :group-by-seller-default="session.prefs.groupBySeller"
      @copy="(kind, id) => store.copy(kind, id)"
    />

    <ExchangePanel
      v-if="session.item.kind === 'currency'"
      :exchange="session.exchange"
      :busy="session.busy === 'exchanging'"
      :disabled="!!blocked || busy || !session.item.currencyId"
      :disabled-reason="blocked || 'No bulk-exchange id is known for this item.'"
      @refresh="store.exchange()"
    />

    <HistorySparkline v-if="session.history" :history="session.history" @open="openMarketTrends" />

    <p class="muted opened-at">Opened {{ formatDate(session.openedAt) }} · league {{ budget.league ?? "unknown" }}</p>
  </div>
</template>

<style scoped>
.evaluate-workbench {
  display: grid;
  gap: 0.55rem;
}
.evaluate-workbench.compact {
  font-size: 0.82rem;
}
.evaluate-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.item-identity h3 {
  margin: 0;
}
.item-identity p {
  margin: 0;
}
.identity-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}
.head-controls {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.profile-select select {
  min-height: 31px;
  padding: 0.1rem 0.35rem;
  font-size: 0.78rem;
}
.inline-notice.hint {
  font-size: 0.76rem;
}
.opened-at {
  margin: 0;
  font-size: 0.72rem;
}
</style>
