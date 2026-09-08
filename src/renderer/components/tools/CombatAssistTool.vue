<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { defaultCombatConfig, HUD_NAMES, type CombatConfig, type CombatPreview, type CombatStatus, type HudRegionName } from "../../../core/combatAssist.js";

const api = window.poe2?.combat;
const draft = ref<CombatConfig>(defaultCombatConfig());
const status = ref<CombatStatus>();
const error = ref("");
const busy = ref(false);
const countdown = ref(0);
const preview = ref<CombatPreview>();
const imageElement = ref<HTMLImageElement>();
const selection = ref<HudRegionName | "cooldown">("health");
const corner = ref<{ x: number; y: number }>();
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(status.value?.config));
const labels: Record<HudRegionName, string> = { health: "Health", mana: "Mana", unleash: "Unleash ready", anchor: "Fixed HUD ornament" };
const hint = computed(() => ({
  health: "At full health, select a narrow vertical strip through the red liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  mana: "At full mana, select a narrow vertical strip through the blue liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  unleash: "With Unleash ready, select the inside of its purple R skill-bar icon. Exclude the border and key label.",
  cooldown: "Capture a new screenshot just after YOU cast R. The saved icon region is reused; click Record cooldown below.",
  anchor: "Select a small, distinctive fixed HUD ornament near the globes. Avoid black space, animated effects and numbers. This detects a hidden or covered HUD.",
}[selection.value]));

