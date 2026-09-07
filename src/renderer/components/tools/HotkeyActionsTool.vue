<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { hotkeysApi } from "../../services/rendererApi";
import type { FlaskProbePayload, HotkeysStatePayload } from "../../../shared/ipc.js";
import {
  describeRgb,
  FLASK_GLOBES,
  type FlaskGlobe,
  type FlaskGuardConfig,
  type Rgb,
} from "../../../shared/flaskGuard.js";

const state = ref<(HotkeysStatePayload & { preview: boolean }) | null>(null);
const draft = ref<Record<string, number | null>>({});
const issues = ref<string[]>([]);
const savedNote = ref("");
const daemon = ref<{ exists: boolean; lastEventAt?: string; lastLine?: string }>({ exists: false });

const bindableKeys = [1, 2, 3, 4, 6, 7];

const dirty = computed(() => {
  if (!state.value) return false;
  return Object.keys(draft.value).some(
    (id) => draft.value[id] !== state.value?.bindings[id],
  );
});

const daemonSummary = computed(() => {
  if (!daemon.value.exists) {
    return "Daemon log not found — the hotkey daemon has never run here.";
  }
  const when = daemon.value.lastEventAt
    ? new Date(daemon.value.lastEventAt).toLocaleString()
    : "unknown";
  return `Last daemon activity: ${when}`;
});

function keyTakenBy(key: number, exceptId: string): string | undefined {
  if (!state.value) return undefined;
  const holder = state.value.actions.find(
    (action) => action.id !== exceptId && draft.value[action.id] === key,
  );
  return holder?.label;
}

function setKey(actionId: string, raw: string): void {
  savedNote.value = "";
  draft.value = { ...draft.value, [actionId]: raw === "" ? null : Number(raw) };
}

async function save(): Promise<void> {
  const result = await hotkeysApi.save(draft.value);
  issues.value = result.issues;
  draft.value = { ...result.bindings };
  if (state.value) state.value = { ...state.value, bindings: { ...result.bindings } };
  savedNote.value = result.preview
    ? "Preview mode — bindings were validated but not persisted (no native bridge)."
    : "Saved. A running daemon picks the change up on its next keypress.";
}

function revert(): void {
  if (state.value) draft.value = { ...state.value.bindings };
  issues.value = [];
  savedNote.value = "";
}

async function refreshDaemon(): Promise<void> {
  daemon.value = await hotkeysApi.daemonStatus();
}

// ---- Auto-flask guard -------------------------------------------------------
const flask = ref<FlaskGuardConfig | null>(null);
const flaskSaved = ref<FlaskGuardConfig | null>(null);
const flaskIssues = ref<string[]>([]);
const flaskNote = ref("");
const flaskBusy = ref<"" | FlaskGlobe | "probe">("");
const flaskProbe = ref<FlaskProbePayload | null>(null);

const flaskDirty = computed(
  () => JSON.stringify(flask.value) !== JSON.stringify(flaskSaved.value),
);
const anyCalibrated = computed(() =>
  FLASK_GLOBES.some((globe) => Boolean(flask.value?.[globe].point)),
);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function swatch(rgb: Rgb | null): string {
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "transparent";
}

function calibratedLabel(globe: FlaskGlobe): string {
  const probe = flask.value?.[globe];
  if (!probe?.point || !probe.reference) return "Not calibrated";
  const when = probe.calibratedAt ? new Date(probe.calibratedAt).toLocaleString() : "";
  return `(${probe.point.x}, ${probe.point.y}) · ${describeRgb(probe.reference)}${when ? ` · ${when}` : ""}`;
}

function probeFor(globe: FlaskGlobe): FlaskProbePayload["probes"][number] | undefined {
  return flaskProbe.value?.probes.find((probe) => probe.globe === globe);
}

async function saveFlask(): Promise<void> {
  if (!flask.value) return;
  const result = await hotkeysApi.flaskSave(flask.value);
  flaskIssues.value = result.issues;
  flask.value = clone(result.config);
  flaskSaved.value = clone(result.config);
  flaskNote.value = result.preview
    ? "Preview mode — validated but not persisted (no native bridge)."
    : "Saved. A running daemon applies it within a second.";
}

function revertFlask(): void {
  if (flaskSaved.value) flask.value = clone(flaskSaved.value);
  flaskIssues.value = [];
  flaskNote.value = "";
}

