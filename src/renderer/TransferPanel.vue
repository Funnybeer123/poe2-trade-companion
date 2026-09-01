<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { overlaySelectionSummary } from "@core/dryRunOverlay";
import { searchScenarioQuery } from "@core/itemClassFilter";
import {
  DEFAULT_VOICE_TRANSFER_CONFIG,
  type VoiceTransferConfig,
  type VoiceTransferStatus,
} from "@core/voiceTransfer";
import { useGameActions } from "./composables/useGameActions";
import {
  allowlistEntries,
  useRendererPreferences,
} from "./composables/useRendererPreferences";
import { getAssistiveApi, type AssistiveRunKind } from "./services/rendererApi";

interface MemoryStatus {
  scenarioKey: string;
  confirmed: number;
  blockedReturns: number;
  lastWithdrawn: number;
  updatedAt: string;
}

const {
  dryRun,
  transferStatus: status,
  lastTransferResult: lastResult,
  transferEvents: events,
  actionError: error,
  canStop,
  canStartEmpty,
  canStartFillNow,
  transferBlockReason,
  initializeGameActions,
  refreshGameActions,
  startAssistive,
  stopGameActions,
  rearmKillSwitch,
  labelOverlayCell,
} = useGameActions();

const { processAllowlist, transferActionsPerMinute } = useRendererPreferences();

const uniqueAcrossCycles = ref(false);
const classQuery = ref("");
const maxItems = ref(0);
const memory = ref<MemoryStatus | null>(null);
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
const canStartFill = computed(() => canStartFillNow(wantedClasses.value));
const voiceActive = computed(() =>
  ["listening", "recognized", "transferring"].includes(voiceState.value.phase),
);
const canListen = computed(
  () =>
    voiceEnabled.value &&
    status.value.searchCalibrated &&
    !status.value.running &&
    !status.value.killLatched,
);
const startBlockReason = computed(() => transferBlockReason(wantedClasses.value));
const overlaySelectionText = computed(() => {
  const selected = status.value.overlaySelection ?? [];
  if (!selected.length) return "";
  return overlaySelectionSummary(selected);
});

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
  maxItems.value = config.maxItems ?? 0;
  voiceSettingsLoaded = true;
}

function voiceConfig(): VoiceTransferConfig {
  return {
    enabled: voiceEnabled.value,
    hotkey: voiceHotkey.value.trim(),
    dryRun: dryRun.value,
    qaAcknowledged: true,
    allowlist: allowlistEntries(processAllowlist.value),
    actionsPerMinute: Math.max(1, Math.floor(transferActionsPerMinute.value)),
    maxItems: maxItems.value > 0 ? Math.floor(maxItems.value) : 0,
    allowLiteralFallback: voiceLiteralFallback.value,
    recognitionTimeoutMs: Math.floor(voiceTimeoutMs.value),
    minimumConfidence: Number(voiceMinimumConfidence.value),
  };
}

async function refresh() {
  await refreshGameActions();
  const api = runtime();
  if (!api) {
    error.value = "Open Transfers in the Electron app.";
    return;
  }
  applyVoiceStatus(await api.voice.status(), true);
  await refreshMemory();
}

async function refreshMemory() {
  const api = runtime();
  if (!api) return;
  memory.value = await api.memoryStatus({ stashTab: stashTab.value, query: memoryQuery.value });
}

async function start(kind: AssistiveRunKind) {
  await startAssistive({
    kind,
    wantedClasses: wantedClasses.value,
    uniqueAcrossCycles: uniqueAcrossCycles.value,
    maxItems: maxItems.value > 0 ? Math.floor(maxItems.value) : undefined,
  });
  await refreshMemory();
}

async function stop() {
  await stopGameActions();
}

async function rearm() {
  await rearmKillSwitch();
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
  void initializeGameActions();
  const api = runtime();
  if (!api) {
    error.value = "Open Transfers in the Electron app.";
    return;
  }
  removeVoiceListener = api.voice.onState((state) => {
    applyVoiceStatus(state);
    if (state.error) voiceError.value = state.error;
    if (state.phase === "complete" || state.phase === "cancelled" || state.phase === "error") {
      void refresh();
    }
  });
  void refresh();
  refreshTimer = window.setInterval(() => {
    void refreshMemory().then(async () => {
      const voice = runtime();
      if (!voice) return;
      applyVoiceStatus(await voice.voice.status());
    });
  }, 1500);
});

let refreshTimer: number | undefined;
let removeVoiceListener: (() => void) | undefined;

onUnmounted(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  removeVoiceListener?.();
});
</script>

