<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { looksLikePoeItemText, parseItemText } from "../../../core/parseItem.js";
import type {
  PriceLesson,
  PriceLessonInput,
  PriceReviewItem,
  PriceTrainingBudget,
  PriceTrainingOverview,
  PriceTrainingPreview,
  TrainingMarketResult,
} from "../../../shared/priceTraining.js";
import { getPriceTrainingApi } from "./api";

const props = defineProps<{ initialItemText?: string }>();
const api = getPriceTrainingApi();
const overview = ref<PriceTrainingOverview>();
const preview = ref<PriceTrainingPreview>();
const market = ref<TrainingMarketResult>();
const currentBudget = ref<PriceTrainingBudget>();
const itemText = ref("");
const league = ref("");
const amount = ref("");
const currency = ref<PriceLessonInput["currency"]>("divine");
const evidence = ref<PriceLessonInput["evidence"]>("estimate");
const scope = ref<PriceLessonInput["scope"]>("exact");
const note = ref("");
const sourceUrl = ref("");
const observedAt = ref("");
const editingId = ref<string>();
const reviewId = ref<string>();
const error = ref("");
const notice = ref("");
const loading = ref(false);
const saving = ref(false);
const checking = ref(false);
let disposed = false;
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const evidenceLabels = { estimate: "Your estimate", listing: "Observed asking price", sale: "Reported completed sale" };
const validItem = computed(() => looksLikePoeItemText(itemText.value) && !!league.value.trim() && !["auto", "unknown", "unassigned"].includes(league.value.trim().toLowerCase()));
const marketBlocked = computed(() => {
  if (!validItem.value) return "Paste an item and enter its league first.";
  if (checking.value) return "Checking this item…";
  if (currentBudget.value?.blockedReason) return currentBudget.value.blockedReason;
  if (!currentBudget.value?.league || league.value.trim() !== currentBudget.value.league) {
    return "Set the same league in Market data settings to check listings.";
  }
  return "";
});
const askingPrice = computed(() => market.value?.ok ? market.value.summary?.median : undefined);
const askingRange = computed(() => {
  const prices = market.value?.summary?.comps.map((item) => item.price) ?? [];
  return prices.length ? `${Math.min(...prices)}–${Math.max(...prices)}` : undefined;
});
/** "[P1] …" reasons first (the decision layer's review priority), then most recent. */
function reviewPriority(item: PriceReviewItem): number {
  const match = /^\[P([1-3])\]/.exec(item.reason);
  return match ? Number(match[1]) : 4;
}
const sortedReview = computed(() =>
  [...(overview.value?.review ?? [])].sort((a, b) => reviewPriority(a) - reviewPriority(b) || b.lastSeen.localeCompare(a.lastSeen)),
);
const matchingLessons = computed(() => {
  const ids = new Set(preview.value?.estimate.lessonIds ?? []);
  return overview.value?.lessons.filter((lesson) => ids.has(lesson.id)) ?? [];
});

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function itemLabel(raw: string): string {
  const item = parseItemText(raw);
  return item.name || item.baseType || item.itemClass || "Copied item";
}
function dateLabel(value?: string): string {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}
function localDateInput(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
}

async function refresh(): Promise<void> {
  if (!api) return;
  loading.value = true;
  try {
    const next = await api.invoke("price-training:overview");
    if (disposed) return;
    overview.value = next;
    currentBudget.value = next.budget;
    if (!league.value) league.value = next.league ?? "";
  } catch (failure) { if (!disposed) error.value = describe(failure); }
  finally { if (!disposed) loading.value = false; }
}

async function previewItem(): Promise<void> {
  const sequence = ++previewSequence;
  if (!api || !validItem.value) return;
  const input = { itemText: itemText.value, league: league.value.trim() };
  try {
    const next = await api.invoke("price-training:preview", input);
    if (disposed || sequence !== previewSequence) return;
    preview.value = next;
    currentBudget.value = next.budget;
    market.value = next.cachedMarket;
  } catch (failure) { if (!disposed && sequence === previewSequence) error.value = describe(failure); }
}

watch([itemText, league], () => {
  ++previewSequence;
  preview.value = undefined;
  market.value = undefined;
  notice.value = "";
  if (previewTimer) clearTimeout(previewTimer);
  if (validItem.value) previewTimer = setTimeout(() => void previewItem(), 250);
});

function resetLessonFields(): void {
  editingId.value = undefined;
  reviewId.value = undefined;
  amount.value = "";
  currency.value = "divine";
  evidence.value = "estimate";
  scope.value = "exact";
  note.value = "";
  sourceUrl.value = "";
  observedAt.value = "";
  error.value = "";
}

function newExample(): void {
  resetLessonFields();
  itemText.value = "";
  preview.value = undefined;
  market.value = undefined;
}

