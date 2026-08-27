<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { searchScenarioQuery } from "@core/itemClassFilter";
import {
  DEFAULT_VOICE_TRANSFER_CONFIG,
  type VoiceTransferConfig,
  type VoiceTransferState,
  type VoiceTransferStatus,
} from "@core/voiceTransfer";
import {
  getAssistiveApi,
  type AssistiveRunEvent,
  type AssistiveRunKind,
  type AssistiveRunResult,
} from "./services/rendererApi";

interface TransferStatus {
  running: boolean;
  killLatched: boolean;
  mode: string;
  qaOptIn: boolean;
  stashTab: "normal" | "quad";
  searchCalibrated: boolean;
  last?: AssistiveRunResult;
}

interface MemoryStatus {
  scenarioKey: string;
  confirmed: number;
  blockedReturns: number;
  lastWithdrawn: number;
  updatedAt: string;
}

const status = ref<TransferStatus>({
  running: false,
  killLatched: false,
  mode: "public-companion",
  qaOptIn: false,
  stashTab: "normal",
  searchCalibrated: false,
});
const dryRun = ref(true);
const qaAcknowledged = ref(false);
const uniqueAcrossCycles = ref(false);
const classQuery = ref("");
const allowlist = ref("PathOfExileSteam.exe, PathOfExile.exe, PathOfExile_x64Steam.exe");
const actionsPerMinute = ref(240);
const maxItems = ref(0);
const events = ref<AssistiveRunEvent[]>([]);
const lastResult = ref<AssistiveRunResult | null>(null);
const memory = ref<MemoryStatus | null>(null);
const error = ref("");
const voiceState = ref<VoiceTransferStatus>({
  phase: "idle",
  updatedAt: new Date().toISOString(),
  config: { ...DEFAULT_VOICE_TRANSFER_CONFIG },
  hotkeyRegistered: false,
});
const voiceEnabled = ref(DEFAULT_VOICE_TRANSFER_CONFIG.enabled);
const voiceHotkey = ref(DEFAULT_VOICE_TRANSFER_CONFIG.hotkey);
const voiceLiteralFallback = ref(DEFAULT_VOICE_TRANSFER_CONFIG.allowLiteralFallback);
const voiceTimeoutMs = ref(DEFAULT_VOICE_TRANSFER_CONFIG.recognitionTimeoutMs);
const voiceMinimumConfidence = ref(DEFAULT_VOICE_TRANSFER_CONFIG.minimumConfidence);
const voiceError = ref("");
const voiceSaved = ref("");
let voiceSettingsLoaded = false;

const runtime = getAssistiveApi;