<template>
  <section class="transfer-layout">
    <div class="card">
      <h2>Reliable stash transfers</h2>
      <p class="muted">
        Calibrated stash tab: <strong>{{ stashTab === "quad" ? "Quad 24×24" : "Normal 12×12" }}</strong>
        · grids <strong>{{ status.gridsCalibrated ? "ready" : "missing" }}</strong>
        · {{ dryRun ? "Dry-run / preview (zero input)" : "live input" }}
      </p>
      <p v-if="startBlockReason" class="warning">{{ startBlockReason }}</p>
      <p v-if="error" class="warning">{{ error }}</p>

      <div class="transfer-controls">
        <label>
          Item classes (optional, comma-separated)
          <input v-model="classQuery" placeholder="Belts, Body Armours" />
        </label>
      </div>

      <div class="btn-row transfer-actions">
        <button type="button" class="primary" :disabled="!canStartFill" @click="start('fill')">Fill</button>
        <button type="button" class="primary" :disabled="!canStartEmpty" @click="start('empty')">Empty</button>
        <button type="button" class="primary" :disabled="!canStartFill" @click="start('two-cycle')">Two cycles</button>
        <button type="button" class="danger" :disabled="!canStop" @click="stop">Stop</button>
        <button v-if="status.killLatched" type="button" @click="rearm">Re-arm kill switch</button>
      </div>

      <details class="advanced-options">
        <summary>Advanced run options</summary>
        <div class="transfer-controls">
          <label><input v-model="uniqueAcrossCycles" type="checkbox" /> Unique anchors across cycles</label>
          <label>
            Fill item limit (0 = unlimited)
            <input v-model.number="maxItems" type="number" min="0" max="60" />
          </label>
          <p class="muted">
            Allowlist and rate come from
            <RouterLink to="/tools/settings">Tools → Settings</RouterLink>.
          </p>
        </div>
      </details>

      <p v-if="status.overlayVisible" class="memory-status">
        Each outline on the overlay is one complete item. Click to select it, Shift-click to add
        more, then label Right or Wrong below. Overlay clicks never send game input.
      </p>
      <p v-if="status.overlayVisible" class="memory-status">
        Selected:
        <strong>{{ overlaySelectionText || "click a stash or bag item on the overlay" }}</strong>
      </p>
      <div v-if="status.overlayVisible" class="btn-row transfer-actions">
        <button
          type="button"
          class="primary"
          :disabled="!status.overlaySelection?.length"
          @click="labelOverlayCell('right')"
        >
          Right — detection is correct
        </button>
        <button
          type="button"
          class="danger"
          :disabled="!status.overlaySelection?.length"
          @click="labelOverlayCell('wrong')"
        >
          Wrong — detection is incorrect
        </button>
      </div>
      <p v-if="status.overlayVisible && status.overlayLabelFile" class="memory-status">
        Labels are stored locally at <code>{{ status.overlayLabelFile }}</code>
      </p>
      <p>
        Running: <strong>{{ status.running }}</strong> · Kill switch:
        <strong>{{ status.killLatched ? "latched" : "armed" }}</strong>
        <span v-if="status.overlayVisible"> · Overlay: <strong>visible</strong></span>
      </p>
      <p v-if="memory" class="memory-status">
        {{ memory.scenarioKey }} · remembered {{ memory.confirmed }} · blocked returns {{ memory.blockedReturns }}
        <button type="button" @click="resetMemory">Reset scope</button>
      </p>

      <details class="advanced-options">
        <summary>Voice stash fill</summary>
        <p class="muted">
          One local Windows speech command applies an exact class regex, highlights matches,
          then runs the audited Fill transfer until the bag cannot fit more. Uses the shared
          dry-run switch and the saved allowlist and rate.
        </p>
        <p v-if="voiceError || voiceState.hotkeyError" class="warning">
          {{ friendlyVoiceError(voiceError || voiceState.hotkeyError || "") }}
        </p>
        <p v-if="voiceSaved" class="ok">{{ voiceSaved }}</p>
        <div class="transfer-controls">
          <label><input v-model="voiceEnabled" type="checkbox" /> Enable voice hotkey</label>
          <label>
            Global voice hotkey
            <input v-model="voiceHotkey" placeholder="CommandOrControl+Alt+V" />
          </label>
        </div>
        <details class="advanced-options nested">
          <summary>Recognition tuning</summary>
          <div class="transfer-controls">
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
        </details>
        <div class="btn-row transfer-actions">
          <button type="button" @click="saveVoiceSettings">Save voice settings</button>
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
      </details>
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
