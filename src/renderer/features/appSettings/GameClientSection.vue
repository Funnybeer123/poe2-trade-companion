<script setup lang="ts">
/**
 * What the app knows about the game client: which Client.txt it tails, and
 * what `poe2_production_Config.ini` says about language, resolution and the
 * chat key. These are read-outs, not settings — the only thing the user can
 * change here is the log-file override.
 *
 * The language is shown because it decides which whisper templates the log
 * parser assumes; the app itself is not translated.
 *
 * The administrator-rights check is NOT run on mount. It enumerates
 * `PathOfExile*` processes and attempts one handle open on the live game
 * client — a thing to do when the user asks for it, not a side effect of
 * opening a settings page — so it sits behind a button and is hidden (and
 * refused by main) in the public build.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ClientLogContract, ClientLogEvents, ClientLogStatus } from "../../../shared/clientLog.js";
import type { ElevationReport } from "../../../shared/appSettings.js";
import { createFeatureApi } from "../../services/featureApi";
import { getAppSettingsApi } from "./appSettingsApi";
import AdminRightsHint from "./AdminRightsHint.vue";

const props = defineProps<{ buildMode: string }>();

const api = getAppSettingsApi();
const clientLogApi = createFeatureApi<ClientLogContract, ClientLogEvents>();

const status = ref<ClientLogStatus | null>(null);
const elevation = ref<ElevationReport | null>(null);
const filePath = ref("");
const busy = ref(false);
const error = ref("");
const checkingAdmin = ref(false);
const adminError = ref("");
let stopStatus: (() => void) | undefined;
let stopElevation: (() => void) | undefined;

/** Hidden where main refuses the probe anyway. */
const canCheckAdmin = computed(() => Boolean(api) && props.buildMode !== "public-companion");
const checkedAt = computed(() => {
  const stamp = elevation.value?.checkedAt;
  if (!stamp) return "";
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString();
});

const VK_NAMES: Record<number, string> = { 13: "Enter", 9: "Tab", 191: "/", 220: "\\", 192: "`" };

const gameSettings = computed(() => status.value?.gameSettings);
const language = computed(() => gameSettings.value?.language ?? "en (default)");
const resolution = computed(() => {
  const settings = gameSettings.value;
  if (!settings?.resolution) return "not read yet";
  const mode = settings.borderlessWindowed
    ? "borderless windowed"
    : settings.fullscreen
      ? "fullscreen"
      : "windowed";
  return `${settings.resolution.width}×${settings.resolution.height} · ${mode}`;
});
const chatKey = computed(() => keyName(gameSettings.value?.chatKey));
const searchKey = computed(() => keyName(gameSettings.value?.searchKey));

function keyName(code: number | undefined): string {
  if (code === undefined) return "default";
  return VK_NAMES[code] ?? `VK ${code}`;
}

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function apply(next: ClientLogStatus): void {
  status.value = next;
  filePath.value = next.file ?? "";
}

async function run(task: () => Promise<ClientLogStatus | undefined>): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const next = await task();
    if (next) apply(next);
  } catch (reason) {
    error.value = describe(reason, "The client log could not be reached.");
  } finally {
    busy.value = false;
  }
}

const browse = (): Promise<void> => run(async () => clientLogApi?.invoke("client-log:browse-file"));
const useThisFile = (): Promise<void> =>
  run(async () => clientLogApi?.invoke("client-log:set-file", filePath.value.trim() || null));
const autoDetect = (): Promise<void> => run(async () => clientLogApi?.invoke("client-log:set-file", null));
const reloadConfig = (): Promise<void> => run(async () => clientLogApi?.invoke("client-log:reload-settings"));

/**
 * The only caller of the probe. `force` skips the 30 s memo so a second press
 * after the user restarted the game really re-checks.
 */