async function calibrate(globe: FlaskGlobe): Promise<void> {
  if (!flask.value) return;
  flaskBusy.value = globe;
  flaskProbe.value = null;
  flaskNote.value = `Switch to the game and click the ${globe.toUpperCase()} globe at the height where the flask should fire — keep it filled above that point (30 s)…`;
  try {
    const result = await hotkeysApi.flaskCalibrate(globe);
    if (!result.ok || !result.point || !result.rgb) {
      flaskNote.value = `${globe} calibration failed: ${result.error ?? "no click"}`;
      return;
    }
    const patch = {
      point: result.point,
      reference: result.rgb,
      calibratedAt: new Date().toISOString(),
    };
    flask.value = { ...flask.value, [globe]: { ...flask.value[globe], ...patch } };
    if (result.config) {
      flaskSaved.value = clone(result.config);
    } else if (flaskSaved.value) {
      flaskSaved.value = { ...flaskSaved.value, [globe]: { ...flaskSaved.value[globe], ...patch } };
    }
    flaskNote.value = result.looksFilled
      ? `${globe} trigger set at (${result.point.x}, ${result.point.y}), colour ${describeRgb(result.rgb)}.`
      : `${globe} point saved, but ${describeRgb(result.rgb)} reads as empty glass or chrome, not fluid — was the globe filled above the click? Calibrate again to fix.`;
  } finally {
    flaskBusy.value = "";
  }
}

async function testNow(): Promise<void> {
  flaskBusy.value = "probe";
  try {
    const result = await hotkeysApi.flaskProbe();
    flaskProbe.value = result;
    flaskNote.value = result.ok
      ? `Sampled just now${result.foregroundIsPoe ? "" : " (the game was not in front)"}.`
      : `Sample failed: ${result.error ?? "unknown"}`;
  } finally {
    flaskBusy.value = "";
  }
}

onMounted(async () => {
  const loaded = await hotkeysApi.load();
  state.value = loaded;
  draft.value = { ...loaded.bindings };
  issues.value = loaded.issues;
  await refreshDaemon();
  const flaskLoaded = await hotkeysApi.flaskLoad();
  flask.value = clone(flaskLoaded.config);
  flaskSaved.value = clone(flaskLoaded.config);
  flaskIssues.value = flaskLoaded.issues;
});
</script>

