<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from "vue";
import { defaultFollowerConfig, parseFollowerConfig, type FollowReplayStep } from "../../../core/follower.js";
import { followerDemo } from "../../../core/followerReplay.js";
import type { PixelRect } from "../../../core/followerPerception.js";
import type { FollowerCapture, FollowerDriveStatus, FollowerPerceptionStatus, FollowerStatus } from "../../../shared/follower.js";

const api = window.poe2?.follower;
const config = ref(defaultFollowerConfig()), status = ref<FollowerStatus>();
const pairingKey = ref(""), showKey = ref(false), error = ref(""), pending = ref(false), loading = ref(!!api);
const steps = ref<FollowReplayStep[]>([]), stepIndex = ref(0);
const current = computed(() => steps.value[stepIndex.value]);
const connected = computed(() => status.value?.connection === "connected");
const active = computed(() => !!status.value && !["stopped", "error"].includes(status.value.connection));
const routePoints = computed(() => current.value?.decision.route.map(p => `${p.x * 30 + 15},${p.y * 30 + 15}`).join(" ") ?? "");
const perception = ref<FollowerPerceptionStatus>(), shot = ref<FollowerCapture>(), capturing = ref(false);
const selection = ref<"nameplate" | "searchArea">("nameplate"), corner = ref<{ x: number; y: number }>();
const regions = ref<{ nameplate?: PixelRect; searchArea?: PixelRect }>({});
const observed = computed(() => perception.value?.observation);
const drive = ref<FollowerDriveStatus>(), driveDraft = ref({ dryRun: true, mapScale: 7, clickIntervalMs: 110 }), driveBusy = ref(false), driveLoaded = ref(false);
const seen = computed(() => drive.value?.observation);
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, revision = 0;
async function refresh(): Promise<void> {
  const version = revision;
  try {
    const next = await api?.status(); if (!disposed && version === revision && next) status.value = next;
    const watched = await api?.perception(); if (!disposed && watched) perception.value = watched;
    const driving = await api?.driveStatus?.(); if (!disposed && driving) { drive.value = driving; if (!driveLoaded.value) { driveDraft.value = { dryRun: driving.settings.dryRun, mapScale: driving.settings.mapScale, clickIntervalMs: driving.settings.clickIntervalMs }; driveLoaded.value = true; } }
  }
  catch (e) { if (!disposed) error.value = String(e); }
  if (!disposed) timer = setTimeout(() => void refresh(), perception.value?.observing || perception.value?.recording || drive.value?.running ? 250 : 1000);
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
async function captureView(): Promise<void> {
  if (!api || capturing.value) return;
  capturing.value = true; error.value = "";
  try { const next = await api.capture(); if (!disposed) { shot.value = next; regions.value = {}; corner.value = undefined; selection.value = "nameplate"; } }
  catch (e) { if (!disposed) error.value = String(e); }
  finally { capturing.value = false; }
}
function pick(event: MouseEvent): void {
  if (!shot.value) return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const point = {
    x: Math.max(0, Math.min(shot.value.width - 1, Math.floor((event.clientX - bounds.left) * shot.value.width / bounds.width))),
    y: Math.max(0, Math.min(shot.value.height - 1, Math.floor((event.clientY - bounds.top) * shot.value.height / bounds.height))),
  };
  if (!corner.value) { corner.value = point; return; }
  const region = { x: Math.min(point.x, corner.value.x), y: Math.min(point.y, corner.value.y), width: Math.abs(point.x - corner.value.x) + 1, height: Math.abs(point.y - corner.value.y) + 1 };
  corner.value = undefined; regions.value[selection.value] = region;
}
async function perceive(action: "calibrate" | "clearCalibration" | "observe" | "stopObserving" | "record"): Promise<void> {
  if (!api) return;
  error.value = "";
  try {
    const next = action === "calibrate" ? await api.calibrate({ nameplate: regions.value.nameplate!, searchArea: regions.value.searchArea }) : action === "record" ? await api.record({ seconds: 20 }) : await api[action]();
    if (disposed) return;
    perception.value = next;
    if (action === "calibrate") { shot.value = undefined; regions.value = {}; }
  } catch (e) { if (!disposed) error.value = String(e); }
}
async function driving(action: "driveCalibrate" | "driveClearCalibration" | "driveStart" | "driveStop" | "driveConfigure"): Promise<void> {
  if (!api || driveBusy.value) return;
  driveBusy.value = true; error.value = "";
  try {
    const next = action === "driveConfigure" ? await api.driveConfigure({ version: 1, ...toRaw(driveDraft.value) }) : await api[action]();
    if (!disposed) drive.value = next;
  } catch (e) { if (!disposed) error.value = String(e); }
  finally { driveBusy.value = false; }
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
      <strong>Connection, route preview, observation preview, and following by the overlay map are ready.</strong>
      <span>Loot pickup, area transitions, and two-PC route sharing are still in development. Following starts only when you press Start and defaults to a preview that sends no clicks. Connecting the PCs does not move a character or pick up items.</span>
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
    <section class="card follower-section" aria-labelledby="follower-drive-title">
      <div class="follower-preview-header">
        <div><h3 id="follower-drive-title">Follow by overlay map</h3><p class="muted">Reads {{ config.targetName || 'the leader' }}'s green marker on this PC's overlay map and left-clicks toward it. Needs the overlay map open (Tab), mouse movement (not WASD), and the leader in the same area.</p></div>
        <div class="follower-actions">
          <button :disabled="!api || driveBusy || drive?.running" @click="driving('driveCalibrate')">{{ driveBusy ? 'Working…' : 'Calibrate on overlay map' }}</button>
          <button v-if="!drive?.running" :disabled="!api || driveBusy || !drive?.calibration || !!drive?.calibrationIssue" @click="driving('driveStart')">{{ drive?.dryRun ?? true ? 'Start preview (no clicks)' : 'Start following' }}</button>
          <button v-else @click="driving('driveStop')">Stop following</button>
        </div>
      </div>
      <p class="muted" role="status">{{ drive?.reason ?? 'Calibrate on the overlay map, then start following.' }}</p>
      <p v-if="drive?.calibrationIssue" class="follower-error" role="alert">{{ drive.calibrationIssue }}</p>
      <p v-if="drive?.calibration">Calibrated on <strong>{{ drive.calibration.targetName }}</strong>'s map label at {{ drive.calibration.view.width }} × {{ drive.calibration.view.height }} · map centre {{ drive.calibration.origin.x }}, {{ drive.calibration.origin.y }} · {{ drive.calibration.labelPixels }} label pixels <button class="follower-link" :disabled="drive.running" @click="driving('driveClearCalibration')">Clear</button></p>
      <pre v-if="drive?.calibration" class="follower-mask" :aria-label="`Captured map label, which should read ${drive.calibration.targetName}`">{{ drive.calibration.labelMask.map(row => row.replace(/\./g, ' ').replace(/#/g, '█')).join('\n') }}</pre>
      <p v-if="drive?.calibration" class="muted">Check that the captured label above reads {{ drive.calibration.targetName }}. Calibration cannot read names: it takes the only party label on the map.</p>
      <fieldset :disabled="driveBusy || drive?.running" class="follower-fields follower-drive-fields">
        <label class="follower-check"><input v-model="driveDraft.dryRun" type="checkbox" />Preview only — decide and trace, but send no clicks</label>
        <label>Map scale · screen pixels per map pixel<input v-model.number="driveDraft.mapScale" type="number" min="2" max="20" step="0.5" /></label>
        <label>Minimum time between movement clicks · ms<input v-model.number="driveDraft.clickIntervalMs" type="number" min="100" max="1000" step="10" /></label>
        <div class="follower-actions"><button type="button" :disabled="!api" @click="driving('driveConfigure')">Save follow settings</button><small v-if="drive && drive.dryRun && !drive.settings.dryRun">The app-wide Dry-run switch is on, so no clicks are sent.</small></div>
      </fieldset>
      <dl v-if="drive?.running" class="follower-observation" aria-label="Follow state">
        <div><dt>Leader</dt><dd>{{ !seen ? 'No observation' : seen.leaderFound ? `${seen.identity.name} · ${seen.offset!.distance} map px away` : 'Label not visible' }}</dd></div>
        <div><dt>Decision</dt><dd>{{ drive.decision ? `${drive.decision.kind} — ${drive.decision.reason}` : '—' }}</dd></div>
        <div><dt>Confidence</dt><dd>{{ seen ? `${Math.round(seen.confidence * 100)}% · match ${seen.evidence.score} · next best ${seen.evidence.runnerUp}` : '—' }}</dd></div>
        <div><dt>Map centre</dt><dd>{{ seen ? (seen.originVerified ? 'Your marker is in place' : 'Your marker is not where calibration put it') : '—' }}</dd></div>
        <div><dt>Speed</dt><dd v-if="drive.stats">{{ drive.stats.observationsPerSecond }} observations/s · cycle {{ drive.stats.cycleMsP50 }} / {{ drive.stats.cycleMsP95 }} ms (median / 95th)</dd><dd v-else>—</dd></div>
        <div><dt>Input</dt><dd v-if="drive.stats">{{ drive.stats.clicks }} clicks · {{ drive.stats.previewed }} previewed · {{ drive.stats.refused }} refused · {{ drive.stats.manualTakeovers }} manual takeovers<span v-if="drive.stats.captureToInputMsP95 !== undefined"> · capture→click {{ drive.stats.captureToInputMsP50 }} / {{ drive.stats.captureToInputMsP95 }} ms</span></dd><dd v-else>—</dd></div>
      </dl>
      <p class="muted">Moving the mouse or holding a mouse button takes control back for a moment; Ctrl+Shift+Esc stops everything. It never clicks when it cannot see the label, and it cannot yet follow through doors, portals, or area transitions.</p>
    </section>
    <section class="card follower-section" aria-labelledby="follower-observe-title">
      <div class="follower-preview-header">
        <div><h3 id="follower-observe-title">Live observation preview</h3><p class="muted">Watches this PC's game view for the selected character's nameplate. It sends no game input and shares nothing with the other PC.</p></div>
        <div class="follower-actions">
          <button :disabled="!api || capturing" @click="captureView">{{ capturing ? 'Waiting for the game…' : 'Capture game view' }}</button>
          <button v-if="!perception?.observing" :disabled="!api || !perception?.calibration || !!perception?.calibrationIssue" @click="perceive('observe')">Start observation</button>
          <button v-else @click="perceive('stopObserving')">Stop observation</button>
          <button v-if="!perception?.recording" :disabled="!api || capturing" @click="perceive('record')">Record 20 s for testing</button>
          <button v-else @click="perceive('stopObserving')">Stop recording ({{ Math.ceil(perception.recording.remainingMs / 1000) }} s)</button>
        </div>
      </div>
      <p v-if="!api" class="muted">Open the desktop app on the follower PC to capture the game.</p>
      <p class="muted" role="status">{{ perception?.reason ?? 'Capture the game view to calibrate.' }}</p>
      <p v-if="perception?.calibrationIssue" class="follower-error" role="alert">{{ perception.calibrationIssue }}</p>
      <p v-if="perception?.calibration">Calibrated for <strong>{{ perception.calibration.targetName }}</strong> at {{ perception.calibration.view.width }} × {{ perception.calibration.view.height }} · {{ perception.calibration.templatePixels }} text pixels · <time :datetime="perception.calibration.calibratedAt">{{ new Date(perception.calibration.calibratedAt).toLocaleString() }}</time> <button class="follower-link" @click="perceive('clearCalibration')">Clear calibration</button></p>
      <p v-if="perception?.lastRecording" class="muted">Last recording: {{ perception.lastRecording.frames }} frames in <code>{{ perception.lastRecording.directory }}</code>. Recordings are full game screenshots kept on this PC; they are never sent to the other PC.</p>
      <div v-if="shot" class="follower-calibrate">
        <div class="follower-actions">
          <label>Select <select v-model="selection" @change="corner = undefined"><option value="nameplate">Leader's name text</option><option value="searchArea">Search area (optional)</option></select></label>
          <button :disabled="!regions.nameplate" @click="perceive('calibrate')">Save calibration</button>
          <button @click="shot = undefined">Discard screenshot</button>
        </div>
        <p class="muted">{{ corner ? 'Now click the opposite corner.' : selection === 'nameplate' ? 'With the leader on screen, click two opposite corners tightly around the name above their character.' : 'Click two opposite corners of the area to search. Exclude the party panel if it shows the same name.' }}</p>
        <div class="follower-shot" @click="pick">
          <img :src="shot.image" :alt="`Captured game view, ${shot.width} by ${shot.height}`" draggable="false" />
          <svg :viewBox="`0 0 ${shot.width} ${shot.height}`" aria-hidden="true">
            <rect v-if="regions.searchArea" v-bind="regions.searchArea" fill="none" stroke="#72c5ff" stroke-width="3" stroke-dasharray="12 8" />
            <rect v-if="regions.nameplate" v-bind="regions.nameplate" fill="none" stroke="#99e3bc" stroke-width="3" />
          </svg>
        </div>
      </div>
      <dl v-if="perception?.observing" class="follower-observation" aria-label="Current observation">
        <div><dt>Identity</dt><dd>{{ observed ? `${observed.identity.name} · nameplate template` : '—' }}</dd></div>
        <div><dt>Sighting</dt><dd>{{ !observed ? 'No observation' : observed.found ? `Nameplate at ${observed.position!.x}, ${observed.position!.y} px` : 'Not visible' }}</dd></div>
        <div><dt>Confidence</dt><dd>{{ observed ? `${Math.round(observed.confidence * 100)}%` : '—' }}<span v-if="observed && status && observed.confidence < status.config.confidence" class="muted"> · below your {{ Math.round(status.config.confidence * 100) }}% minimum</span></dd></div>
        <div><dt>Evidence</dt><dd v-if="observed">Match {{ observed.evidence.score }} · next best {{ observed.evidence.runnerUp }} · {{ observed.evidence.matchedPixels }} / {{ observed.evidence.templatePixels }} text pixels · {{ observed.evidence.candidates }} candidate(s) · {{ observed.evidence.searched === 'full' ? 'full search' : 'tracking window' }}</dd><dd v-else>—</dd></div>
        <div><dt>Observation age</dt><dd>{{ observed ? `${observed.ageMs} ms` : '—' }}</dd></div>
        <div><dt>Timing</dt><dd v-if="observed">Capture {{ observed.timing.captureMs }} ms · match {{ observed.timing.matchMs }} ms<span v-if="perception.stats"> · cycle {{ perception.stats.cycleMs }} ms · {{ perception.stats.observationsPerSecond }} observations/s</span></dd><dd v-else>—</dd></div>
      </dl>
      <p class="muted">Accuracy on real gameplay has not been measured yet. Recalibrate after changing resolution, window size, UI scale, or the character to follow.</p>
    </section>
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
.follower-calibrate { display: grid; gap: 12px; margin: 16px 0; }
.follower-mask { margin: 8px 0; padding: 8px 10px; width: max-content; max-width: 100%; overflow-x: auto; background: #0b1018; border-radius: 6px; color: #7fe39a; font: 4px/4px monospace; letter-spacing: 0; }
.follower-drive-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 16px; }
.follower-drive-fields > :first-child, .follower-drive-fields > :last-child { grid-column: 1 / -1; }
.follower-shot { position: relative; cursor: crosshair; line-height: 0; border: 1px solid #344353; border-radius: 8px; overflow: hidden; }
.follower-shot img { width: 100%; user-select: none; }
.follower-shot svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.follower-observation { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 16px 0; font-size: 13px; }
.follower-observation dt { color: #8fc6e8; font-size: 11px; letter-spacing: .8px; text-transform: uppercase; }
.follower-observation dd { margin: 4px 0 0; line-height: 1.5; }
.follower-tool .follower-link { border: 0; background: none; padding: 0 0 0 8px; color: #acd8f4; text-decoration: underline; }
.follower-error { padding: 12px; color: #ffb3b3; background: #461f29; border-radius: 6px; }
@media (max-width: 1000px) { .follower-grid, .follower-preview, .follower-observation { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .follower-header, .follower-preview-header { flex-direction: column; } }
</style>
