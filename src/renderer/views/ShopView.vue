<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { StashTabAdminEvent, StashTabAdminStatus } from "@core/stashTabAdmin";
import { useGameActions } from "../composables/useGameActions";
import {
  getShopApi,
  getStashTabAdminApi,
  type ShopConfigView,
  type ShopOverviewView,
} from "../services/rendererApi";

const { dryRun } = useGameActions();
const shopApi = getShopApi();
const tabsApi = getStashTabAdminApi();
const available = computed(() => shopApi !== undefined && tabsApi !== undefined);

const overview = ref<ShopOverviewView>({});
const status = ref<StashTabAdminStatus>({ running: false, phase: "idle" });
const log = ref<string[]>([]);
const message = ref("");
const saveNote = ref("");
const stepTeach = ref(false);

/** Editable copy of the config (saved back to artifacts/tab-admin/shop.json). */
const config = ref<ShopConfigView | undefined>(undefined);

let unsubscribe: (() => void) | undefined;

async function refresh(): Promise<void> {
  if (!shopApi) return;
  const next = await shopApi.overview();
  overview.value = next;
  if (next.config) config.value = { ...next.config, maxAutoList: { ...next.config.maxAutoList } };
  if (next.error) message.value = next.error;
}

onMounted(async () => {
  if (!available.value) return;
  unsubscribe = tabsApi!.onEvent((event: StashTabAdminEvent) => {
    if (event.kind === "phase") {
      status.value = { ...status.value, phase: event.phase, running: event.phase !== "idle" };
      if (event.phase === "idle") void refresh();
    }
    if (event.kind === "error") message.value = event.message;
    if (event.kind === "log") log.value = [...log.value.slice(-249), event.line];
  });
  status.value = await tabsApi!.status();
  await refresh();
});

onBeforeUnmount(() => unsubscribe?.());

