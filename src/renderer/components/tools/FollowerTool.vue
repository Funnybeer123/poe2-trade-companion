<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from "vue";
import { defaultFollowerConfig, parseFollowerConfig, type FollowReplayStep } from "../../../core/follower.js";
import { followerDemo } from "../../../core/followerReplay.js";
import type { FollowerStatus } from "../../../shared/follower.js";

const api = window.poe2?.follower;
const config = ref(defaultFollowerConfig()), status = ref<FollowerStatus>();
const pairingKey = ref(""), showKey = ref(false), error = ref(""), pending = ref(false), loading = ref(!!api);
const steps = ref<FollowReplayStep[]>([]), stepIndex = ref(0);
const current = computed(() => steps.value[stepIndex.value]);
const connected = computed(() => status.value?.connection === "connected");
const active = computed(() => !!status.value && !["stopped", "error"].includes(status.value.connection));
const routePoints = computed(() => current.value?.decision.route.map(p => `${p.x * 30 + 15},${p.y * 30 + 15}`).join(" ") ?? "");
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, revision = 0;
async function refresh(): Promise<void> {
  const version = revision;
  try { const next = await api?.status(); if (!disposed && version === revision && next) status.value = next; }
  catch (e) { if (!disposed) error.value = String(e); }
  if (!disposed) timer = setTimeout(() => void refresh(), 1000);
}
onMounted(async () => {
  try { const next = await api?.status(); if (!disposed && next) { status.value = next; config.value = next.config; } }
  catch (e) { if (!disposed) error.value = String(e); }
  finally { if (!disposed) { loading.value = false; void refresh(); } }
});
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); pairingKey.value = ""; });
async function save(start = false): Promise<void> {
  if (!api || pending.value) return;
  const version = ++revision;
  pending.value = true; error.value = "";
  try {
    const value = parseFollowerConfig(toRaw(config.value));
    const saved = await api.configure(value);
    if (disposed || version !== revision) return;
    status.value = saved;
    if (start) { const next = await api.start(pairingKey.value.trim()); if (!disposed && version === revision) status.value = next; }
  } catch (e) { if (!disposed && version === revision) error.value = String(e); }
  finally { if (version === revision) pending.value = false; }
}
async function stop(): Promise<void> {
  ++revision; pending.value = false;
  try { const next = await api?.stop(); if (!disposed && next) status.value = next; }
  catch (e) { if (!disposed) error.value = String(e); }
}
async function generateKey(): Promise<void> {
  try { const key = await api?.generateKey(); if (!disposed && key) { pairingKey.value = key; showKey.value = true; } }
  catch (e) { if (!disposed) error.value = String(e); }
}
function demo(): void {
  try { steps.value = followerDemo(parseFollowerConfig(toRaw(config.value))); stepIndex.value = 0; error.value = ""; }
  catch (e) { error.value = String(e); }
}
</script>