function loadReview(item: PriceReviewItem): void {
  resetLessonFields();
  reviewId.value = item.id;
  itemText.value = item.itemText;
  league.value = item.league.toLowerCase() === "unassigned" ? "" : item.league;
}

function editLesson(lesson: PriceLesson): void {
  resetLessonFields();
  editingId.value = lesson.id;
  itemText.value = lesson.itemText;
  league.value = lesson.league;
  amount.value = String(lesson.amount);
  currency.value = lesson.currency;
  evidence.value = lesson.evidence;
  scope.value = lesson.scope;
  note.value = lesson.note ?? "";
  sourceUrl.value = lesson.sourceUrl ?? "";
  observedAt.value = localDateInput(lesson.observedAt);
}

async function save(): Promise<void> {
  if (!api || saving.value) return;
  error.value = "";
  notice.value = "";
  const value = Number(amount.value);
  if (!validItem.value) { error.value = "Paste a complete item copy and enter its league."; return; }
  if (!Number.isFinite(value) || value <= 0) { error.value = "Enter a price greater than zero."; return; }
  const observed = observedAt.value ? new Date(observedAt.value) : undefined;
  if (observed && !Number.isFinite(observed.getTime())) { error.value = "Enter a valid observation date."; return; }
  const input: PriceLessonInput = {
    itemText: itemText.value,
    league: league.value.trim(),
    amount: value,
    currency: currency.value,
    evidence: evidence.value,
    scope: scope.value,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    ...(sourceUrl.value.trim() ? { sourceUrl: sourceUrl.value.trim() } : {}),
    ...(observed ? { observedAt: observed.toISOString() } : {}),
  };
  saving.value = true;
  try {
    const lesson = await api.invoke("price-training:save", input, editingId.value);
    if (reviewId.value) await api.invoke("price-training:dismiss-review", reviewId.value);
    if (disposed) return;
    editingId.value = lesson.id;
    reviewId.value = undefined;
    notice.value = "Example saved. Future local estimates will use it.";
    await refresh();
    await previewItem();
  } catch (failure) { if (!disposed) error.value = describe(failure); }
  finally { if (!disposed) saving.value = false; }
}

async function removeLesson(id: string): Promise<void> {
  if (!api || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api.invoke("price-training:remove", id);
    if (editingId.value === id) resetLessonFields();
    await refresh();
    await previewItem();
    notice.value = "Example removed from future estimates.";
  } catch (failure) { if (!disposed) error.value = describe(failure); }
  finally { if (!disposed) saving.value = false; }
}

async function dismissReview(id: string): Promise<void> {
  if (!api || saving.value) return;
  saving.value = true;
  try {
    await api.invoke("price-training:dismiss-review", id);
    if (reviewId.value === id) reviewId.value = undefined;
    await refresh();
  } catch (failure) { if (!disposed) error.value = describe(failure); }
  finally { if (!disposed) saving.value = false; }
}

async function checkMarket(): Promise<void> {
  if (!api || marketBlocked.value || saving.value) return;
  const input = { itemText: itemText.value, league: league.value.trim() };
  ++previewSequence;
  if (previewTimer) clearTimeout(previewTimer);
  checking.value = true;
  error.value = "";
  try {
    const next = await api.invoke("price-training:check-market", input);
    if (disposed) return;
    currentBudget.value = next.budget;
    if (input.itemText === itemText.value && input.league === league.value.trim()) market.value = next.market;
  } catch (failure) { if (!disposed) error.value = describe(failure); }
  finally { if (!disposed) checking.value = false; }
}

function useAskingPrice(): void {
  if (!askingPrice.value || askingPrice.value <= 0 || !market.value?.summary) return;
  amount.value = String(askingPrice.value);
  currency.value = market.value.summary.currency;
  evidence.value = "listing";
  observedAt.value = localDateInput(market.value.fetchedAt);
  sourceUrl.value = "";
  notice.value = "Asking price filled in. Review the scope and save when ready.";
}

onMounted(() => void refresh());
watch(() => props.initialItemText, (value) => {
  if (!value || value === itemText.value) return;
  resetLessonFields();
  itemText.value = value;
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  ++previewSequence;
  if (previewTimer) clearTimeout(previewTimer);
});
</script>

