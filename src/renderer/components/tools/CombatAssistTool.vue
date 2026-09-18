<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { COMBAT_BINDINGS, HUD_NAMES, isSkillModule, SKILL_LABELS, SKILL_MODULES, type CombatStatus, type HudRegionName, type SkillModule } from "../../../core/combatAssist.js";
import { cooldownTab, tabSkill, useCombatDraft, type CalibrationTab } from "../../composables/useCombatDraft.js";

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
const skillLabels = computed(() => ({ ...SKILL_LABELS, unleash: draft.value.sigilSequence.enabled ? "Sigil of Power" : "Unleash" }));
const calibrationNames = computed(() => HUD_NAMES.filter((name) => !draft.value.sigilSequence.enabled || !isSkillModule(name)));
watch(() => draft.value.sigilSequence.enabled, (enabled) => {
  if (enabled) { activeTab.value = "hud"; if (isSkillModule(selection.value)) selection.value = "health"; }
}, { immediate: true });
const labels = computed<Record<HudRegionName, string>>(() => ({ health: "Health", mana: "Mana", unleash: `${skillLabels.value.unleash} ready`, verisium: "Powered by Verisium ready", anchor: "Fixed HUD ornament" }));
function toggleSequence(event: Event) {
  draft.value.sigilSequence.enabled = (event.target as HTMLInputElement).checked;
  draft.value.unleash.enabled = draft.value.verisium.enabled = draft.value.sigilSequence.enabled;
}
const hint = computed(() => ({
  health: "At full health, select a narrow vertical strip through the red liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  mana: "At full mana, select a narrow vertical strip through the blue liquid, from its top to its bottom. Avoid the frame, reflections and text.",
  unleash: `With ${skillLabels.value.unleash} ready, select the inside of its R skill-bar icon. Exclude the border and key label.`,
  verisium: "With Powered by Verisium ready, select the inside of its T skill-bar icon. Exclude the border and key label.",
  anchor: "Select a small, distinctive fixed HUD ornament near the globes. Avoid black space, animated effects and numbers. This detects a hidden or covered HUD.",
}[selection.value]));
const screenshotMatchesHud = computed(() => preview.value?.width === draft.value.width && preview.value?.height === draft.value.height);
/** The skill a cooldown tab records; on the HUD tab, the skill being selected (Unleash otherwise). */
const activeSkill = computed(() => tabSkill(activeTab.value));
const cropSkill = computed<SkillModule>(() => activeSkill.value ?? (isSkillModule(selection.value) ? selection.value : "unleash"));
const overlayNames = computed<readonly HudRegionName[]>(() => activeSkill.value ? [activeSkill.value] : calibrationNames.value);
function tabLabel(tab: CalibrationTab): string {
  const skill = tabSkill(tab);
  return skill ? `${skillLabels.value[skill]} cooldown` : "HUD / ready";
}
const iconCropStyle = computed(() => {
  const shot = preview.value, region = draft.value.regions[cropSkill.value];
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
const skillPixels = computed(() => (draft.value.sigilSequence.enabled ? [] : SKILL_MODULES).map((name) => ({
  name, label: skillLabels.value[name], key: draft.value[name].key,
  ready: referencePixels(draft.value.regions[name]?.reference),
  cooldown: referencePixels(draft.value.regions[name]?.cooldown),
})));
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
  if (!shot || activeTab.value !== source) throw new Error(`Capture the ${tabLabel(source)} screenshot first.`);
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
  const skill = activeSkill.value;
  if (!skill) return;
  const region = draft.value.regions[skill];
  if (!region) { error.value = `Select the ${skillLabels.value[skill]} ready icon first.`; return; }
  try { region.cooldown = sampleRegion(region, skill, activeTab.value); error.value = ""; }
  catch (e) { error.value = String(e); }
}
</script>

<template>
  <section class="card tool-panel combat-tool" aria-labelledby="combat-title">
    <header>
      <h2 id="combat-title">Flasks &amp; Unleash</h2>
      <p v-if="draft.sigilSequence.enabled">Press {{ draft.unleash.key }} in the game for one Sigil → weapon swap → Verisium cycle. The macro waits for your next press before doing anything again.</p>
      <p v-else>Use a flask below 25%. Cast {{ skillLabels.unleash }} ({{ draft.unleash.key }}) and Powered by Verisium ({{ draft.verisium.key }}) when their icons become ready.</p>
      <p class="muted">F8 {{ draft.sigilSequence.enabled ? 'arms or pauses the saved macro' : 'pauses or resumes saved settings' }}. Ctrl+Shift+Esc stops all input (backup: Ctrl+Shift+F12). Pause before opening chat or menus.</p>
    </header>
    <p v-if="!api" role="status">Open the desktop app to use HUD capture and combat controls.</p>
    <div class="combat-status" role="status" aria-live="polite">
      <strong>{{ status?.running ? (status.config.sigilSequence.enabled ? (status.config.dryRun ? 'Preview armed' : 'Armed') : status.config.dryRun ? 'Preview running' : 'Running') : 'Stopped' }}</strong>
      <span>{{ status?.reason }}</span>
      <span v-if="status?.reading?.valid">Health {{ status.reading.health ?? '—' }}% · Mana {{ status.reading.mana ?? '—' }}%<template v-if="!status.config.sigilSequence.enabled"> · {{ skillLabels.unleash }} {{ status.reading.unleash ?? '—' }} · Verisium {{ status.reading.verisium ?? '—' }}</template></span>
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
        <div v-for="name in SKILL_MODULES" :key="name" class="combat-module">
          <label><input v-model="draft[name].enabled" type="checkbox" :disabled="draft.sigilSequence.enabled"> {{ draft.sigilSequence.enabled ? 'Macro: ' : 'Auto ' }}{{ skillLabels[name] }}</label>
          <label>{{ draft.sigilSequence.enabled && name === 'unleash' ? 'Trigger key' : 'Key / button' }} <select v-model="draft[name].key" :aria-label="`${skillLabels[name]} key`"><option v-for="binding in COMBAT_BINDINGS.filter((binding) => !draft.sigilSequence.enabled || name !== 'unleash' || binding.value !== 'MOUSE5')" :key="binding.value" :value="binding.value">{{ binding.label }}</option></select></label>
          <label v-if="!draft.sigilSequence.enabled">Minimum gap (ms) <input v-model.number="draft[name].retryMs" type="number" min="100" max="30000" :aria-label="`${skillLabels[name]} minimum gap`"></label>
          <p v-if="draft.sigilSequence.enabled" class="muted">{{ name === 'unleash' ? 'Your physical keypress casts Sigil and triggers one macro cycle.' : 'Tapped once after the weapon swap in your macro cycle.' }}</p>
          <p v-else class="muted">Casts when ready. If another action interrupts the cast, retries automatically while the icon remains ready.</p>
        </div>
      </div>
      <div class="combat-controls">
        <label>Sample every (ms) <input v-model.number="draft.pollMs" type="number" min="16" max="250"></label>
        <label><input v-model="draft.dryRun" type="checkbox"> Preview only — no keypresses</label>
      </div>
    </fieldset>
    <fieldset :disabled="!api || busy" class="sigil-sequence">
      <legend>Sigil of Power → weapon swap → Powered by Verisium</legend>
      <label><input type="checkbox" :checked="draft.sigilSequence.enabled" @change="toggleSequence"> Manual Sigil macro</label>
      <p>Press {{ draft.unleash.key }} → wait {{ draft.sigilSequence.castMs }} ms → tap {{ draft.sigilSequence.swapKey }} → wait {{ draft.sigilSequence.swapMs }} ms → tap {{ draft.verisium.key }}. Your {{ draft.unleash.key }} press reaches the game normally and must automatically select Sigil's weapon set.</p>
      <div class="combat-controls">
        <label>Weapon swap key <select v-model="draft.sigilSequence.swapKey" aria-label="Weapon swap key"><option v-for="binding in COMBAT_BINDINGS" :key="binding.value" :value="binding.value">{{ binding.label }}</option></select></label>
        <label>Sigil cast delay (ms) <input v-model.number="draft.sigilSequence.castMs" aria-label="Sigil cast delay" type="number" min="0" max="5000" step="10"></label>
        <label>Weapon swap delay (ms) <input v-model.number="draft.sigilSequence.swapMs" aria-label="Weapon swap delay" type="number" min="0" max="5000" step="10"></label>
      </div>
      <p class="muted">One cycle per press. Holding the trigger or pressing it during a cycle does not queue more cycles. There are no automatic repeats or cooldown retries. Use the trigger when both skills are available; the macro does not check their icons.</p>
      <p class="muted">F8 arms / pauses. Skill calibration is not required. Start with 600 ms cast / 100 ms swap and adjust for your character's animations. Pause or lost game focus cancels pending steps; check your weapon set before the next press.</p>
    </fieldset>
    <div class="combat-controls">
      <button :disabled="!api || busy" @click="save(false)">Save settings</button>
      <button :disabled="!api || busy" @click="save(true)">{{ draft.sigilSequence.enabled ? 'Save & arm' : 'Save & start' }}</button>
      <button :disabled="!api" @click="stop">Stop</button>
      <button v-if="status?.reason.includes('rearm')" :disabled="busy" @click="rearm">Rearm emergency stop</button>
      <span v-if="dirty && status" class="muted">Unsaved changes. Save applies toggles and pauses the loop.</span>
    </div>
    <details :open="!draft.sigilSequence.enabled">
      <summary>{{ draft.sigilSequence.enabled ? 'Optional flask HUD calibration' : 'HUD calibration' }}</summary>
      <p v-if="draft.sigilSequence.enabled">The manual macro needs no HUD calibration. Only calibrate the globe and fixed HUD ornament for each auto flask you enable.</p>
      <p>Use windowed or borderless mode. Fill both globes, close panels, then capture. Switch to the game during the countdown and return here afterward.</p>
      <p class="muted">Globe percentages are visual estimates. Verify them in Preview before enabling keypresses. Recalibrate after changing resolution, HUD scale, skill or display colour settings.</p>
      <p class="muted">Drafts and screenshots stay available while you navigate this app. Save settings to keep the recorded detector references after restarting.</p>
      <ul class="combat-calibrations"><li v-for="name in calibrationNames" :key="name">{{ labels[name] }}: {{ draft.regions[name] ? 'Recorded' : 'Needed' }}<span v-if="isSkillModule(name)"> · Cooldown: {{ draft.regions[name]?.cooldown ? 'Recorded' : 'Needed' }}</span></li></ul>
      <div v-for="skill in skillPixels" :key="skill.name" class="recorded-icons" :aria-label="`Recorded ${skill.label} detector data`">
        <figure class="icon-sample">
          <svg v-if="skill.ready.length" class="recorded-icon" viewBox="0 0 16 16" role="img" :aria-label="`Recorded ready reference · ${skill.label}, 16 by 16 RGB samples`" shape-rendering="crispEdges"><rect v-for="(pixel, index) in skill.ready" :key="index" :x="pixel.x" :y="pixel.y" width="1" height="1" :fill="pixel.fill" /></svg>
          <p v-else>No {{ skill.label }} ready reference recorded.</p>
          <figcaption>{{ skill.label }} · recorded ready reference · 16 × 16 RGB samples</figcaption>
        </figure>
        <figure class="icon-sample">
          <svg v-if="skill.cooldown.length" class="recorded-icon" viewBox="0 0 16 16" role="img" :aria-label="`Recorded cooldown reference · ${skill.label}, 16 by 16 RGB samples`" shape-rendering="crispEdges"><rect v-for="(pixel, index) in skill.cooldown" :key="index" :x="pixel.x" :y="pixel.y" width="1" height="1" :fill="pixel.fill" /></svg>
          <p v-else>No {{ skill.label }} cooldown reference recorded.</p>
          <figcaption>{{ skill.label }} · recorded cooldown reference · 16 × 16 RGB samples</figcaption>
        </figure>
      </div>
      <div class="calibration-tabs" role="tablist" aria-label="Calibration screenshots">
        <button id="combat-hud-tab" role="tab" :aria-selected="activeTab === 'hud'" aria-controls="combat-hud-panel" :disabled="busy" @click="selectTab('hud')">HUD / ready</button>
        <template v-if="!draft.sigilSequence.enabled"><button v-for="name in SKILL_MODULES" :id="`combat-${cooldownTab(name)}-tab`" :key="name" role="tab" :aria-selected="activeTab === cooldownTab(name)" :aria-controls="`combat-${cooldownTab(name)}-panel`" :disabled="busy" @click="selectTab(cooldownTab(name))">{{ skillLabels[name] }} cooldown</button></template>
      </div>
      <div :id="`combat-${activeTab}-panel`" role="tabpanel" :aria-labelledby="`combat-${activeTab}-tab`">
        <div class="combat-controls">
          <button :disabled="!api || busy" @click="capture">{{ countdown ? `Switch to game — ${countdown}…` : activeTab === 'hud' ? 'Capture HUD / ready in 3 seconds' : 'Capture cooldown in 3 seconds' }}</button>
          <label v-if="activeTab === 'hud'">Region <select v-model="selection" @change="corner = undefined"><option v-for="name in calibrationNames" :key="name" :value="name">{{ labels[name] }}</option></select></label>
          <button v-else :disabled="!preview || busy || !screenshotMatchesHud" @click="recordCooldown">Record cooldown from screenshot</button>
        </div>
        <template v-if="activeTab === 'hud'">
          <p>{{ hint }}</p>
          <p>{{ corner ? 'Now click the opposite corner.' : 'Click two opposite corners on the screenshot to select the region.' }}</p>
        </template>
        <p v-else>Capture a separate screenshot just after you cast {{ skillLabels[activeSkill!] }} ({{ draft[activeSkill!].key === 'MOUSE5' ? 'Mouse Button 5' : draft[activeSkill!].key }}). Record cooldown samples the saved {{ skillLabels[activeSkill!] }} icon region from this screenshot. Your HUD / ready screenshot stays available on its tab.</p>
        <p v-if="preview" class="capture-time">{{ activeTab === 'hud' ? 'HUD / ready' : 'Cooldown' }} captured <time :datetime="preview.capturedAt">{{ new Date(preview.capturedAt).toLocaleTimeString() }}</time> · {{ preview.width }} × {{ preview.height }}</p>
        <p v-else>No screenshot captured on this tab yet.</p>
        <p v-if="preview && !screenshotMatchesHud" class="combat-error">Screenshot size differs from the calibrated HUD. Restore the same game resolution and capture again before recording.</p>
        <figure v-if="iconCropStyle" class="icon-sample">
          <div class="icon-crop" :style="iconCropStyle" role="img" :aria-label="`${activeTab === 'hud' ? 'HUD / ready' : 'Cooldown'} screenshot ${skillLabels[cropSkill]} icon crop`"></div>
          <figcaption>Current screenshot crop — recorded detector data is shown above.</figcaption>
        </figure>
        <div v-if="preview" class="hud-preview" :class="{ 'cooldown-preview': activeTab !== 'hud' }">
          <img :key="activeTab" ref="imageElement" :src="preview.image" :alt="activeTab === 'hud' ? 'Captured game HUD: click two corners to calibrate the selected region' : `Captured ${tabLabel(activeTab)} screenshot`" @click="pick">
          <template v-for="name in overlayNames" :key="name">
            <div v-if="draft.regions[name] && screenshotMatchesHud" class="hud-region" :style="{ left: `${draft.regions[name]!.x / preview.width * 100}%`, top: `${draft.regions[name]!.y / preview.height * 100}%`, width: `${draft.regions[name]!.width / preview.width * 100}%`, height: `${draft.regions[name]!.height / preview.height * 100}%` }"><span>{{ activeTab === 'hud' ? labels[name] : tabLabel(activeTab) }}</span></div>
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