const configured = computed(() => Boolean(config.value?.shopTab?.trim()));
/** Bucket tabs as one editable line ("1Ex, 5Ex, 1D"). */
const bucketTabsText = computed({
  get: () => (config.value?.bucketTabs ?? []).join(", "),
  set: (text: string) => {
    if (!config.value) return;
    config.value.bucketTabs = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
});
const listings = computed(() => overview.value.state ?? []);
const plan = computed(() => overview.value.plan ?? null);
const stats = computed(() => overview.value.stats ?? []);
const realizedTotal = computed(
  () => Math.round(stats.value.reduce((sum, entry) => sum + entry.realizedExalted, 0) * 100) / 100,
);

function ageDays(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? `${Math.max(0, ms / 86_400_000).toFixed(1)}d` : "?";
}

async function runScriptKind(kind: string): Promise<void> {
  if (!tabsApi) return;
  log.value = [];
  message.value = "";
  const result = await (
    tabsApi as unknown as { runScript(k: string): Promise<{ started: boolean; reason?: string }> }
  ).runScript(kind);
  if (!result?.started) {
    message.value = `Could not start ${kind}: ${result?.reason ?? "unknown"}`;
  }
  status.value = await tabsApi.status();
}

async function runScan(): Promise<void> {
  await runScriptKind(dryRun.value ? "shop-scan-dry" : "shop-scan");
}

async function runApply(): Promise<void> {
  await runScriptKind(stepTeach.value ? "shop-apply-step" : "shop-apply");
}

async function runList(): Promise<void> {
  await runScriptKind(dryRun.value ? "shop-buckets-dry" : "shop-buckets");
}

async function stopScript(): Promise<void> {
  if (!tabsApi) return;
  await (tabsApi as unknown as { stopScript(): Promise<boolean> }).stopScript();
  status.value = await tabsApi.status();
}

async function saveConfig(): Promise<void> {
  if (!shopApi || !config.value) return;
  saveNote.value = "";
  const result = await shopApi.saveConfig(config.value);
  config.value = { ...result.config, maxAutoList: { ...result.config.maxAutoList } };
  saveNote.value = result.issues.length > 0 ? result.issues.join("; ") : "Saved.";
  await refresh();
}
</script>

<template>
  <div class="shop-workspace">
    <section class="card shop-hero">
      <div class="shop-hero-copy">
        <span class="eyebrow">Public tab</span>
        <h2>Shop listings</h2>
        <p>
          One designated public tab; the Ctrl+C <strong>Note</strong> line is the
          listing's ground truth. Scans diff the tab against the ledger (sold
          items are the payoff data), the plan reprices stale listings on a
          ladder, and hand-priced listings stay read-only. Whisper responses and
          the trade window are never automated.
        </p>
      </div>
      <ul class="shop-summary" aria-label="Shop summary">
        <li><strong>{{ listings.length }}</strong><small>active listings</small></li>
        <li><strong>{{ overview.scan?.freeCells ?? "—" }}</strong><small>free cells</small></li>
        <li><strong>≈{{ realizedTotal }}</strong><small>ex realized (ledger)</small></li>
      </ul>
    </section>

    <p v-if="!available" class="inline-notice warning">
      The shop needs the desktop app — the browser preview has no game bridge.
    </p>

    <template v-else>
      <section class="card shop-run" aria-labelledby="shop-run-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Run</span>
            <h2 id="shop-run-title">Scan · plan · apply</h2>
          </div>
          <span class="phase-chip">{{ status.phase }}</span>
        </div>
        <p v-if="!configured" class="inline-notice warning">
          Set the shop tab's exact name below first — the feature refuses to run without it.
        </p>
        <p class="muted">
          {{ dryRun
            ? "Dry-run is on: scans read the tab and print the plan; the ledger is untouched and nothing is clicked."
            : "Dry-run is off: scans RECORD the reconcile (sold detection) to the ledger." }}
          Numpad during a run: <kbd>8</kbd> good · <kbd>9</kbd> wrong · <kbd>5</kbd> pause · <kbd>0</kbd> stop.
        </p>
        <div class="button-row">
          <button type="button" class="button primary" :disabled="status.running || !configured" @click="runScan">
            {{ dryRun ? "Scan shop (dry-run)" : "Scan + record" }}
          </button>
          <button
            type="button"
            class="button"
            :disabled="status.running || !configured || dryRun"
            :title="dryRun ? 'Turn the global dry-run off to apply' : ''"
            @click="runApply"
          >
            Apply plan (live)
          </button>
          <button
            type="button"
            class="button"
            :disabled="status.running"
            :title="dryRun ? 'Prices the bag and prints where each item would go' : 'Lists every bag item in its bucket tab'"
            @click="runList"
          >
            {{ dryRun ? "Price the bag → bucket plan (dry-run)" : "List bag into bucket tabs (live)" }}
          </button>
          <button type="button" class="button danger" :disabled="!status.running" @click="stopScript">
            Stop
          </button>
        </div>
        <label class="step-toggle">
          <input v-model="stepTeach" type="checkbox" />
          Step mode on apply (REQUIRED for the first live run — teaches the price dialog's controls)
        </label>
        <p v-if="message" class="inline-notice danger" role="alert">{{ message }}</p>
        <pre v-if="log.length" class="shop-log">{{ log.join("\n") }}</pre>
      </section>

      <section class="card" aria-labelledby="shop-listings-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Ledger</span>
            <h2 id="shop-listings-title">Current listings</h2>
          </div>
          <button type="button" class="button compact secondary" @click="refresh">Refresh</button>
        </div>
        <p v-if="listings.length === 0" class="muted">
          No ledger entries yet — run a scan; existing hand-priced listings are adopted as read-only.
        </p>
        <ul v-else class="listing-list">
          <li v-for="listing in listings" :key="listing.fingerprint">
            <span class="listing-copy">
              <strong>{{ listing.count > 1 ? `${listing.count}x ` : "" }}{{ listing.name }}</strong>
              <small>{{ listing.itemClass }} · listed {{ ageDays(listing.listedAt) }} ago · priced {{ ageDays(listing.pricedAt) }} ago</small>
            </span>
            <span class="listing-price">
              <template v-if="listing.price">
                {{ listing.price.amount }} {{ listing.price.currency }}
                <small v-if="listing.price.exalted !== undefined">≈{{ listing.price.exalted }} ex</small>
              </template>
              <template v-else>unpriced</template>
            </span>
            <span class="listing-badge" :class="listing.by">{{ listing.by === "app" ? "auto" : listing.by }}</span>
          </li>
        </ul>
      </section>

      <section v-if="plan" class="card" aria-labelledby="shop-plan-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Latest plan</span>
            <h2 id="shop-plan-title">{{ plan.actions.length }} action(s), {{ plan.holds.length }} hold(s)</h2>
          </div>
          <small class="muted">{{ plan.at }}</small>
        </div>
        <ul class="plan-list">
          <li v-for="(action, index) in plan.actions" :key="`a-${index}`">
            <span class="plan-kind" :class="action.kind">{{ action.kind }}</span>
            <span class="listing-copy">
              <strong>{{ action.name }}</strong>
              <small>
                {{ action.from ? `${action.from.amount} ${action.from.currency}` : "unpriced" }}
                <template v-if="action.to"> → {{ action.to.amount }} {{ action.to.currency }} (≈{{ action.to.exalted }} ex)</template>
                <template v-if="action.badges.length"> · {{ action.badges.join(", ") }}</template>
              </small>
              <small v-if="action.reasons[0]" class="reason">{{ action.reasons[0] }}</small>
            </span>
          </li>
          <li v-for="(hold, index) in plan.holds" :key="`h-${index}`">
            <span class="plan-kind hold">hold</span>
            <span class="listing-copy">
              <strong>{{ hold.name }}</strong>
              <small v-if="hold.badges.length">{{ hold.badges.join(", ") }}</small>
              <small v-if="hold.reasons[0]" class="reason">{{ hold.reasons[0] }}</small>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="stats.length > 0" class="card" aria-labelledby="shop-sales-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Feedback loop</span>
            <h2 id="shop-sales-title">Realized sales by class</h2>
          </div>
        </div>
        <p class="muted">
          Classes that actually sell deserve higher value-tier scores; chronic
          no-sells deserve lower ones. Edit the tiers on the Sort screen.
        </p>
        <ul class="stats-list">
          <li v-for="entry in stats" :key="entry.itemClass">
            <strong>{{ entry.itemClass }}</strong>
            <small>
              {{ entry.sold }} sold / {{ entry.listed }} listed ({{ entry.delisted }} delisted)
              · {{ entry.realizedExalted }} ex realized
              <template v-if="entry.medianDaysToSale !== undefined"> · median {{ entry.medianDaysToSale }}d to sale</template>
            </small>
          </li>
        </ul>
      </section>

      <section v-if="config" class="card shop-config" aria-labelledby="shop-config-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Settings</span>
            <h2 id="shop-config-title">Shop configuration</h2>
          </div>
        </div>
        <div class="config-grid">
          <label>
            Shop tab (exact name)
            <input v-model="config.shopTab" type="text" placeholder="e.g. Shop" />
          </label>
          <label>
            Return tab for delists
            <input v-model="config.returnTab" type="text" />
          </label>
          <label>
            Bucket tabs (the tab name is its price)
            <input v-model="bucketTabsText" type="text" placeholder="1Ex, 5Ex, 10Ex, 1D, 2D, 3D, 5D" />
          </label>
          <label>
            Undercut %
            <input v-model.number="config.undercutPercent" type="number" min="0" max="90" />
          </label>
          <label>
            Stale after (days)
            <input v-model.number="config.staleDays" type="number" min="0.5" step="0.5" />
          </label>
          <label>
            Confirm-above cap
            <span class="cap-row">
              <input v-model.number="config.maxAutoList.amount" type="number" min="0" />
              <select v-model="config.maxAutoList.currency">
                <option value="divine">divine</option>
                <option value="exalted">exalted</option>
              </select>
            </span>
          </label>
        </div>
        <details class="expert">
          <summary>Expert options</summary>
          <div class="config-grid">
            <label>
              Comps percentile
              <input v-model.number="config.compsPercentile" type="number" min="1" max="50" />
            </label>
            <label>
              Min comps count
              <input v-model.number="config.minCompsCount" type="number" min="1" max="20" />
            </label>
            <label>
              Min listing confidence
              <input v-model.number="config.minListConfidence" type="number" min="0" max="100" />
            </label>
            <label>
              Delist floor (exalted)
              <input v-model.number="config.delistFloorExalted" type="number" min="0" />
            </label>
            <label>
              Max actions per run
              <input v-model.number="config.maxActionsPerRun" type="number" min="1" max="200" />
            </label>
            <label>
              Underpriced at +%
              <input v-model.number="config.underpricedPercent" type="number" min="5" max="500" />
            </label>
          </div>
          <p class="muted">
            The reprice ladder and item sources live in
            <code>artifacts/tab-admin/shop.json</code> — the CLI and this screen share it.
          </p>
        </details>
        <div class="button-row">
          <button type="button" class="button primary" @click="saveConfig">Save settings</button>
          <span v-if="saveNote" class="muted">{{ saveNote }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.shop-workspace { display: flex; flex-direction: column; gap: 1rem; }
.shop-hero { display: flex; flex-wrap: wrap; gap: 1.25rem; justify-content: space-between; }
.shop-hero-copy { max-width: 42rem; display: flex; flex-direction: column; gap: 0.4rem; }
.shop-summary { list-style: none; margin: 0; padding: 0; display: flex; gap: 1.4rem; align-items: center; }
.shop-summary li { display: flex; flex-direction: column; align-items: center; }
.shop-summary strong { font-size: 1.4rem; }
.shop-summary small { opacity: 0.65; }
.shop-run { display: flex; flex-direction: column; gap: 0.75rem; }
.phase-chip { font-variant: small-caps; opacity: 0.75; }
.step-toggle { display: flex; gap: 0.5rem; align-items: center; font-size: 0.85rem; opacity: 0.85; }
.shop-log { max-height: 16rem; overflow: auto; background: rgba(10, 10, 16, 0.65); padding: 0.6rem; border-radius: 0.4rem; font-size: 0.8em; }
.listing-list, .plan-list, .stats-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
.listing-list li, .plan-list li { display: flex; gap: 0.7rem; align-items: flex-start; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.55rem; }
.listing-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.listing-copy small { opacity: 0.65; }
.listing-copy .reason { opacity: 0.5; }
.listing-price { flex: none; text-align: right; display: flex; flex-direction: column; }
.listing-price small { opacity: 0.65; }
.listing-badge { flex: none; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; padding: 0.15rem 0.5rem; border-radius: 0.3rem; border: 1px solid rgba(140, 140, 160, 0.4); margin-top: 0.15rem; }
.listing-badge.app { border-color: #4fa84f; color: #7dd87d; }
.listing-badge.user { border-color: #c9a227; color: #e0c46a; }
.plan-kind { flex: none; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; padding: 0.15rem 0.5rem; border-radius: 0.3rem; border: 1px solid rgba(140, 140, 160, 0.4); margin-top: 0.15rem; }
.plan-kind.reprice { border-color: #c9a227; color: #e0c46a; }
.plan-kind.delist { border-color: #b35050; color: #e08a8a; }
.plan-kind.price-unpriced { border-color: #4fa84f; color: #7dd87d; }
.stats-list li { display: flex; flex-direction: column; }
.stats-list small { opacity: 0.65; }
.shop-config { display: flex; flex-direction: column; gap: 0.75rem; }
.config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; }
.config-grid label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
.cap-row { display: flex; gap: 0.4rem; }
.cap-row input { flex: 1; min-width: 0; }
.expert summary { cursor: pointer; opacity: 0.8; }
.expert { border-top: 1px solid rgba(140, 140, 160, 0.15); padding-top: 0.6rem; }
</style>