<template>
  <section class="price-training-tool" aria-label="Price training">
    <header class="tool-heading">
      <div><h2>Price training</h2><p class="muted">Teach with item copies and corrections. Review uncertain items before their next price check.</p></div>
      <button type="button" class="button secondary" :disabled="loading || saving" @click="refresh">Refresh local data</button>
    </header>
    <p v-if="!api" class="state-panel">Price training needs the desktop app.</p>
    <template v-else>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <div class="training-grid">
        <form class="training-card lesson-form" @submit.prevent="save">
          <header class="section-heading"><h3>{{ editingId ? 'Edit example' : 'Teach a price' }}</h3><button type="button" class="button secondary compact" :disabled="saving" @click="newExample">New example</button></header>
          <p v-if="reviewId" class="muted">Review item loaded. Saving a correction also resolves this review.</p>
          <label>Item copy<textarea v-model="itemText" name="itemText" rows="9" placeholder="Paste the full Ctrl+C item text" :disabled="saving" /></label>
          <div class="field-row">
            <label>League<input v-model="league" name="league" placeholder="Enter the item's league" :disabled="saving" /></label>
            <label>Price<input v-model="amount" name="amount" type="number" min="0.000001" step="any" placeholder="1" :disabled="saving" /></label>
            <label>Currency<select v-model="currency" name="currency" :disabled="saving"><option value="divine">Divine</option><option value="exalted">Exalted</option><option value="chaos">Chaos</option></select></label>
          </div>
          <div class="field-row">
            <label>Evidence<select v-model="evidence" name="evidence" :disabled="saving"><option value="estimate">Your estimate</option><option value="listing">Observed asking price</option><option value="sale">Reported completed sale</option></select></label>
            <label>Apply to<select v-model="scope" name="scope" :disabled="saving"><option value="exact">Exact item</option><option value="similar">Similar items</option></select></label>
          </div>
          <p class="field-help">{{ scope === 'exact' ? 'Exact matches use this item’s normalized identity and rolls. This is the default for a single correction.' : 'Similar matches require the same item group and modifier pattern, rolls within 15%, and item level within 5. One example remains uncertain; inspect the reasons below.' }}</p>
          <p class="field-help">An estimate is your judgment. An asking price is a listing, and a reported sale records an outcome you observed.</p>
          <details><summary>Evidence details</summary><div class="details-fields">
            <label>Observed at<input v-model="observedAt" name="observedAt" type="datetime-local" :disabled="saving" /></label>
            <label>Source link (optional)<input v-model="sourceUrl" name="sourceUrl" type="url" placeholder="https://…" :disabled="saving" /></label>
            <label>Notes<textarea v-model="note" name="note" rows="2" :disabled="saving" /></label>
          </div></details>
          <button type="submit" class="button primary" :disabled="saving || !validItem">{{ saving ? 'Saving…' : editingId ? 'Update example' : 'Save example' }}</button>
        </form>

        <div class="estimate-column">
          <section class="training-card" aria-label="Local training estimate">
            <header class="section-heading"><h3>What it has learned</h3><button type="button" class="button secondary compact" :disabled="!validItem || saving" @click="previewItem">Preview locally</button></header>
            <template v-if="preview">
              <strong class="price-value">{{ preview.estimate.amount !== undefined ? `${preview.estimate.amount} ${preview.estimate.currency}` : 'No reliable price yet' }}</strong>
              <p>{{ preview.estimate.status }} · Evidence strength {{ preview.estimate.confidence }}/100 · {{ preview.estimate.exampleCount }} example{{ preview.estimate.exampleCount === 1 ? '' : 's' }}</p>
              <p v-if="preview.estimate.low !== undefined && preview.estimate.high !== undefined" class="muted">Example range: {{ preview.estimate.low }}–{{ preview.estimate.high }} {{ preview.estimate.currency }}</p>
              <ul><li v-for="reason in preview.estimate.reasons" :key="reason">{{ reason }}</li></ul>
              <ul v-if="matchingLessons.length" class="matched-lessons"><li v-for="lesson in matchingLessons" :key="lesson.id">{{ lesson.amount }} {{ lesson.currency }} · {{ evidenceLabels[lesson.evidence] }} · {{ lesson.scope }} · {{ dateLabel(lesson.observedAt ?? lesson.updatedAt) }}</li></ul>
            </template>
            <p v-else class="muted">Paste an item and enter its league to preview local examples.</p>
          </section>
          <section class="training-card" aria-label="Market asking prices">
            <h3>Market asking prices</h3>
            <p class="muted">Uses cached listings first. Check one item when you need more evidence.</p>
            <div class="button-row"><button type="button" class="button secondary" :disabled="!!marketBlocked || saving" @click="checkMarket">{{ checking ? 'Checking…' : 'Check market' }}</button><span>{{ currentBudget?.lookups ?? 0 }} lookups available</span></div>
            <p v-if="marketBlocked" class="field-help">{{ marketBlocked }}</p>
            <template v-if="market">
              <p v-if="market.error" class="inline-notice danger">{{ market.error }}</p>
              <template v-if="market.summary">
                <strong class="price-value">{{ market.summary.median ?? 'Unknown' }} {{ market.summary.currency }} median asking price</strong>
                <p>{{ market.summary.sampleSize }} comparable listings of {{ market.summary.candidateCount }} candidates · {{ market.basis ?? market.summary.basis }}</p>
                <p v-if="market.summary.lowest !== undefined">Lowest asking price: {{ market.summary.lowest }} {{ market.summary.currency }}</p>
                <p v-if="askingRange">Shown asking range: {{ askingRange }} {{ market.summary.currency }}</p>
                <p v-if="market.summary.caution" class="field-help">{{ market.summary.caution }}</p>
                <button type="button" class="button secondary compact" :disabled="!askingPrice || saving" @click="useAskingPrice">Use checked asking price</button>
              </template>
              <p class="field-help">{{ market.cached ? 'Cached listings' : 'Checked listings' }} · {{ market.league }} · {{ dateLabel(market.fetchedAt) }}<span v-if="market.expiresAt"> · Expires {{ dateLabel(market.expiresAt) }}</span></p>
            </template>
            <p class="field-help">Asking prices and learned prices are estimates, not guaranteed sale prices.</p>
          </section>
        </div>
      </div>

      <section class="training-card" aria-label="Review queue">
        <h3>Review queue <span class="muted">{{ overview?.review.length ?? 0 }}</span></h3>
        <p v-if="!overview?.review.length" class="muted">No items waiting for review.</p>
        <ul v-else class="record-list"><li v-for="item in sortedReview" :key="item.id">
          <div><strong>{{ itemLabel(item.itemText) }}</strong><p>{{ item.reason }}</p><small>{{ item.league }} · Seen {{ item.seenCount }} time{{ item.seenCount === 1 ? '' : 's' }} · {{ dateLabel(item.lastSeen) }}</small></div>
          <div class="button-row"><button type="button" class="button secondary compact" :disabled="saving" @click="loadReview(item)">Review item</button><button type="button" class="button secondary compact" :disabled="saving" @click="dismissReview(item.id)">Dismiss</button></div>
        </li></ul>
      </section>
      <section class="training-card" aria-label="Saved examples">
        <h3>Saved examples <span class="muted">{{ overview?.lessons.length ?? 0 }}</span></h3>
        <p v-if="!overview?.lessons.length" class="muted">Save your first correction above.</p>
        <ul v-else class="record-list"><li v-for="lesson in overview.lessons" :key="lesson.id">
          <div><strong>{{ itemLabel(lesson.itemText) }} · {{ lesson.amount }} {{ lesson.currency }}</strong><p>{{ evidenceLabels[lesson.evidence] }} · {{ lesson.scope }} · {{ lesson.league }}</p><small>{{ dateLabel(lesson.observedAt ?? lesson.updatedAt) }}<span v-if="lesson.note"> · {{ lesson.note }}</span></small></div>
          <div class="button-row"><button type="button" class="button secondary compact" :disabled="saving" @click="editLesson(lesson)">Edit</button><button type="button" class="button secondary compact" :disabled="saving" @click="removeLesson(lesson.id)">Remove</button></div>
        </li></ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.price-training-tool { display: grid; gap: 1rem; }
