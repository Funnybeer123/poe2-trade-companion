<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRaw } from "vue";
import { HELPER_LEAGUES, HELPER_THEMES, helperDefaults, type HelperConfig, type HelperRow, type HelperStatus } from "@core/priceHelper";

const api = window.poe2?.priceHelper;
const status = ref<HelperStatus>();
const settings = ref<HelperConfig>(helperDefaults());
const busy = ref(false), error = ref(""), text = ref("");
const results = ref<HelperRow[]>([]);
let timer: ReturnType<typeof setInterval> | undefined, unmounted = false, polling = false;
async function poll(): Promise<void> {
  if (!api || polling || busy.value) return;
  polling = true;
  try { const next = await api.status(); if (!unmounted) { status.value = next; if (results.value.length && text.value.trim()) results.value = await api.lookup(text.value); } }
  catch { if (!unmounted) error.value = "Could not reach the price helper. Reopen the companion."; }
  finally { polling = false; }
}
async function run(action: "refresh" | "refreshRumours" | "calibrate" | "start" | "stop" | "save"): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true; error.value = "";
  try {
    const next = action === "save" ? await api.configure(JSON.parse(JSON.stringify(settings.value))) : await api[action]();
    status.value = next; settings.value = structuredClone(next.config);
    if (action === "save") results.value = [];
    else if (text.value.trim()) results.value = await api.lookup(text.value);
  } catch (e) { error.value = e instanceof Error ? e.message : "Price helper request failed."; }
  finally { busy.value = false; }
}
async function lookup(): Promise<void> {
  if (!api) return;
  try { error.value = ""; results.value = await api.lookup(text.value); }
  catch (e) { error.value = e instanceof Error ? e.message : "Lookup failed."; }
}
async function stopNow(): Promise<void> {
  try { if (api) status.value = await api.stop(); }
  catch { error.value = "Could not stop the helper. Use Ctrl+Shift+Esc or quit the app."; }
}
function priceClass(row: HelperRow): string | undefined {
  return row.state === "priced" && !row.stale && row.valueTier ? `value-${row.valueTier}` : undefined;
}
function stamp(value?: string): string { return value ? new Date(value).toLocaleString() : "Not loaded"; }
function stale(value?: string): boolean { return Boolean(value && Date.now() - Date.parse(value) >= 30 * 60_000); }
onMounted(async () => {
  await poll();
  if (status.value) settings.value = structuredClone(toRaw(status.value.config));
  if (!unmounted) timer = setInterval(() => void poll(), 1000);
});
onBeforeUnmount(() => { unmounted = true; if (timer) clearInterval(timer); });
</script>

