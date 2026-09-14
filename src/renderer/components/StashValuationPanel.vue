<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from "vue";
import { MOD_FAMILIES } from "@core/modKnowledge";
import { GEAR_TAB_NAMES } from "@core/gearSort";
import { validateSavedStashReport, type SavedStashPricingReport } from "@core/savedStashPricing";
import {
  defaultStashValuationSettings,
  validateStashValuationSettings,
  type StashValuationReport,
  type StashValuationRow,
  type StashValuationSettings,
} from "@core/stashValuation";
import { useRendererPreferences } from "../composables/useRendererPreferences";
import { getStashTabAdminApi, getStashValuationApi } from "../services/rendererApi";

const api = getStashValuationApi();
const scripts = getStashTabAdminApi();
const { defaultDryRun: dryRun } = useRendererPreferences();
const settings = ref<StashValuationSettings>(defaultStashValuationSettings());
const profiles = ref<Record<string, StashValuationSettings>>({});
const report = ref<StashValuationReport | null>(null);
const running = ref(false);
const busy = ref(false);
const loaded = ref(false);
const message = ref("");
const error = ref("");
const issues = ref<string[]>([]);
const log = ref<string[]>([]);
const now = ref(Date.now());
let unsubscribe: (() => void) | undefined;
let freshnessTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

const validation = computed(() => validateStashValuationSettings(settings.value));
const canRun = computed(() => Boolean(api && scripts?.runScript && loaded.value && !running.value && !busy.value && !validation.value.length));
const canResume = computed(() => Boolean(api && scripts?.runScript && loaded.value && !running.value && !busy.value &&
  report.value?.rows.length && !validateSavedStashReport(report.value).length));
const pricingResume = computed(() => (report.value as SavedStashPricingReport | null)?.pricingResume);
const counts = computed(() => {
  const rows = report.value?.rows ?? [];
  return {
    priced: rows.filter(row => row.quote.state === "priced").length,
    unpriced: rows.filter(row => row.quote.state !== "priced").length,
    pending: rows.filter(row => row.quote.state === "unavailable").length,
    limited: rows.filter(row => row.quote.state === "priced" && quoteIssues(row).length).length,
    valuable: rows.filter(row => row.decision === "valuable").length,
    craft: rows.filter(row => row.decision === "craft").length,
    review: rows.filter(row => row.decision === "review").length,
    moved: rows.filter(row => row.status === "moved").length,
    failed: rows.filter(row => row.status === "failed").length,
  };
});

async function refresh(loadSettings = false): Promise<void> {
  if (!api) { loaded.value = true; return; }
  if (refreshing) return;
  refreshing = true;
  try {
    const overview = await api.overview();
    if (loadSettings) settings.value = structuredClone(overview.settings);
    profiles.value = overview.profiles;
    report.value = overview.report;
    issues.value = overview.issues;
    if (scripts) running.value = (await scripts.status()).running;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Could not load dump valuation.";
  } finally {
    refreshing = false;
    loaded.value = true;
  }
}

onMounted(async () => {
  freshnessTimer = setInterval(() => {
    now.value = Date.now();
    if (running.value) void refresh();
  }, 2_000);
  unsubscribe = scripts?.onEvent(event => {
    if (event.kind === "phase") {
      running.value = event.phase !== "idle";
      if (event.phase === "idle") void refresh();
    }
    if (event.kind === "error") error.value = event.message;
    if (event.kind === "log") log.value = [...log.value.slice(-149), event.line];
  });
  await refresh(true);
});
onBeforeUnmount(() => { unsubscribe?.(); clearInterval(freshnessTimer); });

function selectLeague(): void {
  const league = settings.value.league.trim();
  const saved = profiles.value[league];
  if (saved) {
    settings.value = structuredClone(toRaw(saved));
    message.value = `Loaded saved thresholds and scoring weights for ${league}.`;
  } else {
    settings.value.league = league;
    message.value = "This league will use the displayed thresholds and weights when you save.";
  }
}

async function persist(): Promise<void> {
  if (!api) throw new Error("Saving valuation settings requires the desktop app.");
  const payload = JSON.parse(JSON.stringify(settings.value)) as StashValuationSettings;
  const saved = await api.saveSettings(payload);
  settings.value = saved;
  profiles.value[saved.league] = saved;
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = "";
  try { await persist(); message.value = `Saved valuation settings for ${settings.value.league}.`; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : "Settings could not be saved."; }
  finally { busy.value = false; }
}