.tool-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.tool-heading h2, .section-heading h3 { margin: 0; }
.training-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
.training-card { border: 1px solid var(--border, #374151); border-radius: 10px; padding: 1rem; background: var(--surface, #151b25); }
.training-card h3 { margin-top: 0; }
.lesson-form, .estimate-column, .details-fields { display: grid; gap: .85rem; }
.field-row { display: flex; flex-wrap: wrap; gap: .7rem; }
.field-row > label { flex: 1 1 110px; }
label { display: grid; gap: .3rem; font-size: .875rem; }
input, select, textarea { width: 100%; box-sizing: border-box; background: var(--background, #0e141e); color: inherit; border: 1px solid var(--border, #374151); border-radius: 5px; padding: .55rem; font: inherit; }
textarea[name="itemText"] { font-family: monospace; font-size: .8rem; }
.field-help, small { color: var(--text-muted, #9ca3af); font-size: .8rem; line-height: 1.5; }
.field-help { margin: 0; }
.details-fields { padding-top: .75rem; }
.price-value { display: block; margin: .75rem 0; font-size: 1.12rem; }
.record-list { list-style: none; padding: 0; margin: 0; }
.record-list > li { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding: .8rem 0; border-top: 1px solid var(--border, #374151); }
.record-list p { margin: .3rem 0; }
.record-list .button-row { flex-shrink: 0; }
.matched-lessons { font-size: .8rem; color: var(--text-muted, #9ca3af); }
@media (max-width: 1050px) { .training-grid { grid-template-columns: 1fr; } }
@media (max-width: 620px) { .tool-heading, .record-list > li { align-items: flex-start; flex-direction: column; } }
</style>