<template>
  <div class="hotkeys-stack">
    <section class="card tool-panel hotkeys-tool" aria-labelledby="hotkeys-title">
      <header>
        <h2 id="hotkeys-title">Numpad hotkey actions</h2>
        <p class="muted">
          One-press game actions handled by the standalone hotkey daemon — start it with
          <code>npm run actions:daemon</code>. Bindings save to
          <code>artifacts/hotkey-bindings.json</code> and apply to a running daemon immediately.
        </p>
      </header>

      <p class="daemon-status" :class="{ live: daemon.exists }">
        {{ daemonSummary }}
        <button type="button" class="ghost" @click="refreshDaemon">Refresh</button>
      </p>

      <table v-if="state" class="bindings">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Action</th>
            <th scope="col">Where</th>
            <th scope="col">What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="action in state.actions" :key="action.id">
            <td>
              <select
                :value="draft[action.id] ?? ''"
                :aria-label="`Key for ${action.label}`"
                @change="setKey(action.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">Unbound</option>
                <option
                  v-for="key in bindableKeys"
                  :key="key"
                  :value="key"
                  :disabled="Boolean(keyTakenBy(key, action.id))"
                >
                  Num{{ key }}{{ keyTakenBy(key, action.id) ? ` — ${keyTakenBy(key, action.id)}` : "" }}
                </option>
              </select>
            </td>
            <td><strong>{{ action.label }}</strong></td>
            <td><span class="context-chip" :class="action.context">{{ action.context }}</span></td>
            <td class="muted">{{ action.detail }}</td>
          </tr>
        </tbody>
      </table>

      <div class="actions-row">
        <button type="button" :disabled="!dirty" @click="save">Save bindings</button>
        <button type="button" class="ghost" :disabled="!dirty" @click="revert">Revert</button>
        <span v-if="savedNote" class="muted">{{ savedNote }}</span>
      </div>
      <ul v-if="issues.length" class="issues">
        <li v-for="issue in issues" :key="issue">{{ issue }}</li>
      </ul>

      <details>
        <summary>Reserved control keys (always active during a run)</summary>
        <ul v-if="state" class="reserved">
          <li v-for="entry in state.reserved" :key="entry.key">
            <strong>Num{{ entry.key }}</strong> — {{ entry.label }}
          </li>
        </ul>
      </details>
    </section>

    <section class="card tool-panel flask-guard" aria-labelledby="flask-title">
      <header>
        <h2 id="flask-title">Auto-flask</h2>
        <p class="muted">
          While the daemon runs, it watches the life and mana globes and presses the flask key the
          moment the fluid drops below your trigger point (about 30–60 ms). Calibrate by clicking
          each globe at the height where its flask should fire. Keys default to the game's
          <strong>1</strong> (life) and <strong>2</strong> (mana). <strong>Numpad −</strong>
          pauses / resumes it in game.
        </p>
      </header>

      <template v-if="flask">
        <label class="toggle-field">
          <input v-model="flask.enabled" type="checkbox" />
          <span>Enable auto-flask</span>
        </label>

        <table class="bindings flask-table">
          <thead>
            <tr>
              <th scope="col">Globe</th>
              <th scope="col">On</th>
              <th scope="col">Key</th>
              <th scope="col">Cooldown</th>
              <th scope="col">Trigger point</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="globe in FLASK_GLOBES" :key="globe">
              <td><strong class="globe-name" :class="globe">{{ globe }}</strong></td>
              <td>
                <input
                  v-model="flask[globe].enabled"
                  type="checkbox"
                  :aria-label="`Enable ${globe} flask`"
                />
              </td>
              <td>
                <input
                  v-model="flask[globe].key"
                  class="key-input"
                  maxlength="1"
                  :aria-label="`${globe} flask key`"
                />
              </td>
              <td>
                <input
                  v-model.number="flask[globe].cooldownMs"
                  class="cooldown-input"
                  type="number"
                  min="250"
                  max="60000"
                  step="250"
                  :aria-label="`${globe} flask cooldown in milliseconds`"
                />
                <span class="muted">ms</span>
              </td>
              <td>
                <span
                  v-if="flask[globe].reference"
                  class="swatch"
                  :style="{ background: swatch(flask[globe].reference) }"
                ></span>
                <span :class="{ muted: !flask[globe].point }">{{ calibratedLabel(globe) }}</span>
                <span
                  v-if="probeFor(globe)"
                  class="state-chip"
                  :class="probeFor(globe)?.state"
                  :title="`now ${describeRgb(probeFor(globe)!.rgb)} · needs chroma ≥ ${probeFor(globe)!.thresholds.minChroma}, brightness ≥ ${probeFor(globe)!.thresholds.minBright}`"
                >
                  {{ probeFor(globe)?.state }} now
                </span>
              </td>
              <td>
                <button
                  type="button"
                  class="ghost"
                  :disabled="flaskBusy !== ''"
                  @click="calibrate(globe)"
                >
                  {{ flaskBusy === globe ? "Click the globe…" : "Calibrate by clicking" }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="actions-row">
          <button type="button" :disabled="!flaskDirty" @click="saveFlask">Save auto-flask</button>
          <button type="button" class="ghost" :disabled="!flaskDirty" @click="revertFlask">Revert</button>
          <button
            type="button"
            class="ghost"
            :disabled="flaskBusy !== '' || !anyCalibrated"
            @click="testNow"
          >
            {{ flaskBusy === "probe" ? "Sampling…" : "Test now" }}
          </button>
          <span v-if="flaskNote" class="muted">{{ flaskNote }}</span>
        </div>
        <ul v-if="flaskIssues.length" class="issues">
          <li v-for="issue in flaskIssues" :key="issue">{{ issue }}</li>
        </ul>

        <details class="advanced-options">
          <summary>Expert: detection thresholds</summary>
          <div class="form-grid">
            <label>
              Extra delay per tick (ms)
              <input v-model.number="flask.intervalMs" type="number" min="0" max="500" />
            </label>
            <label>
              Chroma ratio (0.1–0.95)
              <input v-model.number="flask.chromaRatio" type="number" min="0.1" max="0.95" step="0.05" />
            </label>
            <label>
              Brightness ratio (0.1–0.95)
              <input v-model.number="flask.brightRatio" type="number" min="0.1" max="0.95" step="0.05" />
            </label>
            <label>
              Stale after (ms)
              <input v-model.number="flask.staleAfterMs" type="number" min="1000" max="600000" step="1000" />
            </label>
            <label>
              Stale cooldown (ms)
              <input v-model.number="flask.staleCooldownMs" type="number" min="1000" max="600000" step="1000" />
            </label>
          </div>
          <p class="muted">
            A globe reads "filled" while the patch at its trigger point keeps at least these fractions
            of the calibrated colour's chroma and brightness — hue doesn't matter, so energy shield
            over life still counts. A press never happens before the HUD has been seen filled once.
            Stale = no filled read for that long (death screen, passive tree, loading), after which
            presses slow to the stale cooldown. The daemon only presses while Path of Exile 2 is the
            foreground window.
          </p>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.hotkeys-stack {
  display: grid;
  gap: 1rem;
}
.hotkeys-tool code {
  font-size: 0.85em;
}
.daemon-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-muted, #9aa);
}
.daemon-status.live {
  color: inherit;
}
.bindings {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
}
.bindings th,
.bindings td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  vertical-align: top;
}
.flask-table td {
  vertical-align: middle;
}
.context-chip {
  font-size: 0.75em;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-chip.map {
  color: #6fb3ff;
}
.context-chip.hideout {
  color: #c9a86a;
}
.globe-name {
  text-transform: capitalize;
}
.globe-name.life {
  color: #e0554f;
}
.globe-name.mana {
  color: #5f9cf0;
}
.key-input {
  width: 3rem;
  text-align: center;
  text-transform: lowercase;
}
.cooldown-input {
  width: 6rem;
}
.swatch {
  display: inline-block;
  width: 0.9rem;
  height: 0.9rem;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  margin-right: 0.4rem;
  vertical-align: -2px;
}
.state-chip {
  margin-left: 0.5rem;
  font-size: 0.75em;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.state-chip.filled {
  color: #5fcf7a;
}
.state-chip.low {
  color: #e0554f;
}
.actions-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.issues {
  color: #d08a3e;
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
}
.reserved {
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
}
.muted {
  color: var(--text-muted, #9aa);
}
button.ghost {
  background: transparent;
}
</style>