async function act(fn: () => Promise<void>) {
  if (!api || busy.value) return;
  busy.value = true; error.value = "";
  try { await fn(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
async function refresh() {
  try { if (api) status.value = await api.status(); }
  catch (e) { error.value = String(e); }
  if (!disposed) poll = setTimeout(() => void refresh(), 500);
}
onMounted(async () => {
  if (!api) return;
  await act(async () => { status.value = await api.status(); draft.value = JSON.parse(JSON.stringify(status.value.config)); });
  if (!disposed) void refresh();
});
onUnmounted(() => { disposed = true; clearTimeout(poll); });

async function save(start: boolean) {
  await act(async () => {
    status.value = await api!.configure(JSON.parse(JSON.stringify(draft.value)));
    draft.value = JSON.parse(JSON.stringify(status.value.config));
    if (start) status.value = await api!.start();
  });
}
async function stop() {
  // Stop remains available even if a start/capture request is in flight.
  countdown.value = 0;
  try { if (api) status.value = await api.stop(); } catch (e) { error.value = String(e); }
}
async function rearm() {
  await act(async () => { await window.poe2?.rearm(); status.value = await api!.status(); });
}
async function capture() {
  await act(async () => {
    await api!.stop();
    for (countdown.value = 3; countdown.value > 0; countdown.value--) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (disposed || countdown.value === 0) return;
    }
    const result = await api!.preview();
    if (disposed) return;
    if (draft.value.width !== result.width || draft.value.height !== result.height) draft.value.regions = {};
    draft.value.width = result.width; draft.value.height = result.height;
    preview.value = result; corner.value = undefined;
  });
}
function sampleRegion(region: { x: number; y: number; width: number; height: number }, name: HudRegionName): number[] {
  const img = imageElement.value;
  if (!img?.complete || !img.naturalWidth) throw new Error("Screenshot still loading.");
  const canvas = document.createElement("canvas");
  canvas.width = region.width; canvas.height = region.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot sampling unavailable.");
  context.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  const pixels = context.getImageData(0, 0, region.width, region.height).data;
  const cols = name === "health" || name === "mana" ? 5 : 16;
  const rows = cols === 5 ? 100 : 16;
  const rgb: number[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const sx = Math.min(region.width - 1, Math.floor((x + 0.5) * region.width / cols));
    const sy = Math.min(region.height - 1, Math.floor((y + 0.5) * region.height / rows));
    const i = (sy * region.width + sx) * 4;
    rgb.push(pixels[i], pixels[i + 1], pixels[i + 2]);
  }
  return rgb;
}
function pick(event: MouseEvent) {
  if (!preview.value || selection.value === "cooldown" || busy.value) return;
  const bounds = imageElement.value!.getBoundingClientRect();
  const point = {
    x: Math.max(0, Math.min(preview.value.width - 1, Math.floor((event.clientX - bounds.left) * preview.value.width / bounds.width))),
    y: Math.max(0, Math.min(preview.value.height - 1, Math.floor((event.clientY - bounds.top) * preview.value.height / bounds.height))),
  };
  if (!corner.value) { corner.value = point; return; }
  const region = { x: Math.min(point.x, corner.value.x), y: Math.min(point.y, corner.value.y), width: Math.abs(point.x - corner.value.x), height: Math.abs(point.y - corner.value.y) };
  corner.value = undefined;
  if (region.width < 3 || region.height < 3 || region.width > 1024 || region.height > 1024) { error.value = "Select a region between 3 and 1024 pixels wide and tall."; return; }
  try { draft.value.regions[selection.value] = { ...region, reference: sampleRegion(region, selection.value) }; error.value = ""; }
  catch (e) { error.value = String(e); }
}
function recordCooldown() {
  const region = draft.value.regions.unleash;
  if (!region) { error.value = "Select the ready icon first."; return; }
  try { region.cooldown = sampleRegion(region, "unleash"); error.value = ""; }
  catch (e) { error.value = String(e); }
}
</script>

<template>
  <section class="card tool-panel combat-tool" aria-labelledby="combat-title">
    <header>
      <h2 id="combat-title">Flasks &amp; Unleash</h2>
      <p>Use a flask below 25%. Cast R when the Unleash icon becomes ready.</p>
      <p class="muted">F8 pauses or resumes saved settings. Ctrl+Shift+Esc stops all input (backup: Ctrl+Shift+F12). Pause before opening chat or menus.</p>
    </header>
    <p v-if="!api" role="status">Open the desktop app to use HUD capture and combat controls.</p>
    <div class="combat-status" role="status" aria-live="polite">
      <strong>{{ status?.running ? (status.config.dryRun ? 'Preview running' : 'Running') : 'Stopped' }}</strong>
      <span>{{ status?.reason }}</span>
      <span v-if="status?.reading?.valid">Health {{ status.reading.health ?? '—' }}% · Mana {{ status.reading.mana ?? '—' }}% · Unleash {{ status.reading.unleash ?? '—' }}</span>
      <span v-if="status?.cycleMs !== undefined" class="muted">Last cycle {{ status.cycleMs }} ms · {{ status.actions }} actions{{ status.config.dryRun ? ' previewed' : '' }}</span>
    </div>
    <p v-if="error" class="combat-error" role="alert">{{ error }}</p>
    <fieldset :disabled="!api || busy">
      <legend>Automation</legend>
      <div class="combat-modules">
        <div v-for="name in (['health', 'mana'] as const)" :key="name" class="combat-module">
          <label><input v-model="draft[name].enabled" type="checkbox"> Auto {{ name }} flask</label>
          <label>Key <input v-model="draft[name].key" maxlength="1" :aria-label="`${name} flask key`"></label>
          <label>Below (%) <input v-model.number="draft[name].threshold" type="number" min="1" max="99" :aria-label="`${name} threshold`"></label>
          <label>Retry after (ms) <input v-model.number="draft[name].retryMs" type="number" min="250" max="30000" :aria-label="`${name} retry interval`"></label>
        </div>
        <div class="combat-module">
          <label><input v-model="draft.unleash.enabled" type="checkbox"> Auto Unleash</label>
          <label>Key <input v-model="draft.unleash.key" maxlength="1" aria-label="Unleash key"></label>
          <label>Minimum gap (ms) <input v-model.number="draft.unleash.retryMs" type="number" min="100" max="30000"></label>
          <p class="muted">One cast per observed cooldown. If R fails to cast, pause/resume to retry.</p>
        </div>
      </div>
      <div class="combat-controls">
        <label>Sample every (ms) <input v-model.number="draft.pollMs" type="number" min="16" max="250"></label>
        <label><input v-model="draft.dryRun" type="checkbox"> Preview only — no keypresses</label>
      </div>
    </fieldset>
    <div class="combat-controls">
      <button :disabled="!api || busy" @click="save(false)">Save settings</button>
      <button :disabled="!api || busy" @click="save(true)">Save &amp; start</button>
      <button :disabled="!api" @click="stop">Stop</button>
      <button v-if="status?.reason.includes('rearm')" :disabled="busy" @click="rearm">Rearm emergency stop</button>
      <span v-if="dirty && status" class="muted">Unsaved changes. Save applies toggles and pauses the loop.</span>
    </div>
    <details open>
      <summary>HUD calibration</summary>
      <p>Use windowed or borderless mode. Fill both globes, close panels, then capture. Switch to the game during the countdown and return here afterward.</p>
      <p class="muted">Globe percentages are visual estimates. Verify them in Preview before enabling keypresses. Recalibrate after changing resolution, HUD scale, skill or display colour settings.</p>
      <div class="combat-controls">
        <button :disabled="!api || busy" @click="capture">{{ countdown ? `Switch to game — ${countdown}…` : 'Capture game in 3 seconds' }}</button>
        <label>Region <select v-model="selection" @change="corner = undefined"><option v-for="name in HUD_NAMES" :key="name" :value="name">{{ labels[name] }}</option><option value="cooldown">Unleash on cooldown</option></select></label>
        <button v-if="selection === 'cooldown'" :disabled="!preview || busy" @click="recordCooldown">Record cooldown from screenshot</button>
      </div>
      <p>{{ hint }}</p>
      <p v-if="selection !== 'cooldown'">{{ corner ? 'Now click the opposite corner.' : 'Click two opposite corners on the screenshot to select the region.' }}</p>
      <ul class="combat-calibrations"><li v-for="name in HUD_NAMES" :key="name">{{ labels[name] }}: {{ draft.regions[name] ? 'Recorded' : 'Needed' }}<span v-if="name === 'unleash'"> · Cooldown: {{ draft.regions.unleash?.cooldown ? 'Recorded' : 'Needed' }}</span></li></ul>
      <div v-if="preview" class="hud-preview">
        <img ref="imageElement" :src="preview.image" alt="Captured game HUD: click two corners to calibrate the selected region" @click="pick">
        <template v-for="name in HUD_NAMES" :key="name">
          <div v-if="draft.regions[name]" class="hud-region" :style="{ left: `${draft.regions[name]!.x / preview.width * 100}%`, top: `${draft.regions[name]!.y / preview.height * 100}%`, width: `${draft.regions[name]!.width / preview.width * 100}%`, height: `${draft.regions[name]!.height / preview.height * 100}%` }"><span>{{ labels[name] }}</span></div>
        </template>
      </div>
    </details>
  </section>
</template>

<style scoped>
.combat-tool { display: grid; gap: 16px; }
.combat-tool h2, .combat-tool p { margin: 0 0 8px; }
.combat-status { display: flex; gap: 12px; flex-wrap: wrap; padding: 12px; background: #182722; border: 1px solid #42654e; border-radius: 8px; }
.combat-error { color: #ffb3ab; }
.combat-modules { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 18px; }
.combat-module { display: grid; align-content: start; gap: 10px; }
.combat-module label, .combat-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.combat-controls { margin-top: 12px; }
input:not([type=checkbox]) { width: 86px; }
fieldset { border: 1px solid #4b4437; border-radius: 8px; padding: 16px; min-width: 0; }
legend, summary { font-weight: 600; }
summary { cursor: pointer; margin-bottom: 12px; }
.combat-calibrations { display: flex; flex-wrap: wrap; gap: 8px 24px; padding-left: 18px; }
.hud-preview { position: relative; margin-top: 12px; line-height: 0; }
.hud-preview img { width: 100%; height: auto; cursor: crosshair; }
.hud-region { position: absolute; border: 2px solid #ffe084; pointer-events: none; }
.hud-region span { background: #171612; color: #ffe084; font-size: 11px; line-height: 1.3; position: absolute; bottom: 100%; white-space: nowrap; }
</style>