<template>
  <section class="follower-tool" aria-labelledby="follower-title">
    <header class="follower-header">
      <div><p class="eyebrow">TWO-PC COMPANION</p><h2 id="follower-title">Follow &amp; Loot</h2><p>Keep a second character close, collect nearby loot, and find the route back.</p></div>
      <span class="follower-badge">Preview release</span>
    </header>
    <div class="follower-notice">
      <strong>Connection and route preview are ready.</strong>
      <span>Live character tracking, map reading, and game controls are still in development. Connecting the PCs does not move a character or pick up items.</span>
    </div>
    <p v-if="error" class="follower-error" role="alert">{{ error }}</p>
    <div class="follower-grid">
      <section class="card follower-section" aria-labelledby="follower-pair-title">
        <h3 id="follower-pair-title">Connect your PCs</h3>
        <fieldset :disabled="pending || loading" class="follower-fields">
          <label>This PC<select v-model="config.role"><option value="leader">Main PC · your character</option><option value="follower">Second PC · follower</option></select></label>
          <label>Character to follow<input v-model="config.targetName" maxlength="80" placeholder="Exact character name" /></label>
          <label>{{ config.role === 'leader' ? 'This PC’s local IPv4 address' : 'Main PC’s local IPv4 address' }}<input v-model="config.address" spellcheck="false" placeholder="192.168.1.20" /></label>
          <small v-if="status?.addresses.length">This PC: {{ status.addresses.join(', ') }}</small>
          <small v-if="config.address === '127.0.0.1'">127.0.0.1 tests this computer only. Use the main PC’s local network address to connect two PCs.</small>
          <label>Connection port<input v-model.number="config.port" type="number" min="1024" max="65535" /></label>
          <label>Pairing key<input v-model="pairingKey" :type="showKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" maxlength="64" placeholder="Use the same key on both PCs" /></label>
          <div class="follower-actions"><button type="button" :disabled="!api || active" @click="generateKey">Generate key</button><label class="follower-check"><input v-model="showKey" type="checkbox" />Show key</label></div>
          <small>Generate a key on the main PC, then enter it on the second PC. Keys stay in memory and must be entered again after restarting. Start the main PC’s listener first.</small>
        </fieldset>
        <div class="follower-actions">
          <button :disabled="!api || pending || loading" @click="save(true)">{{ pending ? 'Connecting…' : config.role === 'leader' ? 'Start listener' : 'Connect to main PC' }}</button>
          <button :disabled="!api || (!active && !pending)" @click="stop">Stop connection</button>
        </div>
        <p v-if="!api" class="muted">Open the desktop app to connect PCs. The route demo works here.</p>
        <div class="follower-status" role="status"><span class="status-dot" :class="{ connected }" /><strong>{{ status?.connection ?? 'stopped' }}</strong><span v-if="connected && status?.roundTripMs !== undefined">{{ status.roundTripMs }} ms network round trip</span></div>
        <p class="muted">{{ status?.reason ?? 'No connection started.' }}</p>
        <p v-if="status?.peerName">Main character: {{ status.peerName }}</p>
      </section>

      <section class="card follower-section" aria-labelledby="follower-policy-title">
        <h3 id="follower-policy-title">Following &amp; loot preferences</h3>
        <fieldset :disabled="pending || loading" class="follower-fields">
          <label>Following distance · map cells<input v-model.number="config.followDistance" type="number" min="1" max="10" /></label>
          <label>Maximum separation while looting · map cells<input v-model.number="config.lootLeash" type="number" min="2" max="25" /></label>
          <label class="follower-check"><input v-model="config.lootEnabled" type="checkbox" />Collect nearby eligible loot</label>
          <label>Minimum loot score<input v-model.number="config.lootScore" type="number" min="0" max="100" /></label>
          <label>Minimum tracking confidence<input v-model.number="config.confidence" type="number" min="0.5" max="1" step="0.05" /></label>
        </fieldset>
        <p class="muted">These preferences currently apply to the route preview. Live map calibration will determine how cells relate to game distance.</p>
        <ul class="follower-rules"><li>Rejoin the leader before collecting more loot.</li><li>Verify pickups; skip items after two failed attempts.</li><li>Keep following when inventory is full.</li><li>Pause on uncertain routes, stale observations, or loading screens.</li></ul>
        <button :disabled="!api || pending || loading" @click="save()">Save preferences</button>
        <small class="follower-save-note">Saving stops the current connection. Your pairing key is not saved.</small>
      </section>
    </div>
    <section class="card follower-section" aria-labelledby="follower-preview-title">
      <div class="follower-preview-header"><div><h3 id="follower-preview-title">Route preview</h3><p class="muted">Synthetic observations demonstrate the planner. No game capture or input.</p></div><button @click="demo">Run route demo</button></div>
      <div v-if="current" class="follower-preview">
        <svg viewBox="0 0 360 210" role="img" :aria-label="`Route preview: ${current.title}`" class="follower-map">
          <g v-for="(row, y) in current.observation.map?.cells ?? []" :key="y"><rect v-for="(cell, x) in row" :key="x" :x="x * 30 + 1" :y="y * 30 + 1" width="28" height="28" rx="3" :fill="cell === '.' ? '#1f2d3d' : '#0b1018'" /></g>
          <polyline v-if="routePoints" :points="routePoints" fill="none" stroke="#72c5ff" stroke-width="3" stroke-linejoin="round" />
          <rect v-for="loot in current.observation.loot" :key="loot.id" :x="loot.position.x * 30 + 10" :y="loot.position.y * 30 + 10" width="10" height="10" fill="#f7c875" />
          <circle v-if="current.observation.leader" :cx="current.observation.leader.position.x * 30 + 15" :cy="current.observation.leader.position.y * 30 + 15" r="8" fill="#99e3bc" />
          <circle :cx="current.observation.player.x * 30 + 15" :cy="current.observation.player.y * 30 + 15" r="7" fill="#72c5ff" stroke="#e5f5ff" stroke-width="2" />
        </svg>
        <div class="follower-decision"><p class="eyebrow">DEMO · STEP {{ stepIndex + 1 }} / {{ steps.length }}</p><h4>{{ current.title }}</h4><strong>{{ current.decision.phase }}</strong><p>{{ current.decision.reason }}</p><p class="muted">Blue: follower · Green: leader · Gold: loot</p><div class="follower-actions"><button :disabled="stepIndex === 0" @click="stepIndex--">Previous step</button><button :disabled="stepIndex >= steps.length - 1" @click="stepIndex++">Next step</button></div></div>
      </div>
      <p v-else class="follower-empty">Preview following, a loot detour, pickup verification, and an off-screen return around a wall.</p>
    </section>
  </section>
