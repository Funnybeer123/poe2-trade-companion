<script setup lang="ts">
/**
 * The administrator-rights hint: one sentence explaining why input silently
 * fails when the game runs elevated and the companion does not, plus the
 * relaunch escape hatch.
 *
 * The relaunch sits behind a disclosure AND a confirm click because it quits
 * the app and raises a UAC prompt; it is hidden entirely in the public build,
 * which has no game-driving path for UIPI to block.
 */
import { computed, ref } from "vue";
import type { ElevationReport } from "../../../shared/appSettings.js";
import { getAppSettingsApi } from "./appSettingsApi";

const props = defineProps<{
  report: ElevationReport | null;
  compact?: boolean;
  buildMode: string;
}>();

const api = getAppSettingsApi();

/**
 * An ALLOW-list, not `!== "public-companion"`: an unknown or not-yet-loaded
 * build mode must hide the relaunch, never offer it.
 */
const RELAUNCHABLE = new Set(["authorized-qa", "assistive-access"]);
const canRelaunch = computed(
  () =>
    RELAUNCHABLE.has(props.buildMode) &&
    props.compact !== true &&
    props.report?.appElevated !== true,
);
const busy = ref(false);
const pending = ref(false);
const error = ref("");
const note = ref("");

async function relaunch(): Promise<void> {
  if (!api) return;
  if (!pending.value) {
    pending.value = true;
    return;
  }
  pending.value = false;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    const result = await api.invoke("app:relaunch-elevated");
    if (result.ok) note.value = "Approve the Windows prompt — the companion closes and reopens elevated.";
    else error.value = describeRefusal(result.error ?? "");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The relaunch could not be started.";
  } finally {
    busy.value = false;
  }
}

function describeRefusal(code: string): string {
  if (code === "already-elevated") return "The companion already runs as administrator.";
  if (code === "public-companion") return "Not available in this build.";
  return code || "The relaunch could not be started.";
}
</script>

<template>
  <div v-if="props.report" class="admin-hint">
    <p v-if="props.report.hint" class="inline-notice warning" role="alert">{{ props.report.hint }}</p>
    <p v-else-if="props.report.appElevated === true" class="muted">
      The companion runs as administrator — it can drive an elevated game.
    </p>
    <p v-else-if="props.report.poeElevated === 'unknown'" class="muted">
      Could not tell whether the game runs elevated. The check is a heuristic (protected processes deny
      handles too) and never blocks anything.
    </p>
    <p v-else class="muted">Game and companion run at the same privilege.</p>

    <p v-if="props.report.error" class="muted">Last check failed: {{ props.report.error }}</p>

    <details v-if="canRelaunch" class="advanced-options nested">
      <summary>Relaunch as administrator</summary>
      <p class="muted">
        Windows shows its own prompt; the companion closes and reopens with the same build mode and
        data folder. It never elevates itself silently.
      </p>
      <div class="button-row">
        <button type="button" class="button danger compact" :disabled="busy || !api" @click="relaunch">
          {{ busy ? "Starting…" : pending ? "Click again to confirm" : "Relaunch as administrator" }}
        </button>
        <button v-if="pending" type="button" class="button ghost compact" @click="pending = false">
          Cancel
        </button>
      </div>
      <p v-if="note" class="muted" role="status">{{ note }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
    </details>
  </div>
</template>

<style scoped>
.admin-hint {
  margin-top: 0.5rem;
}
.admin-hint .advanced-options {
  margin-top: 0.5rem;
}
</style>