<template>
  <section class="price-helper card" :style="{ '--helper-accent': HELPER_THEMES[settings.theme] }">
    <div class="helper-heading">
      <div><p class="eyebrow">Read-only companion</p><h2>Price helper</h2></div>
      <span class="helper-badge">{{ status?.running ? 'Scanning on' : 'Scanning off' }}</span>
    </div>
    <p>Read exchange and reward lists with local Windows OCR. See stack totals beside each row, or look up Island Rumour maps and community ratings.</p>
    <p v-if="!api" role="status">Open the desktop companion to use live prices and screen recognition.</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-for="issue in status?.hotkeyErrors ?? []" :key="issue" role="status">{{ issue }}</p>
    <fieldset :disabled="busy || !api" class="helper-settings">
      <legend>Settings</legend>
      <label>League <input v-model="settings.league" list="helper-leagues" maxlength="80" @change="run('save')" /></label>
      <datalist id="helper-leagues"><option v-for="league in HELPER_LEAGUES" :key="league" :value="league" /></datalist>
      <label>List type <select v-model="settings.mode" @change="run('save')"><option value="prices">Item prices</option><option value="rumours">Island Rumours</option></select></label>
      <label>Overlay theme <select v-model="settings.theme" @change="run('save')"><option v-for="(_, theme) in HELPER_THEMES" :key="theme" :value="theme">{{ theme }}</option></select></label>
      <label class="check"><input v-model="settings.autoRefresh" type="checkbox" @change="run('save')" /> Refresh prices every 30 minutes</label>
      <label class="check"><input v-model="settings.debug" type="checkbox" @change="run('save')" /> Show recognized text in overlay</label>
      <label class="check"><input v-model="settings.minimizeToTray" type="checkbox" @change="run('save')" /> Minimize to tray</label>
    </fieldset>
    <div class="helper-actions">
      <button :disabled="busy || !api || status?.refreshing" @click="run(settings.mode === 'prices' ? 'refresh' : 'refreshRumours')">{{ settings.mode === 'prices' ? 'Refresh prices' : 'Refresh rumour sheet' }}</button>
      <button :disabled="busy || !api" @click="run('calibrate')">Calibrate list region</button>
      <button :disabled="busy || !api || status?.running" class="primary" @click="run('start')">Start scanning</button>
      <button :disabled="!api" @click="stopNow">Stop / hide</button>
    </div>
    <p class="helper-status" role="status">{{ busy ? 'Working…' : status?.message ?? 'Loading helper…' }}</p>
    <p class="helper-hint">{{ settings.regions[settings.mode] ? 'Region saved for this list.' : 'No region saved for this list.' }} Open the game list, choose Calibrate, and drag around names and quantities. Leave room beside it for prices.</p>
    <p class="helper-hint">Ctrl+Shift+F5 starts/stops · Ctrl+Shift+F4 calibrates · Ctrl+Shift+F3 shows recognized text. Esc or Ctrl+click detected during a scan stops the overlay. Ctrl+Shift+Esc stops all activity.</p>
    <p v-if="settings.mode === 'prices'" class="helper-hint helper-value-legend" aria-label="Price highlight legend"><span class="value-high">Gold ≥ 1 divine</span> · <span class="value-very-high">Pink ≥ 10 divine</span>. Based on the stack total, or the per-item estimate when quantity is unreadable.</p>
    <div v-if="settings.mode === 'prices'" class="helper-feeds" aria-label="Price category freshness">
      <div v-for="category in status?.categories ?? []" :key="category.category" class="helper-feed" :class="{ stale: category.error || stale(category.fetchedAt) }">
        <strong>{{ category.category === 'UncutGems' ? 'Uncut gems' : category.category }}</strong>
        <span>{{ category.count }} items{{ category.error || stale(category.fetchedAt) ? ' · stale / unavailable' : '' }}</span>
        <small>{{ stamp(category.fetchedAt) }}</small>
        <small v-if="category.error">{{ category.error }}</small>
      </div>
    </div>
    <p v-else>{{ status?.rumourCount ?? 0 }} community rumours · {{ stamp(status?.rumoursFetchedAt) }}. Ratings are community opinions and may change with patches.</p>
    <div class="helper-lookup">
      <label for="helper-input">{{ settings.mode === 'prices' ? 'Check an item list' : 'Check rumour names' }}</label>
      <textarea id="helper-input" v-model="text" rows="4" maxlength="30000" :placeholder="settings.mode === 'prices' ? '2x Divine Orb\nUncut Skill Gem (Level 19)\nExalted Orb (10)' : 'Fallen Stars\nCold as ice'" />
      <button :disabled="busy || !api || !text.trim()" @click="lookup">Look up list</button>
    </div>
    <div v-if="results.length || status?.rows.length" class="helper-results">
      <table><thead><tr><th>Item / rumour</th><th>Estimate / details</th></tr></thead><tbody>
        <tr v-for="(row, i) in results.length ? results : status?.rows ?? []" :key="i"><td>{{ row.name ?? row.text }} <small v-if="row.quantity && row.quantity > 1">×{{ row.quantity }}</small></td><td :class="[{ stale: row.stale }, priceClass(row)]">{{ row.detail }}<small v-if="row.state === 'rumour' && row.stale"> · old cached sheet</small></td></tr>
      </tbody></table>
    </div>
    <p class="helper-hint">Prices are poe.ninja market estimates, not guaranteed sale prices. Unknown items and unreadable gem levels show “?”. Capture pauses when the game loses focus; screenshots stay in memory on this PC. English item text is required. Start is always manual after reopening the app.</p>
  </section>
</template>

<style scoped>
.price-helper{display:grid;gap:16px;--helper-accent:#86efac}.helper-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.helper-heading h2,.helper-heading p,.price-helper>p{margin:0}.helper-badge{padding:6px 12px;border:1px solid var(--helper-accent);color:var(--helper-accent);border-radius:20px;font-size:12px;white-space:nowrap}.helper-settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;border:1px solid #313946;border-radius:8px;padding:16px}.helper-settings label{display:grid;gap:6px;min-width:0}.helper-settings input,.helper-settings select{width:100%;min-width:0}.helper-settings .check{display:flex;align-items:center;font-size:12px}.check input{width:auto}.helper-actions{display:flex;flex-wrap:wrap;gap:8px}.helper-status{color:var(--helper-accent);padding:12px;background:#ffffff06;border-radius:6px}.helper-hint{font-size:12px;color:#a4afbd;line-height:1.6}.helper-feeds{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px}.helper-feed{display:grid;gap:5px;border:1px solid #313946;padding:12px;border-radius:6px;font-size:12px}.helper-feed small{font-size:10px}.helper-lookup{display:grid;gap:8px}.helper-lookup textarea{resize:vertical;min-height:95px}.helper-lookup button{justify-self:start}.helper-results{overflow:auto}.helper-results table{width:100%;font-size:13px}.helper-results td,.helper-results th{padding:10px;text-align:left;border-bottom:1px solid #ffffff12}.value-high{color:#facc15}.value-very-high{color:#f472b6}.stale{color:#fbbf24}.error{color:#fca5a5}@media(max-width:850px){.helper-settings{grid-template-columns:1fr 1fr}}
</style>
