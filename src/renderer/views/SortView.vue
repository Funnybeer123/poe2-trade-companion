<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { FindRecord } from "@core/sortTriage";
import type { StashTabAdminEvent, StashTabAdminStatus } from "@core/stashTabAdmin";
import PriceTableEditor from "../components/PriceTableEditor.vue";
import ValueTierEditor from "../components/ValueTierEditor.vue";
import ViewTabs from "../components/ViewTabs.vue";
import { useGameActions } from "../composables/useGameActions";
import { useRuntimeState } from "../composables/useRuntimeState";
import { getPriceFeedApi, getStashTabAdminApi, type PriceFeedStatusView } from "../services/rendererApi";
import { pricingReadiness } from "../utils/readiness";

const tabs = [
  { id: "run", label: "Run", hint: "Sort & triage" },
  { id: "tiers", label: "Value tiers", hint: "Keep, sell, dump" },
  { id: "prices", label: "Prices", hint: "Local price table" },
] as const;
const tab = ref<string>("run");

const runtime = useRuntimeState();
const { dryRun } = useGameActions();
const api = getStashTabAdminApi();
const available = computed(() => api !== undefined);
const priceFeed = getPriceFeedApi();
/** League, feed age and trade2 budget — the pricing half of readiness. */
const feedStatus = ref<PriceFeedStatusView | undefined>(undefined);

async function refreshFeedStatus(): Promise<void> {
  if (!priceFeed) return;
  try {
    feedStatus.value = await priceFeed.status();
  } catch {
    feedStatus.value = undefined;
  }
}

const status = ref<StashTabAdminStatus>({ running: false, phase: "idle" });
const log = ref<string[]>([]);
const message = ref("");
const finds = ref<FindRecord[]>([]);
const findsLoaded = ref(false);
/** A script launch is in flight — one click at a time. */
const busy = ref(false);

let unsubscribe: (() => void) | undefined;
let disposed = false;

function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

async function refreshFinds(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.finds();
    if (!disposed) finds.value = next ?? [];
  } catch {
    if (!disposed) finds.value = [];
  } finally {
    findsLoaded.value = true;
  }
}

async function refreshStatus(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.status();
    if (!disposed) status.value = next;
  } catch (reason) {
    if (!disposed) message.value = describeError(reason, "The script status could not be read.");
  }
}

onMounted(async () => {
  if (!api) return;
  unsubscribe = api.onEvent((event: StashTabAdminEvent) => {
    if (event.kind === "phase") {
      status.value = { ...status.value, phase: event.phase, running: event.phase !== "idle" };
      if (event.phase === "idle") {
        void refreshFinds();
        void refreshFeedStatus();
      }
    }
    if (event.kind === "error") message.value = event.message;
    if (event.kind === "log") log.value = [...log.value.slice(-249), event.line];
  });
  await refreshStatus();
  await refreshFinds();
  await refreshFeedStatus();
});

onBeforeUnmount(() => {
  disposed = true;
  unsubscribe?.();
});

const findsValue = computed(() =>
  Math.round(
    finds.value.reduce((total, find) => total + (find.estimatedValue ?? 0), 0) * 100,
  ) / 100,
);

function findTime(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : at;
}

async function runScriptKind(kind: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  log.value = [];
  message.value = "";
  try {
    const result = await api.runScript(kind);
    if (!result?.started) {
      message.value = `Could not start ${kind}: ${result?.reason ?? "unknown"}`;
    }
  } catch (reason) {
    message.value = `Could not start ${kind}: ${describeError(reason, "unknown")}`;
  } finally {
    busy.value = false;
  }
  await refreshStatus();
}

async function runSort(): Promise<void> {
  await runScriptKind(dryRun.value ? "sort-gear-dry" : "sort-gear");
}

async function runCraft(): Promise<void> {
  await runScriptKind(dryRun.value ? "craft-gear-dry" : "craft-gear");
}

async function stopScript(): Promise<void> {
  if (!api) return;
  try {
    await api.stopScript();
  } catch (reason) {
    message.value = describeError(reason, "The script could not be stopped.");
  }
  await refreshStatus();
}