</template>

<style scoped>
.follower-tool { display: grid; gap: 20px; max-width: 1200px; }
.follower-header, .follower-preview-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.follower-header h2 { margin: 5px 0 8px; font-size: 26px; }
.follower-header p, .follower-section p { line-height: 1.5; }
.eyebrow { margin: 0; font-size: 10px; letter-spacing: 1.8px; color: #8fc6e8; }
.follower-badge { white-space: nowrap; border: 1px solid #426079; border-radius: 20px; padding: 6px 11px; color: #acd8f4; font-size: 12px; }
.follower-notice { display: grid; gap: 6px; padding: 16px 20px; background: #182634; border: 1px solid #30485e; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.follower-notice span, .muted, small { color: #a6b3c5; }
.follower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.follower-section { padding: 22px; min-width: 0; }
.follower-section h3 { margin: 0 0 18px; font-size: 17px; }
.follower-fields { display: grid; gap: 14px; padding: 0; margin: 0 0 18px; border: 0; min-width: 0; }
.follower-fields label { display: grid; gap: 7px; font-size: 13px; }
.follower-fields input:not([type=checkbox]), .follower-fields select { width: 100%; min-width: 0; padding: 9px 11px; box-sizing: border-box; background: #111821; border: 1px solid #344353; border-radius: 6px; color: #e1e8f1; }
.follower-fields .follower-check { display: flex; gap: 8px; align-items: center; }
.follower-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.follower-tool button { border: 1px solid #3d596e; background: #21384b; color: #def0ff; border-radius: 6px; padding: 9px 12px; cursor: pointer; }
.follower-tool button:disabled { opacity: .45; cursor: default; }
.follower-tool :is(button, input, select):focus-visible { outline: 2px solid #85c8f8; outline-offset: 3px; }
.follower-status { display: flex; gap: 9px; align-items: center; margin-top: 20px; font-size: 12px; flex-wrap: wrap; }
.status-dot { height: 7px; width: 7px; border-radius: 50%; background: #758298; }
.status-dot.connected { background: #99e3bc; }
.follower-rules { padding-left: 18px; color: #b8c6d7; font-size: 13px; line-height: 1.9; }
.follower-save-note { display: block; margin-top: 12px; }
.follower-preview { display: grid; grid-template-columns: minmax(200px, 1fr) 1fr; gap: 24px; align-items: center; }
.follower-map { width: 100%; max-height: 290px; background: #0b1018; border-radius: 8px; }
.follower-decision h4 { margin: 10px 0; font-size: 16px; }
.follower-decision > strong { color: #99e3bc; }
.follower-empty { padding: 24px; text-align: center; border: 1px dashed #344353; border-radius: 8px; color: #a6b3c5; }
.follower-error { padding: 12px; color: #ffb3b3; background: #461f29; border-radius: 6px; }
@media (max-width: 1000px) { .follower-grid, .follower-preview { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .follower-header, .follower-preview-header { flex-direction: column; } }
</style>