const wantedClasses = computed(() =>
  classQuery.value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const memoryQuery = computed(() => searchScenarioQuery(wantedClasses.value));
const stashTab = computed(() => status.value.stashTab);
const searchReady = computed(
  () => status.value.searchCalibrated || (dryRun.value && wantedClasses.value.length === 0),
);
const liveReady = computed(
  () =>
    status.value.mode === "authorized-qa" &&
    status.value.qaOptIn &&
    qaAcknowledged.value &&
    status.value.searchCalibrated &&
    !status.value.killLatched,
);
const canStart = computed(
  () =>
    !status.value.running &&
    !status.value.killLatched &&
    status.value.mode === "authorized-qa" &&
    searchReady.value &&
    (dryRun.value || liveReady.value),
);
const voiceActive = computed(() =>
  ["listening", "recognized", "transferring"].includes(voiceState.value.phase),
);
const canListen = computed(
  () =>
    voiceEnabled.value &&
    status.value.mode === "authorized-qa" &&
    status.value.searchCalibrated &&
    !status.value.running &&
    !status.value.killLatched &&
    (dryRun.value || liveReady.value),
);

const VOICE_ERROR_TEXT: Record<string, string> = {
  "authorized-qa-build-required": "Voice transfer is available only in the authorized QA build.",
  "assistive-run-already-running": "Another audited transfer is already running.",
  "kill-switch-latched": "The emergency stop is latched. Re-arm it before listening.",
  "stash-search-not-calibrated": "Calibrate the stash search box before using voice transfer.",
  "qa-local-opt-in-required": "Live voice transfer requires POE2_QA_OPT_IN=1 at startup.",
  "qa-acknowledgement-required": "Enable the authorized QA acknowledgement before live voice transfer.",
  "process-allowlist-required": "Add an allowed Path of Exile process before live voice transfer.",
  "speech-engine-unavailable": "No local Windows System.Speech recognizer is installed.",
  "speech-audio-input-unavailable": "The local speech recognizer could not access a microphone.",
  "speech-timeout": "No speech was recognized before the one-shot timeout.",
  "voice-no-speech": "No speech was recognized.",
  "voice-confidence-too-low": "Speech confidence was below the configured threshold.",
  "voice-command-not-supported": "That phrase is not a supported item class or enabled literal search.",
  "voice-literal-search-unsafe": "The literal phrase was too broad or unsafe, so nothing was transferred.",
  "voice-hotkey-registration-failed": "Windows could not register that hotkey; choose another combination.",
  "voice-hotkey-reserved": "That hotkey is reserved for an existing safety or price-check action.",
  "invalid-voice-hotkey": "Enter a valid modified Electron hotkey such as CommandOrControl+Alt+V.",
};

function friendlyVoiceError(value: string): string {
  if (!value) return "";
  const match = Object.entries(VOICE_ERROR_TEXT).find(([code]) => value.includes(code));
  return match?.[1] ?? value;
}

function applyVoiceStatus(next: VoiceTransferStatus, loadConfig = false) {
  voiceState.value = next;
  if (!loadConfig || voiceSettingsLoaded) return;
  const config = next.config;
  voiceEnabled.value = config.enabled;
  voiceHotkey.value = config.hotkey;
  voiceLiteralFallback.value = config.allowLiteralFallback;
  voiceTimeoutMs.value = config.recognitionTimeoutMs;
  voiceMinimumConfidence.value = config.minimumConfidence;
  dryRun.value = config.dryRun;
  qaAcknowledged.value = config.qaAcknowledged;
  allowlist.value = config.allowlist.join(", ");
  actionsPerMinute.value = config.actionsPerMinute;
  maxItems.value = config.maxItems ?? 0;
  voiceSettingsLoaded = true;
}

function voiceConfig(): VoiceTransferConfig {
  return {
    enabled: voiceEnabled.value,
    hotkey: voiceHotkey.value.trim(),
    dryRun: dryRun.value,
    qaAcknowledged: qaAcknowledged.value,
    allowlist: allowlist.value.split(",").map((entry) => entry.trim()).filter(Boolean),
    actionsPerMinute: Math.max(1, Math.floor(actionsPerMinute.value)),
    maxItems: maxItems.value > 0 ? Math.floor(maxItems.value) : 0,
    allowLiteralFallback: voiceLiteralFallback.value,
    recognitionTimeoutMs: Math.floor(voiceTimeoutMs.value),
    minimumConfidence: Number(voiceMinimumConfidence.value),
  };
}

async function refresh() {
  const api = runtime();
  if (!api) {
    error.value = "Open Transfers in the Electron app.";
    return;
  }
  status.value = await api.status();
  lastResult.value = status.value.last ?? lastResult.value;
  applyVoiceStatus(await api.voice.status(), true);
  await refreshMemory();
}

async function refreshMemory() {
  const api = runtime();
  if (!api) return;
  memory.value = await api.memoryStatus({ stashTab: stashTab.value, query: memoryQuery.value });
}

async function start(kind: AssistiveRunKind) {
  const api = runtime();
  if (!api || !canStart.value) return;
  error.value = "";
  events.value = [];
  try {
    status.value = { ...status.value, running: true };
    lastResult.value = await api.start({
      kind,
      dryRun: dryRun.value,
      wantedClasses: wantedClasses.value,
      uniqueAcrossCycles: uniqueAcrossCycles.value,
      qaAcknowledged: qaAcknowledged.value,
      allowlist: allowlist.value.split(",").map((entry) => entry.trim()).filter(Boolean),
      actionsPerMinute: Math.max(1, actionsPerMinute.value),
      maxItems: maxItems.value > 0 ? Math.floor(maxItems.value) : undefined,
    });
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    await refresh();
  }
}

async function stop() {
  const api = runtime();
  if (!api) return;
  status.value = await api.stop();
}

async function rearm() {
  const api = runtime();
  if (!api) return;
  await api.rearm();
  await refresh();
}

async function resetMemory() {
  const api = runtime();
  if (!api) return;
  memory.value = await api.resetMemory({ stashTab: stashTab.value, query: memoryQuery.value });
}

async function saveVoiceSettings(): Promise<boolean> {
  const api = runtime();
  if (!api) return false;
  voiceError.value = "";
  voiceSaved.value = "";
  try {
    applyVoiceStatus(await api.voice.configure(voiceConfig()));
    voiceSaved.value = !voiceState.value.config.enabled
      ? "Saved. Voice hotkey disabled."
      : voiceState.value.hotkeyRegistered
        ? `Saved. Press ${voiceState.value.config.hotkey} for one-shot listening.`
        : "Saved. Voice hotkey is available only in the authorized QA build.";
    return true;
  } catch (reason) {
    voiceError.value = reason instanceof Error ? reason.message : String(reason);
    return false;
  }
}

async function listenOnce() {
  const api = runtime();
  if (!api || !canListen.value) return;
  if (!(await saveVoiceSettings())) return;
  voiceError.value = "";
  try {
    await api.voice.trigger();
    applyVoiceStatus(await api.voice.status());
  } catch (reason) {
    voiceError.value = reason instanceof Error ? reason.message : String(reason);
  }
}

async function cancelVoice() {
  const api = runtime();
  if (!api) return;
  await api.voice.cancel();
  applyVoiceStatus(await api.voice.status());
  await refresh();
}

onMounted(() => {
  const api = runtime();
  if (!api) {
    error.value = "Open Transfers in the Electron app.";
    return;
  }
  removeEventListener = api.onEvent((event) => {
    events.value = [...events.value.slice(-39), event];
    if (event.phase === "complete" || event.phase === "stopped") void refresh();
  });
  removeVoiceListener = api.voice.onState((state) => {
    applyVoiceStatus(state);
    if (state.error) voiceError.value = state.error;
    if (state.phase === "complete" || state.phase === "cancelled" || state.phase === "error") {
      void refresh();
    }
  });
  void refresh();
  refreshTimer = window.setInterval(() => void refresh(), 1500);
});

let refreshTimer: number | undefined;
let removeEventListener: (() => void) | undefined;
let removeVoiceListener: (() => void) | undefined;

onUnmounted(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  removeEventListener?.();
  removeVoiceListener?.();
});
</script>

