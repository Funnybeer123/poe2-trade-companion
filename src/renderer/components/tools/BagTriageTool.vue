<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { BagTriageStage, BagTriageStatus } from "../../../shared/bagTriage.js";
const api = window.poe2?.bagTriage;
const state = ref<BagTriageStatus>({ running: false, phase: "idle", message: "Ready to identify and drop low-priority items.", sessions: [] });
const error = ref(""), busy = ref(false);
let unsubscribe: (() => void) | undefined;
async function apply(work: () => Promise<BagTriageStatus>) {
  busy.value = true; error.value = "";
  try { state.value = await work(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
const start = (stage: BagTriageStage) => api && apply(() => api.start(stage));
const select = (event: Event) => api && apply(() => api.select((event.target as HTMLSelectElement).value));
const stop = () => api && apply(() => api.stop());
const refresh = () => api && apply(() => api.status());
onMounted(async () => { if (api) { unsubscribe = api.onStatus(value => state.value = value); await apply(() => api.status()); } });
onUnmounted(() => unsubscribe?.());
</script>

<template>
  <section class="card bag-triage-tool">
    <h2>Bag triage</h2>
    <p>Identify your bag, keep useful items and items that need review, and drop known low-priority items.</p>
    <p>Open your inventory in a map, with Scrolls of Wisdom in the top-left slot. Starts after three seconds so you can return to the game.</p>
    <p v-if="!api">Open the desktop app to use bag triage.</p>
    <fieldset :disabled="!api || busy">
      <div class="bag-actions">
        <button class="primary" :disabled="state.running || !!state.readiness?.length" @click="start('workflow')">Identify &amp; drop</button>
        <button :disabled="!state.running" @click="stop">Stop</button>
        <button :disabled="state.running" @click="refresh">Refresh setup</button>
      </div>
      <details>
        <summary>Diagnostic controls</summary>
        <div class="bag-diagnostics">
          <label>Saved bag
            <select aria-label="Saved bag" :value="state.journal || ''" :disabled="state.running" @change="select">
              <option value="" disabled>Select a capture</option>
              <option v-for="session in state.sessions" :key="session.id" :value="session.id">{{ session.label }}</option>
            </select>
          </label>
          <div class="bag-actions">
            <button :disabled="state.running || !!state.readiness?.length" @click="start('capture')">Capture bag</button>
            <button :disabled="state.running || !state.journal || !!state.readiness?.length" @click="start('identify')">Identify one</button>
            <button :disabled="state.running || !state.journal || !!state.readiness?.length" @click="start('drop')">Drop one low-priority item</button>
            <button :disabled="state.running || !state.journal || !!state.readiness?.length" @click="start('reconcile')">Reconcile</button>
          </div>
        </div>
      </details>
    </fieldset>
    <div class="ring-gamble">
      <h3>Ange · Gamble rings</h3>
      <p>Stand near Ange with panels closed. Alt-left-click opens Gamble, then Jewelry. Buy up to 60 rings into free slots, retain useful core T1/T2 rolls and substantial stat synergies, and sell verified weak rolls back with Ctrl-click. Existing items and uncertain rolls stay in your bag.</p>
      <p>This spends gold for one batch. Uses copied affix tiers and strict caster, attack or defensive combinations. Utility rolls alone do not qualify. Generic price and keep rules do not override this filter. Incomplete reads and special items remain for review.</p>
      <button :disabled="!api || busy || state.running || !!state.gambleReadiness?.length" @click="start('gamble')">Gamble rings · buy &amp; sort</button>
      <button :disabled="!api || busy || state.running || !!state.gambleReadiness?.length" @click="start('cleanup')">Clean up rings · sell rejects</button>
      <p>Cleanup scans existing rings and sells rejects in one batch at Ange. It buys nothing and preserves other item types.</p>
      <p v-if="state.cleanupHotkey">Cleanup hotkey: {{ state.cleanupHotkey }}</p>
      <p v-if="state.cleanupHotkeyError" role="alert">{{ state.cleanupHotkeyError }}</p>
      <ul v-if="state.gambleReadiness?.length"><li v-for="issue in state.gambleReadiness" :key="issue">{{ issue }}</li></ul>
      <p v-if="state.purchased !== undefined">{{ state.purchased }} purchased · {{ state.sold ?? 0 }} sold · {{ state.retained ?? 0 }} retained</p>
    </div>
    <p role="status">{{ state.message }}</p>
    <ul v-if="state.readiness?.length" aria-label="Bag setup needed"><li v-for="issue in state.readiness" :key="issue">{{ issue }}</li></ul>
    <p v-if="state.physicalItems !== undefined">{{ state.physicalItems }} items · {{ state.unreadCells ?? 0 }} unread cells · {{ state.verifiedIdentifications ?? 0 }} identified · {{ state.verifiedDrops ?? 0 }} dropped</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p>Num0 or Ctrl+Shift+Esc stops. Num5 pauses or resumes.</p>
  </section>
</template>

<style scoped>
.bag-triage-tool { display: grid; gap: 12px; }
fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 14px; }
label { display: grid; gap: 6px; }
.bag-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bag-diagnostics { display: grid; gap: 14px; margin-top: 14px; }
summary { cursor: pointer; }
[role="alert"] { color: var(--danger, #ff8b8b); }
</style>