const readiness = computed(() => [
  {
    label: "Desktop app",
    ok: runtime.isNative.value,
    detail: runtime.isNative.value
      ? "Game bridge available"
      : "Browser preview cannot send input",
  },
  {
    label: "Client detected",
    ok: runtime.targetDetected.value,
    detail: runtime.targetDetected.value
      ? "Path of Exile window found"
      : "Start Path of Exile 2 first",
  },
  {
    label: "Input armed",
    ok: runtime.isNative.value && !runtime.killLatched.value,
    detail: runtime.killLatched.value
      ? "Emergency stop is latched — re-arm from the top bar"
      : "Ctrl+Shift+Esc stops everything instantly",
  },
  ...pricingReadiness(feedStatus.value),
]);
</script>

<template>
  <div class="sort-workspace">
    <ViewTabs v-model="tab" :tabs="tabs" label="Sort workspace sections" />

    <template v-if="tab === 'run'">
    <section class="card sort-hero">
      <div class="sort-hero-copy">
        <span class="eyebrow">One pass</span>
        <h2>Sort, triage, and route your stash</h2>
        <p>
          The sorter files every item into its class tab. With triage on, each
          bag-load is read item by item first: <strong>keep</strong> and
          <strong>sell</strong> items detour to their tabs, <strong>dump</strong>
          items go to the Dump tab, everything else files normally. Vendoring is
          never automated past staging — a human always confirms the sale.
        </p>
      </div>
      <ul class="readiness" aria-label="Sorting readiness">
        <li v-for="check in readiness" :key="check.label" :class="{ ok: check.ok }">
          <span class="readiness-dot" aria-hidden="true" />
          <span>
            <strong>{{ check.label }}</strong>
            <small>{{ check.detail }}</small>
          </span>
        </li>
      </ul>
    </section>

    <section class="card sort-run" aria-labelledby="sort-run-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Run</span>
          <h2 id="sort-run-title">Gear sort</h2>
        </div>
        <span class="phase-chip">{{ status.phase }}</span>
      </div>
      <p v-if="!available" class="inline-notice warning">
        Sorting needs the desktop app — the browser preview has no game bridge.
        Tier rules and prices in the other tabs still save for later.
      </p>
      <template v-else>
        <p class="muted">
          {{ dryRun ? "Dry-run is on: the sorter plans and overlays without clicking." : "Live run: the sorter moves items." }}
          Numpad during a run:
          <kbd>8</kbd> good · <kbd>9</kbd> wrong (then show the right spot) ·
          <kbd>5</kbd> pause · <kbd>0</kbd> stop.
        </p>
        <div class="button-row">
          <button
            type="button"
            class="button primary"
            :disabled="busy || status.running"
            @click="runSort"
          >
            {{ dryRun ? "Preview gear sort" : "Sort gear" }}
          </button>
          <button
            type="button"
            class="button danger"
            :disabled="!status.running"
            @click="stopScript"
          >
            Stop
          </button>
        </div>
        <p v-if="message" class="inline-notice danger" role="alert">{{ message }}</p>
        <pre v-if="log.length" class="sort-log">{{ log.join("\n") }}</pre>
        <p class="muted">
          Need tab naming, calibration, or transfers? They live in
          <RouterLink to="/tools/stash-tabs">Tools → Stash tabs</RouterLink> and
          <RouterLink to="/tools/calibration">Tools → Calibration</RouterLink>.
        </p>
      </template>
    </section>

    <section v-if="available" class="card sort-run" aria-labelledby="craft-run-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Craft</span>
          <h2 id="craft-run-title">Value crafting</h2>
        </div>
      </div>
      <p class="muted">
        Reads every item in the bag, scores it against the mod knowledge base,
        and applies only additive orbs (transmute → augment → regal → exalt)
        when a step is profitable at high confidence. Removal orbs, divines,
        and corruption are always left as printed recommendations.
        {{ dryRun ? "Dry-run prints each item's plan without touching the game." : "Live mode applies orbs from the bag one step at a time." }}
      </p>
      <p class="muted craft-loop-hint">
        Craft-to-sell loop: set a <strong>Craft tab</strong> under Value tiers
        and the sorter parks sparse rares with a strong roll there. From the
        CLI, <code>npx tsx scripts/craft-gear.ts --from-tab=Craft</code> pulls
        that tab into the bag before crafting, and <code>--then-list</code>
        hands the bag to <code>shop-buckets</code> afterwards (dry-run unless
        the craft run itself is live, and only when no other input host is
        running).
      </p>
      <div class="button-row">
        <button
          type="button"
          class="button primary"
          :disabled="busy || status.running"
          @click="runCraft"
        >
          {{ dryRun ? "Preview crafting" : "Craft gear" }}
        </button>
        <button
          type="button"
          class="button danger"
          :disabled="!status.running"
          @click="stopScript"
        >
          Stop
        </button>
      </div>
    </section>

    <section v-if="available" class="card finds-card" aria-labelledby="finds-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Wealth</span>
          <h2 id="finds-title">Recent finds</h2>
        </div>
        <div class="finds-heading-right">
          <span v-if="findsValue > 0" class="finds-total">≈ {{ findsValue }} exalted logged</span>
          <button type="button" class="button compact secondary" @click="refreshFinds">
            Refresh
          </button>
        </div>
      </div>
      <p v-if="findsLoaded && finds.length === 0" class="muted">
        Nothing logged yet. Finds appear here whenever a sort run detours a
        confident keep or sell to its triage tab.
      </p>
      <ul v-else class="finds-list">
        <li v-for="(find, index) in finds.slice(0, 25)" :key="`${find.at}-${index}`">
          <span class="find-tier" :class="find.tier">{{ find.tier }}</span>
          <span class="find-copy">
            <strong>{{ find.name }}</strong>
            <small>
              {{ find.itemClass }} · from {{ find.location }} → {{ find.routedTo }}
              · {{ findTime(find.at) }}
            </small>
          </span>
          <span class="find-metrics">
            <template v-if="find.valueScore !== undefined">
              <strong>{{ find.valueScore }}</strong>/100
              <small>{{ find.confidence }}% conf.</small>
            </template>
            <template v-if="find.estimatedValue !== undefined">
              <em>≈ {{ find.estimatedValue }} {{ find.currency }}</em>
            </template>
          </span>
        </li>
      </ul>
    </section>
    </template>

    <ValueTierEditor v-else-if="tab === 'tiers'" />
    <PriceTableEditor v-else />
  </div>