<template>
  <section class="transfer-layout">
    <div class="card">
      <h2>Reliable stash transfers</h2>
      <p>
        Mode <strong>{{ status.mode }}</strong> ·
        <span :class="status.qaOptIn ? 'ok' : 'no'">local QA opt-in {{ status.qaOptIn ? "set" : "missing" }}</span>
      </p>
      <p v-if="!status.qaOptIn" class="warning">
        Live input is locked. Start the QA build with <code>POE2_QA_OPT_IN=1</code>. Dry-run still emits no OS input.
      </p>
      <p v-if="(!dryRun || wantedClasses.length > 0) && !status.searchCalibrated" class="warning">
        Live transfers and filtered previews require stash-search calibration. Live runs park the cursor there before every capture.
      </p>
      <p v-if="error" class="warning">{{ error }}</p>

      <div class="transfer-controls">
        <label><input v-model="dryRun" type="checkbox" /> Dry-run / preview (zero input)</label>
        <label><input v-model="qaAcknowledged" type="checkbox" /> Authorized QA acknowledgement</label>
        <label><input v-model="uniqueAcrossCycles" type="checkbox" /> Unique anchors across cycles</label>
        <label>
          Item classes (optional, comma-separated)
          <input v-model="classQuery" placeholder="Belts, Body Armours" />
        </label>
        <p>Calibrated stash tab: <strong>{{ stashTab === "quad" ? "Quad 24×24" : "Normal 12×12" }}</strong></p>
        <label>
          Actions per minute
          <input v-model.number="actionsPerMinute" type="number" min="1" max="600" />
        </label>
        <label>
          Fill item limit (0 = unlimited)
          <input v-model.number="maxItems" type="number" min="0" max="60" />
        </label>
        <label>
          Process allowlist
          <input v-model="allowlist" />
        </label>
      </div>

      <div class="btn-row transfer-actions">
        <button type="button" class="primary" :disabled="!canStart" @click="start('fill')">Fill</button>
        <button type="button" class="primary" :disabled="!canStart" @click="start('empty')">Empty</button>
        <button type="button" class="primary" :disabled="!canStart" @click="start('two-cycle')">Two cycles</button>
        <button type="button" class="danger" :disabled="!status.running" @click="stop">Stop</button>
        <button v-if="status.killLatched" type="button" @click="rearm">Re-arm kill switch</button>
      </div>

      <p>
        Running: <strong>{{ status.running }}</strong> · Kill switch:
        <strong>{{ status.killLatched ? "latched" : "armed" }}</strong>
      </p>
      <p v-if="memory" class="memory-status">
        {{ memory.scenarioKey }} · remembered {{ memory.confirmed }} · blocked returns {{ memory.blockedReturns }}
        <button type="button" @click="resetMemory">Reset scope</button>
      </p>
    </div>

    <div class="card">
      <h2>Voice stash fill</h2>
      <p>
        One local Windows speech command applies an exact class regex, highlights matches, then runs the
        audited Fill transfer until the bag cannot fit more.
      </p>
      <p v-if="status.mode !== 'authorized-qa'" class="warning">
        Voice transfer is unavailable in public-companion mode because one command can emit multiple game actions.
      </p>
      <p v-if="voiceError || voiceState.hotkeyError" class="warning">
        {{ friendlyVoiceError(voiceError || voiceState.hotkeyError || "") }}
      </p>
      <p v-if="voiceSaved" class="ok">{{ voiceSaved }}</p>
      <div class="transfer-controls">
        <label><input v-model="voiceEnabled" type="checkbox" /> Enable authorized-QA voice hotkey</label>
        <label>
          Global voice hotkey
          <input v-model="voiceHotkey" placeholder="CommandOrControl+Alt+V" />
        </label>
        <label>
          Recognition timeout (milliseconds)
          <input v-model.number="voiceTimeoutMs" type="number" min="1500" max="15000" step="500" />
        </label>
        <label>
          Minimum recognition confidence
          <input v-model.number="voiceMinimumConfidence" type="number" min="0" max="1" step="0.05" />
        </label>
        <label>
          <input v-model="voiceLiteralFallback" type="checkbox" />
          Allow explicit exact literal commands such as “search for Exalted Orb”
        </label>
      </div>
      <p class="memory-status">
        Uses the dry-run, QA acknowledgement, allowlist, rate, and item-limit controls above. Literal fallback is
        off by default and escapes regex syntax.
      </p>
      <div class="btn-row transfer-actions">
        <button
          type="button"
          :disabled="status.mode !== 'authorized-qa'"
          @click="saveVoiceSettings"
        >
          Save voice settings
        </button>
        <button type="button" class="primary" :disabled="!canListen || voiceActive" @click="listenOnce">
          Listen once now
        </button>
        <button type="button" class="danger" :disabled="!voiceActive" @click="cancelVoice">
          Cancel
        </button>
      </div>
      <p>
        Voice state: <strong>{{ voiceState.phase }}</strong> · Hotkey:
        <strong>{{ voiceState.hotkeyRegistered ? "registered" : "not registered" }}</strong>
      </p>
      <p v-if="voiceState.transcript">Heard: <strong>{{ voiceState.transcript }}</strong></p>
      <p v-if="voiceState.searchQuery">
        Stash query: <code>{{ voiceState.searchQuery }}</code>
        <span v-if="voiceState.wantedClasses?.length"> · {{ voiceState.wantedClasses.join(", ") }}</span>
      </p>
      <p v-if="voiceState.transferReason">Result: <strong>{{ voiceState.transferReason }}</strong></p>
    </div>

    <div class="card">
      <h2>Progress and last result</h2>
      <pre v-if="lastResult">{{ JSON.stringify(lastResult, null, 2) }}</pre>
      <p v-else>No transfer has run in this app session.</p>
      <ol class="event-log">
        <li v-for="event in events" :key="`${event.at}-${event.phase}-${event.message}`">
          {{ event.phase }} — {{ event.message }}
          <span v-if="event.bagCells !== undefined"> · bag {{ event.bagCells }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>