async function run(move: boolean): Promise<void> {
  if (!canRun.value || (move && dryRun.value)) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  log.value = [];
  try {
    await persist();
    const result = await scripts!.runScript!(move ? "value-dump-sort" : "value-dump");
    if (!result.started) throw new Error(`Could not start dump valuation: ${result.reason ?? "unknown reason"}`);
    running.value = true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Dump valuation could not start.";
  } finally { busy.value = false; }
}

async function stop(): Promise<void> {
  await scripts?.stopScript?.();
  await refresh();
}

async function resumePricing(): Promise<void> {
  if (!canResume.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  log.value = [];
  try {
    // The saved report owns its league and thresholds. Unsaved form changes
    // must not silently reinterpret a prior capture or rewrite its settings.
    const result = await scripts!.runScript!("value-dump-resume");
    if (!result.started) throw new Error("Could not resume saved pricing: " + (result.reason ?? "unknown reason"));
    running.value = true;
    message.value = "Resuming unavailable prices for " + report.value!.league + " using the saved report's settings. Earlier quote timestamps and transfer receipts are retained.";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Saved pricing could not start.";
  } finally { busy.value = false; }
}

function time(value?: string): string {
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
function amount(value?: number): string { return value === undefined ? "—" : Number(value.toFixed(3)).toString(); }
function quoteIssues(row: StashValuationRow): string[] {
  if (row.quote.state !== "priced") return [];
  const limits = report.value?.settings ?? settings.value;
  const age = now.value - Date.parse(row.quote.fetchedAt);
  const result: string[] = [];
  if (!Number.isFinite(age) || age < -60_000) result.push("Invalid market timestamp");
  else if (age > limits.maxAgeMinutes * 60_000) result.push(`Stale quote: older than ${limits.maxAgeMinutes} minutes; rescan to refresh`);
  if (row.quote.validUntil !== undefined) {
    const expires = typeof row.quote.validUntil === "string" ? Date.parse(row.quote.validUntil) : Number.NaN;
    if (!Number.isFinite(expires)) result.push("Invalid market evidence expiry; rescan required");
    else if (expires <= now.value) result.push("Expired market or currency evidence; rescan to refresh");
  }
  if (row.quote.league !== report.value?.league || row.quote.currency !== "chaos") result.push("Different league or currency; excluded from valuation");
  if (row.quote.confidence < limits.minMarketConfidence || row.quote.sampleSize < 3) result.push("Limited price evidence: insufficient confidence or sample size");
  return result;
}
function tradeLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.pathofexile.com" ? url.href : undefined;
  } catch { return undefined; }
}
</script>

