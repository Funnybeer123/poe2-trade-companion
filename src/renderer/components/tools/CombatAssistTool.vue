<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { COMBAT_BINDINGS, HUD_NAMES, type CombatStatus, type HudRegionName } from "../../../core/combatAssist.js";
import { useCombatDraft, type CalibrationTab } from "../../composables/useCombatDraft.js";

const api = window.poe2?.combat;
const session = useCombatDraft(api);
const { draft, screenshots, activeTab, selection, corner, error } = session;
const status = ref<CombatStatus>();
const busy = ref(false);
const countdown = ref(0);
const preview = computed(() => screenshots.value[activeTab.value]);
const imageElement = ref<HTMLImageElement>();
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(status.value?.config));
const labels: Record<HudRegionName, string> = { health: "Health", mana: "Mana", unleash: "Unleash ready", anchor: "Fixed HUD ornament" };
const hint = computed(() => ({
  health: "At full health, select a narrow vertical strip through the red liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  mana: "At full mana, select a narrow vertical strip through the blue liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  unleash: "With Unleash ready, select the inside of its purple R skill-bar icon. Exclude the border and key label.",
  anchor: "Select a small, distinctive fixed HUD ornament near the globes. Avoid black space, animated effects and numbers. This detects a hidden or covered HUD.",
}[selection.value]));
const screenshotMatchesHud = computed(() => preview.value?.width === draft.value.width && preview.value?.height === draft.value.height);
const iconCropStyle = computed(() => {
  const shot = preview.value, region = draft.value.regions.unleash;
  if (!shot || !region || !screenshotMatchesHud.value) return undefined;
  return {
    backgroundImage: `url("${shot.image}")`,
    backgroundSize: `${shot.width / region.width * 128}px ${shot.height / region.height * 128}px`,
    backgroundPosition: `${-region.x / region.width * 128}px ${-region.y / region.height * 128}px`,
  };
});
function referencePixels(rgb: number[] | undefined) {
  return rgb ? Array.from({ length: rgb.length / 3 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16), fill: `rgb(${rgb[i * 3]},${rgb[i * 3 + 1]},${rgb[i * 3 + 2]})` })) : [];
}
const readyPixels = computed(() => referencePixels(draft.value.regions.unleash?.reference));
const cooldownPixels = computed(() => referencePixels(draft.value.regions.unleash?.cooldown));
function selectTab(tab: CalibrationTab) { activeTab.value = tab; corner.value = undefined; }

async function act(fn: () => Promise<void>, clearError = true) {
  if (!api || busy.value) return;
  busy.value = true;
  if (clearError) error.value = "";
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
  await act(async () => {
    status.value = await api.status();
    if (!disposed) session.reconcile(status.value.config);
  }, false);
  if (!disposed) void refresh();
});
onUnmounted(() => { disposed = true; clearTimeout(poll); });

