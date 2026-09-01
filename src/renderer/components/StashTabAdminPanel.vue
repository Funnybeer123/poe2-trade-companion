<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  GEAR_SLOT_TABS,
  colourByName,
  type StashTabAdminEvent,
  type StashTabAdminStatus,
  type StashTabApplyOutcome,
  type StashTabPlan,
  type SurveyedStashTab,
} from "@core/stashTabAdmin";
import { useGameActions } from "../composables/useGameActions";
import { getStashTabAdminApi } from "../services/rendererApi";

const { dryRun } = useGameActions();
const api = getStashTabAdminApi();
const available = computed(() => api !== undefined);

const status = ref<StashTabAdminStatus>({ running: false, phase: "idle" });
const folderName = ref("Gear");
const requireQuad = ref(false);
const allowPricedTabs = ref(false);
const tabs = ref<SurveyedStashTab[]>([]);
const plan = ref<StashTabPlan | undefined>();
const planErrors = ref<string[]>([]);
const outcomes = ref<StashTabApplyOutcome[]>([]);
const log = ref<string[]>([]);
const message = ref("");
const busy = ref(false);

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  if (!api) return;
  unsubscribe = api.onEvent((event: StashTabAdminEvent) => {
    if (event.kind === "phase") status.value = { ...status.value, phase: event.phase, running: event.phase !== "idle" };
    if (event.kind === "tab") tabs.value = [...tabs.value.filter((tab) => tab.label !== event.tab.label), event.tab];
    if (event.kind === "applied") outcomes.value = [...outcomes.value, event.outcome];
    if (event.kind === "error") message.value = event.message;
    if (event.kind === "log") log.value = [...log.value.slice(-199), event.line];
  });
  status.value = await api.status();
});

onBeforeUnmount(() => unsubscribe?.());

async function run<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
  if (!api) return undefined;
  busy.value = true;
  message.value = "";
  try {
    return await work();
  } catch (error) {
    message.value = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  } finally {
    busy.value = false;
    status.value = await api.status();
  }
}

async function survey() {
  outcomes.value = [];
  plan.value = undefined;
  const result = await run("Survey", () => api!.survey(folderName.value));
  if (result) tabs.value = result.tabs;
}

async function buildPlan() {
  const result = await run("Plan", () =>
    api!.plan({
      tabs: tabs.value,
      requireQuad: requireQuad.value,
      allowPricedTabs: allowPricedTabs.value,
    }),
  );
  if (result) {
    plan.value = result.plan;
    planErrors.value = result.errors;
  }
}

async function runScript(kind: string) {
  log.value = [];
  message.value = "";
  const result = await (api as unknown as { runScript(k: string): Promise<{ started: boolean; reason?: string }> }).runScript(kind);
  if (!result?.started) message.value = `could not start ${kind}: ${result?.reason ?? "unknown"}`;
  status.value = await api!.status();
}

async function stopScript() {
  await (api as unknown as { stopScript(): Promise<boolean> }).stopScript();
  status.value = await api!.status();
}

async function apply() {
  if (!plan.value) return;
  outcomes.value = [];
  const result = await run(dryRun.value ? "Dry run" : "Apply", () =>
    api!.apply({ plan: plan.value!, dryRun: dryRun.value, allowPricedTabs: allowPricedTabs.value }),
  );
  if (result) outcomes.value = result;
}

const editableCount = computed(
  () => tabs.value.filter((tab) => (allowPricedTabs.value ? !tab.removeOnly : tab.editable)).length,
);
const shortfall = computed(() => Math.max(0, GEAR_SLOT_TABS.length - editableCount.value));

function swatch(colourName: string): string {
  return colourByName(colourName)?.hex ?? "transparent";
}
</script>