<template>
  <div class="valuation-panel">
    <section class="card valuation-card" aria-labelledby="dump-values-title">
      <span class="eyebrow">Every item · explicit league · market evidence</span>
      <h2 id="dump-values-title">Find value in your dump tab</h2>
      <p>Read each item, request comparable market listings for its league, and retain an explanation for every result.
        A conservative estimate must be <strong>strictly above {{ settings.minChaos }} chaos</strong> to qualify for value sorting.
        Strong crafting candidates also qualify. Unknown or uncertain values remain in the source tab for review.</p>
      <p class="muted">Market ranges are estimates from asking prices. Scores describe item properties; crafting scores do not estimate profit.</p>
      <p v-if="!api" class="inline-notice warning">Open the desktop app to save settings, scan the game, and move items.</p>

      <fieldset :disabled="running || busy" class="settings-grid">
        <legend>League and routing</legend>
        <label>Exact league name
          <input v-model="settings.league" data-test="league" list="valuation-leagues" placeholder="For example: Forbidden Rites" @change="selectLeague" />
        </label>
        <datalist id="valuation-leagues"><option v-for="league in Object.keys(profiles)" :key="league" :value="league" /></datalist>
        <label>Source tab · top level<input v-model="settings.sourceTab" data-test="source-tab" /></label>
        <label>Destination folder<input v-model="settings.destinationFolder" data-test="destination-folder" /></label>
        <label>Sort eligible items into
          <select v-model="settings.routingMode" data-test="routing-mode">
            <option value="class">Existing tabs by item class</option>
            <option value="purpose">Separate sale and crafting tabs</option>
          </select>
        </label>
        <template v-if="settings.routingMode === 'purpose'">
          <label>Valuable items tab<input v-model="settings.valuableTab" /></label>
          <label>Crafting candidates tab<input v-model="settings.craftTab" /></label>
          <label>Optional manual review tab<input v-model="settings.reviewTab" /></label>
        </template>
        <label>Sale estimate strictly above · chaos<input v-model.number="settings.minChaos" type="number" min="0" max="1000000" step="0.1" /></label>
        <label>Minimum crafting score<input v-model.number="settings.minCraftScore" type="number" min="0" max="100" /></label>
        <label>Minimum market confidence · %<input v-model.number="settings.minMarketConfidence" type="number" min="0" max="100" /></label>
        <label>Maximum market age · minutes<input v-model.number="settings.maxAgeMinutes" type="number" min="1" max="1440" /></label>
      </fieldset>

      <details v-if="settings.routingMode === 'class'" open>
        <summary>Existing class tabs in {{ settings.destinationFolder }}</summary>
        <p class="muted">Both valuable items and strong crafting candidates go to their class tab. Match your in-game spelling below.
          A blank destination keeps that class in {{ settings.sourceTab }}.</p>
        <fieldset :disabled="running || busy" class="settings-grid">
          <label v-for="name in GEAR_TAB_NAMES" :key="name">{{ name === 'Body Armor' ? 'Body armour items' : name }}
            <input :value="settings.classTabs[name] ?? ''" :data-test="`class-${name}`" placeholder="No destination configured"
              @input="(($event.target as HTMLInputElement).value.trim() ? settings.classTabs[name] = ($event.target as HTMLInputElement).value : delete settings.classTabs[name])" />
          </label>
        </fieldset>
      </details>

      <details>
        <summary>Improve scoring for this league</summary>
        <p class="muted">Multipliers from 0 to 5 adjust each modifier family's contribution. A multiplier of 1 keeps the built-in score.
          Saved profiles retain separate weights for each exact league. Rescan after changes to recompute the report.</p>
        <fieldset :disabled="running || busy" class="weights-grid">
          <label v-for="family in MOD_FAMILIES" :key="family.id">{{ family.label }}
            <input :value="settings.weights[family.id] ?? 1" type="number" min="0" max="5" step="0.1"
              @input="settings.weights[family.id] = Number(($event.target as HTMLInputElement).value)" />
          </label>
        </fieldset>
      </details>
      <details class="tab-guide">
        <summary>Exact stash tab names and placement</summary>
        <p>Use the top-level tab <strong>{{ settings.sourceTab }}</strong> and the folder <strong>{{ settings.destinationFolder }}</strong>.</p>
        <template v-if="settings.routingMode === 'class'">
          <p>The destination tabs inside {{ settings.destinationFolder }} use these exact configured names:</p>
          <ul class="tab-names"><li v-for="name in Object.values(settings.classTabs)" :key="name"><code>{{ name }}</code></li></ul>
          <p>Your existing tabs can stay named as shown. Update a mapping above if you rename one.</p>
        </template>
        <p v-else>Inside {{ settings.destinationFolder }}, use <strong>{{ settings.valuableTab }}</strong> for valuable items and
          <strong>{{ settings.craftTab }}</strong> for crafting candidates. The optional <strong>{{ settings.reviewTab }}</strong> tab is for manual review.</p>
        <p class="muted">This valuation flow leaves uncertain items in {{ settings.sourceTab }}. Use ordinary writable grid tabs for these destinations.</p>
      </details>
      <ul v-if="validation.length" class="muted"><li v-for="issue in validation" :key="issue">{{ issue }}</li></ul>
      <div class="button-row">
        <button class="button secondary" :disabled="!canRun" @click="save">Save settings</button>
        <button class="button primary" data-test="scan" :disabled="!canRun" @click="run(false)">Scan dump values</button>
        <button class="button primary" data-test="sort" :disabled="!canRun || dryRun" @click="run(true)">Sort valuable items</button>
        <button class="button secondary" data-test="resume-pricing" :disabled="!canResume" @click="resumePricing">Resume saved pricing</button>
        <button class="button danger" :disabled="!running" @click="stop">Stop</button>
      </div>
      <p class="muted">Scan navigates stash tabs and copies item text using game input; it does not transfer items.
        Sort scans and values the items again before moving eligible items. Keep the stash open; use Ctrl+Shift+Esc to stop.</p>
      <p class="muted">Resume saved pricing retries unavailable prices from the saved report using its original league and settings.
        It performs no game input or transfers. Priced, no-comparables, and unsupported results retain their original timestamps, even when expired;
        resuming does not refresh those earlier results.<template v-if="report"> {{ counts.pending }} unavailable items saved for {{ report.league }}.</template></p>
      <p v-if="dryRun" class="inline-notice warning">Dry-run is on. Item transfers are disabled; Scan dump values still reads the game using navigation and clipboard input.</p>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <ul v-if="issues.length" class="inline-notice warning"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
      <pre v-if="log.length" class="valuation-log">{{ log.join("\n") }}</pre>
    </section>

    <section class="card valuation-card" aria-labelledby="valuation-report-title">
      <div class="section-heading"><h2 id="valuation-report-title">All scanned items</h2>
        <button class="button secondary" :disabled="!api" @click="refresh()">Refresh report</button>
      </div>
      <p v-if="!report" class="muted">No valuation report yet. A scan records every readable item, including unpriced items and items left in the dump tab.</p>
      <template v-else>
        <p><strong>{{ report.league }}</strong> · {{ report.sourceTab }} · {{ report.mode }} · <strong>{{ report.status }}</strong>
          · {{ time(report.finishedAt ?? report.startedAt) }} · model {{ report.scoreVersion }}</p>
        <p class="muted">Decisions below were recorded with a threshold above {{ report.settings.minChaos }} chaos,
          crafting score {{ report.settings.minCraftScore }}, and market confidence {{ report.settings.minMarketConfidence }}%.
          Rescan to apply changed settings or refresh old quotes.</p>
        <p v-if="report.league !== settings.league" class="inline-notice warning">This saved report is for {{ report.league }}. Scan {{ settings.league || 'your selected league' }} for current results.</p>
        <p v-if="report.status === 'failed' && report.rows.length === 0" class="inline-notice danger">No item values were established because the source scan failed.</p>
        <p class="report-counts">{{ report.scannedItems }} items scanned · {{ report.rows.length }} rows recorded · {{ counts.priced }} quoted
          · {{ counts.unpriced }} unpriced · {{ counts.limited }} quotes with limited or stale evidence
          · {{ counts.valuable }} valuable · {{ counts.craft }} crafting candidates · {{ counts.review }} need review
          · {{ counts.moved }} moved · {{ counts.failed }} failed</p>
        <p v-if="pricingResume" class="muted" data-test="pricing-progress">Saved pricing: {{ pricingResume.completed }}/{{ pricingResume.total }} selected lookups attempted;
          {{ pricingResume.retained }} earlier quote results retained. Existing transfer receipts and original capture positions are unchanged.</p>
        <p v-if="report.unreadCells.length" class="inline-notice warning">
          Item coverage incomplete: {{ report.unreadCells.length }} unresolved cells. Some items could not be read.
        </p>
        <p v-else-if="pricingResume" class="muted">Saved item coverage: {{ report.rows.length }} previously captured rows. This pricing pass did not scan the game or resolve any unread cells.</p>
        <p v-else-if="['running', 'stopped', 'failed'].includes(report.status)" class="inline-notice warning">
          Item coverage unconfirmed: scan {{ report.status }}; 0 unresolved cells recorded so far.
        </p>
        <p v-else class="muted">Item scan coverage: no unresolved cells were reported.</p>
        <p v-if="counts.unpriced || counts.limited" class="inline-notice warning">Market coverage is incomplete: {{ counts.unpriced }} unpriced items and
          {{ counts.limited }} quotes with insufficient, mismatched, or stale evidence. Unpriced does not mean worthless.</p>
        <details v-if="report.unreadCells.length"><summary>Unresolved cells</summary>
          <ul><li v-for="cell in report.unreadCells" :key="`${cell.row}:${cell.col}`">Row {{ cell.row + 1 }}, column {{ cell.col + 1 }}: {{ cell.reason ?? 'Item could not be read' }}</li></ul>
        </details>
        <ul v-if="report.errors.length" class="inline-notice danger"><li v-for="issue in report.errors" :key="issue">{{ issue }}</li></ul>
        <div class="report-table-wrap">
          <table class="report-table">
            <thead><tr><th>Item and evidence</th><th>Scores</th><th>Estimated chaos</th><th>Recorded decision and movement</th></tr></thead>
            <tbody><tr v-for="row in report.rows" :key="row.id" data-test="valuation-row">
              <td>
                <strong>{{ row.name || row.baseType }}</strong><small>{{ row.baseType }} · {{ row.itemClass }}<template v-if="row.itemLevel !== undefined"> · level {{ row.itemLevel }}</template></small>
                <small v-if="row.row !== undefined && row.col !== undefined">{{ row.sourceTab }} · row {{ row.row + 1 }}, column {{ row.col + 1 }}</small>
                <details><summary>Item text, score factors, and reasons</summary>
                  <pre class="item-text">{{ row.rawText }}</pre>
                  <ul><li v-for="(mod, index) in row.mods" :key="index">{{ mod.text }} — {{ mod.points }} weighted points (multiplier {{ mod.multiplier }})<template v-if="mod.tier"> · heuristic score band {{ mod.tier }}</template><template v-if="mod.observedAffix"> · copied {{ mod.observedAffix.kind }} {{ mod.observedAffix.name }}<template v-if="mod.observedAffix.tier"> · observed tier {{ mod.observedAffix.tier }}</template></template><template v-if="mod.craftTier !== undefined"> · crafting strength band {{ mod.craftTier || 'below 3' }}</template><template v-if="!mod.familyId"> · unrecognized modifier</template></li></ul>
                  <ul><li v-for="(reason, index) in row.reasons" :key="index">{{ reason }}</li></ul>
                  <small>Score model: {{ row.scoreVersion }}</small>
                </details>
              </td>
              <td><span>Gear {{ row.gearScore }}/100</span><small>Craft {{ row.craftScore }}/100</small></td>
              <td>
                <template v-if="row.quote.state === 'priced'">
                  <strong>{{ amount(row.quote.fair) }} chaos</strong><small>Low {{ amount(row.quote.low) }} · high {{ amount(row.quote.high) }}</small>
                </template>
                <strong v-else>Unpriced · {{ row.quote.state }}</strong>
                <small>{{ row.quote.confidence }}% confidence · {{ row.quote.sampleSize }} usable / {{ row.quote.candidateCount }} candidates</small>
                <small>{{ row.quote.provider }} · {{ row.quote.league }}<template v-if="row.quote.cached"> · cached</template></small>
                <small>{{ time(row.quote.fetchedAt) }}</small>
                <small v-if="row.quote.validUntil">Evidence valid until {{ time(row.quote.validUntil) }}</small>
                <small v-for="issue in quoteIssues(row)" :key="issue" class="evidence-warning">{{ issue }}</small>
                <small v-for="(reason, index) in row.quote.reasons" :key="index">{{ reason }}</small>
                <a v-if="tradeLink(row.quote.tradeUrl)" :href="tradeLink(row.quote.tradeUrl)" target="_blank" rel="noopener noreferrer">View comparable search</a>
              </td>
              <td><strong>{{ row.decision }} · {{ row.status }}</strong>
                <small>Planned: {{ row.destination }}</small>
                <small v-if="row.actualDestination">Actual: {{ row.actualDestination }}</small>
                <small v-else-if="row.status === 'stay'">Remains in {{ row.sourceTab }}</small>
                <small v-else>Destination has not been confirmed</small>
              </td>
            </tr></tbody>
          </table>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.valuation-panel, .valuation-card { display: flex; flex-direction: column; gap: 0.9rem; }
.settings-grid, .weights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.8rem; border: 0; padding: 0; }
legend { margin-bottom: 0.7rem; font-weight: 600; }
label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.87rem; }
input, select { min-width: 0; width: 100%; padding: 0.5rem; }
.weights-grid { margin-top: 0.6rem; max-height: 24rem; overflow: auto; padding: 0.2rem; }
summary { cursor: pointer; font-weight: 600; margin-bottom: 0.4rem; }
.tab-names { display: flex; flex-wrap: wrap; gap: 0.5rem 1.2rem; padding-left: 1.2rem; }
.valuation-log { max-height: 14rem; overflow: auto; padding: 0.7rem; background: #11131b; }
.report-counts { font-variant-numeric: tabular-nums; }
.report-table-wrap { overflow: auto; }
.report-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.88rem; }
th, td { padding: 0.8rem; border-bottom: 1px solid #ffffff22; vertical-align: top; min-width: 9rem; }
td:first-child { min-width: 17rem; max-width: 30rem; }
small { display: block; margin-top: 0.25rem; opacity: 0.78; }
td details { margin-top: 0.7rem; }
.item-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8rem; }
.evidence-warning { color: #e6b863; opacity: 1; }
td ul { padding-left: 1rem; }
</style>