async function save(start: boolean) {
  await act(async () => {
    status.value = await api!.status();
    session.reconcile(status.value.config);
    status.value = await api!.configure(JSON.parse(JSON.stringify(draft.value)));
    session.acceptSaved(status.value.config);
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
  const target = activeTab.value;
  await act(async () => {
    await api!.stop();
    for (countdown.value = 3; countdown.value > 0; countdown.value--) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (disposed || countdown.value === 0) return;
    }
    const result = await api!.preview();
    if (disposed) return;
    if (target === "hud") {
      if (draft.value.width !== result.width || draft.value.height !== result.height) draft.value.regions = {};
      draft.value.width = result.width; draft.value.height = result.height;
    }
    screenshots.value[target] = { ...result, capturedAt: new Date().toISOString() };
    corner.value = undefined;
  });
}
function sampleRegion(region: { x: number; y: number; width: number; height: number }, name: HudRegionName, source: CalibrationTab): number[] {
  const shot = screenshots.value[source];
  if (!shot || activeTab.value !== source) throw new Error(`Capture the ${source === "hud" ? "HUD / ready" : "Unleash cooldown"} screenshot first.`);
  if (shot.width !== draft.value.width || shot.height !== draft.value.height) throw new Error("Screenshot size differs from the calibrated HUD. Restore the same game resolution and capture again.");
  const img = imageElement.value;
  if (!img?.complete || !img.naturalWidth || img.getAttribute("src") !== shot.image) throw new Error("Screenshot still loading.");
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
  if (!preview.value || activeTab.value !== "hud" || busy.value) return;
  const bounds = imageElement.value!.getBoundingClientRect();
  const point = {
    x: Math.max(0, Math.min(preview.value.width - 1, Math.floor((event.clientX - bounds.left) * preview.value.width / bounds.width))),
    y: Math.max(0, Math.min(preview.value.height - 1, Math.floor((event.clientY - bounds.top) * preview.value.height / bounds.height))),
  };
  if (!corner.value) { corner.value = point; return; }
  const region = { x: Math.min(point.x, corner.value.x), y: Math.min(point.y, corner.value.y), width: Math.abs(point.x - corner.value.x), height: Math.abs(point.y - corner.value.y) };
  corner.value = undefined;
  if (region.width < 3 || region.height < 3 || region.width > 1024 || region.height > 1024) { error.value = "Select a region between 3 and 1024 pixels wide and tall."; return; }
  try { draft.value.regions[selection.value] = { ...region, reference: sampleRegion(region, selection.value, "hud") }; error.value = ""; }
  catch (e) { error.value = String(e); }
}
function recordCooldown() {
  const region = draft.value.regions.unleash;
  if (!region) { error.value = "Select the ready icon first."; return; }
  try { region.cooldown = sampleRegion(region, "unleash", "cooldown"); error.value = ""; }
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
          <label>Key / button <select v-model="draft[name].key" :aria-label="`${name} flask key`"><option v-for="binding in COMBAT_BINDINGS" :key="binding.value" :value="binding.value">{{ binding.label }}</option></select></label>
          <label>Below (%) <input v-model.number="draft[name].threshold" type="number" min="1" max="99" :aria-label="`${name} threshold`"></label>
          <label>Retry after (ms) <input v-model.number="draft[name].retryMs" type="number" min="250" max="30000" :aria-label="`${name} retry interval`"></label>
        </div>
        <div class="combat-module">
          <label><input v-model="draft.unleash.enabled" type="checkbox"> Auto Unleash</label>
          <label>Key / button <select v-model="draft.unleash.key" aria-label="Unleash key"><option v-for="binding in COMBAT_BINDINGS" :key="binding.value" :value="binding.value">{{ binding.label }}</option></select></label>
          <label>Minimum gap (ms) <input v-model.number="draft.unleash.retryMs" type="number" min="100" max="30000"></label>
          <p class="muted">Casts when ready. If another action interrupts the cast, retries automatically while the icon remains ready.</p>
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
      <p class="muted">Drafts and screenshots stay available while you navigate this app. Save settings to keep the recorded detector references after restarting.</p>
      <ul class="combat-calibrations"><li v-for="name in HUD_NAMES" :key="name">{{ labels[name] }}: {{ draft.regions[name] ? 'Recorded' : 'Needed' }}<span v-if="name === 'unleash'"> · Cooldown: {{ draft.regions.unleash?.cooldown ? 'Recorded' : 'Needed' }}</span></li></ul>
      <div class="recorded-icons" aria-label="Recorded Unleash detector data">
        <figure class="icon-sample">
          <svg v-if="readyPixels.length" class="recorded-icon" viewBox="0 0 16 16" role="img" aria-label="Recorded ready reference, 16 by 16 RGB samples" shape-rendering="crispEdges"><rect v-for="(pixel, index) in readyPixels" :key="index" :x="pixel.x" :y="pixel.y" width="1" height="1" :fill="pixel.fill" /></svg>
          <p v-else>No ready reference recorded.</p>
          <figcaption>Recorded ready reference · 16 × 16 RGB samples</figcaption>
        </figure>
        <figure class="icon-sample">
          <svg v-if="cooldownPixels.length" class="recorded-icon" viewBox="0 0 16 16" role="img" aria-label="Recorded cooldown reference, 16 by 16 RGB samples" shape-rendering="crispEdges"><rect v-for="(pixel, index) in cooldownPixels" :key="index" :x="pixel.x" :y="pixel.y" width="1" height="1" :fill="pixel.fill" /></svg>
          <p v-else>No cooldown reference recorded.</p>
          <figcaption>Recorded cooldown reference · 16 × 16 RGB samples</figcaption>
        </figure>
      </div>
      <div class="calibration-tabs" role="tablist" aria-label="Calibration screenshots">
        <button id="combat-hud-tab" role="tab" :aria-selected="activeTab === 'hud'" aria-controls="combat-hud-panel" :disabled="busy" @click="selectTab('hud')">HUD / ready</button>
        <button id="combat-cooldown-tab" role="tab" :aria-selected="activeTab === 'cooldown'" aria-controls="combat-cooldown-panel" :disabled="busy" @click="selectTab('cooldown')">Unleash cooldown</button>
      </div>
      <div :id="activeTab === 'hud' ? 'combat-hud-panel' : 'combat-cooldown-panel'" role="tabpanel" :aria-labelledby="activeTab === 'hud' ? 'combat-hud-tab' : 'combat-cooldown-tab'">
        <div class="combat-controls">
          <button :disabled="!api || busy" @click="capture">{{ countdown ? `Switch to game — ${countdown}…` : activeTab === 'hud' ? 'Capture HUD / ready in 3 seconds' : 'Capture cooldown in 3 seconds' }}</button>
          <label v-if="activeTab === 'hud'">Region <select v-model="selection" @change="corner = undefined"><option v-for="name in HUD_NAMES" :key="name" :value="name">{{ labels[name] }}</option></select></label>
          <button v-else :disabled="!preview || busy || !screenshotMatchesHud" @click="recordCooldown">Record cooldown from screenshot</button>
        </div>
        <template v-if="activeTab === 'hud'">
          <p>{{ hint }}</p>
          <p>{{ corner ? 'Now click the opposite corner.' : 'Click two opposite corners on the screenshot to select the region.' }}</p>
        </template>
        <p v-else>Capture a separate screenshot just after you cast R. Record cooldown samples the saved Unleash icon region from this screenshot. Your HUD / ready screenshot stays available on its tab.</p>
        <p v-if="preview" class="capture-time">{{ activeTab === 'hud' ? 'HUD / ready' : 'Cooldown' }} captured <time :datetime="preview.capturedAt">{{ new Date(preview.capturedAt).toLocaleTimeString() }}</time> · {{ preview.width }} × {{ preview.height }}</p>
        <p v-else>No screenshot captured on this tab yet.</p>
        <p v-if="preview && !screenshotMatchesHud" class="combat-error">Screenshot size differs from the calibrated HUD. Restore the same game resolution and capture again before recording.</p>
        <figure v-if="iconCropStyle" class="icon-sample">
          <div class="icon-crop" :style="iconCropStyle" role="img" :aria-label="`${activeTab === 'hud' ? 'HUD / ready' : 'Cooldown'} screenshot Unleash icon crop`"></div>
          <figcaption>Current screenshot crop — recorded detector data is shown above.</figcaption>
        </figure>
        <div v-if="preview" class="hud-preview" :class="{ 'cooldown-preview': activeTab === 'cooldown' }">
          <img :key="activeTab" ref="imageElement" :src="preview.image" :alt="activeTab === 'hud' ? 'Captured game HUD: click two corners to calibrate the selected region' : 'Captured Unleash cooldown screenshot'" @click="pick">
          <template v-for="name in (activeTab === 'hud' ? HUD_NAMES : ['unleash'] as const)" :key="name">
            <div v-if="draft.regions[name] && screenshotMatchesHud" class="hud-region" :style="{ left: `${draft.regions[name]!.x / preview.width * 100}%`, top: `${draft.regions[name]!.y / preview.height * 100}%`, width: `${draft.regions[name]!.width / preview.width * 100}%`, height: `${draft.regions[name]!.height / preview.height * 100}%` }"><span>{{ activeTab === 'cooldown' ? 'Unleash cooldown' : labels[name] }}</span></div>
          </template>
        </div>
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
.calibration-tabs, .recorded-icons { display: flex; flex-wrap: wrap; gap: 16px; margin: 16px 0; }
.calibration-tabs button[aria-selected=true] { border-color: #ffe084; background: #39342a; }
.icon-sample { display: grid; align-content: start; gap: 8px; margin: 12px 0; max-width: 300px; }
.icon-crop, .recorded-icon { display: block; width: 128px; height: 128px; border: 1px solid #82714e; image-rendering: pixelated; }
.icon-crop { background-repeat: no-repeat; }
.icon-sample figcaption { line-height: 1.4; color: #c5bdac; }
.hud-preview { position: relative; margin-top: 12px; line-height: 0; }
.hud-preview img { width: 100%; height: auto; cursor: crosshair; }
.cooldown-preview img { cursor: default; }
.hud-region { position: absolute; border: 2px solid #ffe084; pointer-events: none; }
.hud-region span { background: #171612; color: #ffe084; font-size: 11px; line-height: 1.3; position: absolute; bottom: 100%; white-space: nowrap; }
</style>