<template>
  <section class="stash-tab-admin">
    <header>
      <h2>Stash tabs</h2>
      <p class="hint">
        Renames and recolours one stash tab per equipment slot. Remove-only tabs
        are never touched; priced (<code>~price …</code>) tabs only with the opt-in below.
      </p>
    </header>

    <p v-if="!available" class="warn">
      Stash tab administration needs the desktop app — the browser preview has no game bridge.
    </p>

    <template v-else>
      <div class="controls">
        <label>
          Folder
          <input v-model="folderName" type="text" :disabled="busy" />
        </label>
        <label class="check">
          <input v-model="requireQuad" type="checkbox" :disabled="busy" />
          Quad tabs only
        </label>
        <label class="check danger" title="Renaming a ~price tab removes its public price and delists the items inside.">
          <input v-model="allowPricedTabs" type="checkbox" :disabled="busy" />
          Allow priced tabs
        </label>
        <button :disabled="busy" @click="survey">Survey folder</button>
        <button :disabled="busy || tabs.length === 0" @click="buildPlan">Build plan</button>
        <button
          :class="{ danger: !dryRun }"
          :disabled="busy || !plan || (!dryRun && planErrors.length > 0)"
          @click="apply"
        >
          {{ dryRun ? "Apply (dry-run)" : "Apply" }}
        </button>
        <span class="phase">{{ status.phase }}</span>
      </div>

      <div class="controls">
        <button :disabled="busy || status.running" @click="runScript(dryRun ? 'renumber-dry' : 'renumber')">
          {{ dryRun ? "Renumber T1…Tn (dry-run)" : "Renumber T1…Tn" }}
        </button>
        <button :disabled="busy || status.running" @click="runScript('finish-gear')">Name gear tabs</button>
        <button :disabled="!status.running" @click="stopScript">Stop</button>
      </div>

      <pre v-if="log.length" class="log">{{ log.join("\n") }}</pre>

      <p v-if="allowPricedTabs" class="warn">
        Priced tabs are opted in: renaming one removes its public price and delists
        the items inside. Rename it back to <code>~price N currency</code> to restore.
      </p>
      <p v-if="message" class="warn">{{ message }}</p>

      <table v-if="tabs.length" class="tabs">
        <thead>
          <tr><th>Tab</th><th>Grid</th><th>Used</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr v-for="tab in tabs" :key="tab.label">
            <td>{{ tab.label }}</td>
            <td>{{ tab.gridCols === 24 ? "quad" : tab.gridCols ? `${tab.gridCols}-wide` : "—" }}</td>
            <td>{{ tab.occupiedCells ?? "—" }}</td>
            <td>
              <span v-if="tab.priced" class="tag priced">priced</span>
              <span v-else-if="tab.removeOnly" class="tag removeonly">remove-only</span>
              <span v-else class="tag ok">editable</span>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="tabs.length" class="hint">
        {{ editableCount }} editable of {{ tabs.length }} surveyed.
        <strong v-if="shortfall > 0">
          {{ shortfall }} more tab{{ shortfall === 1 ? "" : "s" }} needed to cover every slot.
        </strong>
      </p>

      <div v-if="plan" class="plan">
        <h3>Plan</h3>
        <ul v-if="planErrors.length" class="warn">
          <li v-for="error in planErrors" :key="error">{{ error }}</li>
        </ul>
        <ul class="assignments">
          <li v-for="entry in plan.assignments" :key="entry.targetLabel">
            <span class="chip" :style="{ background: swatch(entry.slot.colour) }" />
            <code>{{ entry.targetLabel }}</code> → <strong>{{ entry.slot.tabName }}</strong>
            <span class="hint">({{ entry.slot.colour }})</span>
          </li>
        </ul>
        <p v-if="plan.unassigned.length" class="warn">
          No tab available for:
          {{ plan.unassigned.map((slot) => slot.tabName).join(", ") }}
        </p>
      </div>

      <div v-if="outcomes.length" class="plan">
        <h3>Result</h3>
        <ul>
          <li v-for="outcome in outcomes" :key="outcome.newName">
            <code>{{ outcome.targetLabel }}</code> → <strong>{{ outcome.newName }}</strong>:
            <span :class="outcome.applied ? 'ok' : 'warn'">
              {{ outcome.applied ? "applied" : outcome.reason ?? "not applied" }}
            </span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.stash-tab-admin { display: flex; flex-direction: column; gap: 0.75rem; }
.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.controls label { display: flex; gap: 0.35rem; align-items: center; }
.check { user-select: none; }
.phase { opacity: 0.7; font-variant: small-caps; }
.hint { opacity: 0.75; font-size: 0.9em; }
.warn { color: #d08a2a; }
.ok { color: #4fa84f; }
.danger { font-weight: 600; }
.tabs { border-collapse: collapse; width: 100%; }
.tabs th, .tabs td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #3a3a3a; }
.tag { font-size: 0.85em; padding: 0.1rem 0.4rem; border-radius: 0.25rem; }
.tag.priced { background: #5a3a12; }
.tag.removeonly { background: #5a1212; }
.tag.ok { background: #1d4d1d; }
.assignments { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.log { max-height: 14rem; overflow: auto; background: #111; padding: 0.5rem; font-size: 0.8em; }
.chip { display: inline-block; width: 0.9rem; height: 0.9rem; border-radius: 0.2rem; vertical-align: middle; margin-right: 0.4rem; border: 1px solid #0006; }
</style>
