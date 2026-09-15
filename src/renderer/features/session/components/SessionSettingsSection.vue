<script setup lang="ts">
/**
 * "Session & recap" for Tools → Settings. Everyday switches stay visible;
 * the idle timeout, the character override and the whole-screen capture
 * fallback sit behind the expert disclosure (minimal-config rule 3).
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  DEFAULT_SESSION_SETTINGS,
  MAX_DEATH_SCREENSHOTS,
  MAX_IDLE_END_MINUTES,
  MIN_DEATH_SCREENSHOTS,
  MIN_IDLE_END_MINUTES,
  normalizeSessionSettings,
  sessionSettingsIssues,
  type SessionSettings,
} from "../../../../shared/session";
import { getAppFeatureApi } from "../../../services/featureApi";
import { describeError } from "../format";

const api = getAppFeatureApi();
const saved = ref<SessionSettings>({ ...DEFAULT_SESSION_SETTINGS });
const draft = ref<SessionSettings>({ ...DEFAULT_SESSION_SETTINGS });
const overrideName = ref("");
const overrideClass = ref("");
const overrideLevel = ref("");
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
let disposed = false;

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value));
const issues = computed(() => sessionSettingsIssues(withOverride()));

function withOverride(): SessionSettings {
  const name = overrideName.value.trim();
  const level = Number(overrideLevel.value);
  return {
    ...draft.value,
    ...(name
      ? {
          characterOverride: {
            name,
            ...(overrideClass.value.trim() ? { className: overrideClass.value.trim() } : {}),
            ...(Number.isFinite(level) && level > 0 ? { level } : {}),
          },
        }
      : { characterOverride: undefined }),
  };
}

function adopt(value: SessionSettings): void {
  saved.value = { ...value };
  draft.value = { ...value };
  overrideName.value = value.characterOverride?.name ?? "";
  overrideClass.value = value.characterOverride?.className ?? "";
  overrideLevel.value = value.characterOverride?.level ? String(value.characterOverride.level) : "";
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const snapshot = await api.invoke("settings:get");
    if (disposed) return;
    adopt(normalizeSessionSettings(snapshot?.session));
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "Session settings could not be read.");
  }
}

async function save(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const next = await api.invoke("settings:set", "session", withOverride());
    if (disposed) return;
    adopt(normalizeSessionSettings(next));
    notice.value = "Saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "Session settings could not be saved.");
  } finally {
    busy.value = false;
  }
}

function revert(): void {
  adopt(saved.value);
  notice.value = "";
}

onMounted(async () => {
  await load();
  if (!disposed) loading.value = false;
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section class="card tool-panel session-settings" aria-labelledby="session-settings-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Home</span>
        <h2 id="session-settings-title">Session &amp; recap</h2>
      </div>
      <span class="status-chip neutral">No game input, no network</span>
    </div>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Session settings need the desktop app</strong>
      <p>This preview has no bridge.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading session settings…</p>
    </div>
    <template v-else>
      <div class="field-stack">
        <label class="toggle-field">
          <input v-model="draft.afkRecap" type="checkbox" />
          <span>Show a recap in the overlay when I go AFK</span>
        </label>
        <label class="toggle-field">
          <input v-model="draft.afkRecapAutoClose" type="checkbox" :disabled="!draft.afkRecap" />
          <span>Close it again when AFK ends</span>
        </label>
        <label class="toggle-field">
          <input v-model="draft.postGameRecap" type="checkbox" />
          <span>Keep a post-game recap card on Home</span>
        </label>
        <label class="toggle-field">
          <input v-model="draft.postGameNotification" type="checkbox" :disabled="!draft.postGameRecap" />
          <span>Also send a Windows notification when the game closes</span>
        </label>
        <label class="toggle-field">
          <input v-model="draft.deathScreenshots" type="checkbox" />
          <span>Save a screenshot after each death (stays on this PC, can show chat and player names)</span>
        </label>
        <label>
          Keep at most this many screenshots
          <input
            v-model.number="draft.maxDeathScreenshots"
            type="number"
            :min="MIN_DEATH_SCREENSHOTS"
            :max="MAX_DEATH_SCREENSHOTS"
          />
        </label>
      </div>

      <details class="advanced-options">
        <summary>Expert options</summary>
        <div class="form-grid">
          <label>
            End the session after this many quiet minutes
            <input
              v-model.number="draft.idleEndMinutes"
              type="number"
              :min="MIN_IDLE_END_MINUTES"
              :max="MAX_IDLE_END_MINUTES"
            />
          </label>
          <label class="toggle-field">
            <input v-model="draft.allowScreenFallback" type="checkbox" />
            <span>
              Capture the whole screen when no game window is offered — a screen grab can include
              Discord, a browser and other people's chat.
            </span>
          </label>
          <label>
            Character name override
            <input v-model="overrideName" type="text" maxlength="40" placeholder="Only while the log has no level-up" />
          </label>
          <label>
            Class
            <input v-model="overrideClass" type="text" maxlength="40" />
          </label>
          <label>
            Level
            <input v-model="overrideLevel" type="number" min="1" max="100" />
          </label>
        </div>
        <p class="muted">
          The override is only used while no level-up line sits in the log window; a real level-up
          always wins.
        </p>
      </details>

      <ul v-if="issues.length" class="notice-list">
        <li v-for="issue in issues" :key="issue">{{ issue }}</li>
      </ul>
      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

      <div class="button-row">
        <button type="button" class="button primary compact" :disabled="!dirty || busy" @click="save">
          {{ busy ? "Saving…" : "Save" }}
        </button>
        <button type="button" class="button ghost compact" :disabled="!dirty || busy" @click="revert">
          Revert
        </button>
      </div>
    </template>

    <p class="disclaimer">
      Screenshots and session history never leave this PC; the notification carries counts only.
    </p>
  </section>
</template>

<style scoped>
.session-settings { display: flex; flex-direction: column; gap: 0.7rem; }
.field-stack { display: flex; flex-direction: column; gap: 0.5rem; }
.toggle-field { display: flex; gap: 0.5rem; align-items: flex-start; }
.toggle-field input { width: auto; flex: none; margin-top: 0.15rem; }
</style>