async function checkAdminRights(): Promise<void> {
  if (!api || !canCheckAdmin.value) return;
  checkingAdmin.value = true;
  adminError.value = "";
  try {
    elevation.value = await api.invoke("app:elevation", true);
  } catch (reason) {
    elevation.value = null;
    adminError.value = describe(reason, "The administrator-rights check could not be run.");
  } finally {
    checkingAdmin.value = false;
  }
}

onMounted(async () => {
  await run(async () => clientLogApi?.invoke("client-log:status"));
  stopStatus = clientLogApi?.on("client-log:status", (next) => apply(next));
  // No probe here on purpose — see the file comment.
  if (api) {
    stopElevation = api.on("app:elevation-changed", (next) => (elevation.value = next));
  }
});
onBeforeUnmount(() => {
  stopStatus?.();
  stopElevation?.();
});
</script>

<template>
  <details class="advanced-options">
    <summary>Game client</summary>

    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <dl class="property-list">
      <div>
        <dt>Client.txt</dt>
        <dd>{{ status?.file ?? "not found" }}</dd>
      </div>
      <div>
        <dt>Detected as</dt>
        <dd>
          <span class="status-chip neutral">{{ status?.source ?? "none" }}</span>
          {{ status?.watching ? "watching" : "not watching" }}
          <template v-if="status?.sizeBytes"> · {{ Math.round(status.sizeBytes / 1024) }} KB</template>
        </dd>
      </div>
      <div>
        <dt>Last line</dt>
        <dd>{{ status?.lastLineAt ?? "none yet" }}</dd>
      </div>
    </dl>
    <p v-if="status?.error" class="inline-notice danger" role="alert">{{ status.error }}</p>

    <label class="search-field">
      <span class="sr-only">Client.txt path</span>
      <input v-model="filePath" type="text" placeholder="…\logs\Client.txt" :disabled="busy" />
    </label>
    <div class="button-row">
      <button type="button" class="button secondary compact" :disabled="busy" @click="useThisFile">
        Use this file
      </button>
      <button type="button" class="button ghost compact" :disabled="busy" @click="browse">Browse…</button>
      <button type="button" class="button ghost compact" :disabled="busy" @click="autoDetect">
        Auto-detect
      </button>
    </div>
    <p class="muted">Detection order: Steam → standalone → Epic → your override.</p>

    <dl class="property-list">
      <div>
        <dt>Client language</dt>
        <dd>{{ language }}</dd>
      </div>
      <div>
        <dt>Resolution &amp; mode</dt>
        <dd>{{ resolution }}</dd>
      </div>
      <div>
        <dt>Chat key</dt>
        <dd>{{ chatKey }}</dd>
      </div>
      <div>
        <dt>Stash-search key</dt>
        <dd>{{ searchKey }}</dd>
      </div>
    </dl>
    <p v-if="!gameSettings" class="muted">
      Config file not found — English/Enter defaults assumed.
    </p>
    <div class="button-row">
      <button type="button" class="button ghost compact" :disabled="busy" @click="reloadConfig">
        Re-read game config
      </button>
    </div>

    <div v-if="canCheckAdmin" class="admin-check">
      <p class="muted">
        Administrator rights:
        <template v-if="elevation">checked{{ checkedAt ? ` at ${checkedAt}` : "" }}</template>
        <template v-else>not checked yet</template>
        — the check lists the game's processes and tries to open one handle. It reads nothing else and
        never blocks anything.
      </p>
      <div class="button-row">
        <button
          type="button"
          class="button ghost compact"
          :disabled="checkingAdmin"
          @click="checkAdminRights"
        >
          {{ checkingAdmin ? "Checking…" : "Check administrator rights" }}
        </button>
      </div>
      <p v-if="adminError" class="inline-notice danger" role="alert">{{ adminError }}</p>
    </div>

    <AdminRightsHint :report="elevation" :build-mode="props.buildMode" />
  </details>
</template>

<style scoped>
.property-list {
  margin-top: 0.5rem;
}
.search-field {
  margin-top: 0.5rem;
}
.admin-check {
  margin-top: 0.75rem;
}
</style>