</template>

<style scoped>
.sort-workspace { display: flex; flex-direction: column; gap: 1rem; }
.sort-hero { display: flex; flex-wrap: wrap; gap: 1.25rem; justify-content: space-between; }
.sort-hero-copy { max-width: 42rem; display: flex; flex-direction: column; gap: 0.4rem; }
.readiness { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; min-width: 16rem; }
.readiness li { display: flex; gap: 0.6rem; align-items: flex-start; }
.readiness li span:last-child { display: flex; flex-direction: column; }
.readiness small { opacity: 0.7; }
.readiness-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; background: #b35050; margin-top: 0.35rem; flex: none; }
.readiness li.ok .readiness-dot { background: #4fa84f; }
.sort-run { display: flex; flex-direction: column; gap: 0.75rem; }
.phase-chip { font-variant: small-caps; opacity: 0.75; }
.sort-log { max-height: 16rem; overflow: auto; background: rgba(10, 10, 16, 0.65); padding: 0.6rem; border-radius: 0.4rem; font-size: 0.8em; }
.craft-loop-hint code { font-size: 0.85em; }
.finds-card { display: flex; flex-direction: column; gap: 0.7rem; }
.finds-heading-right { display: flex; align-items: center; gap: 0.7rem; }
.finds-total { font-size: 0.85rem; opacity: 0.85; }
.finds-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
.finds-list li { display: flex; gap: 0.7rem; align-items: flex-start; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.55rem; }
.find-tier { flex: none; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; padding: 0.15rem 0.5rem; border-radius: 0.3rem; border: 1px solid rgba(140, 140, 160, 0.4); margin-top: 0.15rem; }
.find-tier.keep { border-color: #4fa84f; color: #7dd87d; }
.find-tier.sell { border-color: #c9a227; color: #e0c46a; }
.find-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.find-copy small { opacity: 0.65; }
.find-metrics { flex: none; text-align: right; display: flex; flex-direction: column; font-size: 0.85rem; }
.find-metrics small { opacity: 0.65; }
.find-metrics em { font-style: normal; color: #e0c46a; }
</style>
