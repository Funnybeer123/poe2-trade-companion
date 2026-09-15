<script setup lang="ts">
/**
 * The first-run checklist. Main derives every step (one source of truth —
 * Home renders the same channel), so this card only renders states and maps
 * the per-step `action` string onto the button that fixes it.
 *
 * It polls the checklist while mounted, which costs nothing: the handler
 * reads cached foundation state and never launches a process. In particular
 * it does NOT probe the administrator rights — that opens a handle on the live
 * game client, so it happens only when the user presses the button for it in
 * Settings → Game client. Until then the admin step reads "unknown", which is
 * optional and blocks nothing.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  SetupChecklist,
  SetupStep,
  SetupStepAction,
} from "../../../shared/appSettings.js";
import type { ClientLogContract, ClientLogEvents } from "../../../shared/clientLog.js";
import type { HotkeysContract, HotkeysEvents } from "../../../shared/hotkeys.js";
import { createFeatureApi } from "../../services/featureApi";
import { getPriceFeedApi } from "../../services/rendererApi";
import { getAppSettingsApi } from "./appSettingsApi";

const props = defineProps<{ compact?: boolean; alwaysShow?: boolean }>();
const emit = defineEmits<{ (event: "navigate", path: string): void }>();

const POLL_MS = 15_000;

const api = getAppSettingsApi();
const clientLogApi = createFeatureApi<ClientLogContract, ClientLogEvents>();
const hotkeysApi = createFeatureApi<HotkeysContract, HotkeysEvents>();

const checklist = ref<SetupChecklist | null>(null);
const loading = ref(true);
const error = ref("");
const busyStep = ref("");
const stepNote = ref("");
const showAgain = ref(false);

const stops: Array<() => void> = [];
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

const dismissed = computed(() => Boolean(checklist.value?.dismissedAt));
const visible = computed(() => props.alwaysShow === true || !dismissed.value || showAgain.value);
const complete = computed(() => checklist.value?.complete === true);

const ACTION_LABELS: Record<SetupStepAction, string> = {
  "browse-log": "Browse…",
  "check-leagues": "Check leagues",
  "refresh-feed": "Refresh prices",
  "open-hotkeys": "Open hotkeys",
  "test-overlay": "Test overlay",
  "open-settings": "Open settings",
  "open-calibration": "Open calibration",
  "open-market-data": "Open market data",
};

const ROUTES: Partial<Record<SetupStepAction, string>> = {
  "open-hotkeys": "/tools/hotkeys",
  "open-calibration": "/tools/calibration",
  "open-settings": "/tools/settings",
  "open-market-data": "/tools/settings#market-data",
};

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("app:setup-checklist");
    if (disposed) return;
    checklist.value = next;
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The setup checklist could not be read.");
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function runAction(step: SetupStep): Promise<void> {
  const action = step.action;
  if (!action) return;
  const route = ROUTES[action];
  if (route) {
    emit("navigate", route);
    return;
  }
  busyStep.value = step.id;
  stepNote.value = "";
  try {
    if (action === "browse-log") await clientLogApi?.invoke("client-log:browse-file");
    else if (action === "test-overlay") await api?.invoke("app:test-overlay");
    else if (action === "check-leagues") {
      const feed = getPriceFeedApi();
      if (feed) {
        const leagues = await feed.leagues();
        await feed.status();
        stepNote.value = `${leagues.length} current league${leagues.length === 1 ? "" : "s"} listed.`;
      }
    } else if (action === "refresh-feed") {
      const feed = getPriceFeedApi();
      if (feed) await feed.refresh();
    }
    await load();
  } catch (reason) {
    error.value = describe(reason, "That step could not be run.");
  } finally {
    busyStep.value = "";
  }
}

async function setDismissed(value: boolean): Promise<void> {
  if (!api) return;
  try {
    checklist.value = await api.invoke("app:dismiss-checklist", value);
    showAgain.value = !value;
  } catch (reason) {
    error.value = describe(reason, "The checklist could not be updated.");
  }
}

onMounted(() => {
  void load();
  if (api) stops.push(api.on("app:checklist-changed", (next) => (checklist.value = next)));
  // The admin verdict arrives only if the user runs the check themselves.
  if (api) stops.push(api.on("app:elevation-changed", () => void load()));
  if (hotkeysApi) stops.push(hotkeysApi.on("hotkeys:changed", () => void load()));
  if (clientLogApi) stops.push(clientLogApi.on("client-log:status", () => void load()));
  timer = setInterval(() => void load(), POLL_MS);
});

onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearInterval(timer);
  for (const stop of stops.splice(0)) stop();
});
</script>

<template>
  <section v-if="api" class="card setup-checklist" aria-labelledby="setup-checklist-title">
    <header class="section-heading">
      <div>
        <span class="eyebrow">First run</span>
        <h3 id="setup-checklist-title">Setup checklist</h3>
      </div>
      <span v-if="checklist" class="count-badge">{{ checklist.done }}/{{ checklist.required }}</span>
    </header>

    <p v-if="loading" class="muted"><span class="spinner" aria-hidden="true"></span> Loading setup state…</p>
    <p v-else-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <template v-else-if="checklist">
      <p v-if="!visible" class="muted">
        <template v-if="complete">Setup complete</template>
        <template v-else>Checklist hidden</template>
        ·
        <button type="button" class="button ghost compact" @click="showAgain = true">Show checklist</button>
      </p>

      <template v-else>
        <ol class="checklist" aria-label="Setup checklist">
          <li v-for="step in checklist.steps" :key="step.id" :data-step="step.id">
            <span class="step-dot" :class="step.state" aria-hidden="true"></span>
            <div class="step-body">
              <strong>{{ step.label }}</strong>
              <span class="sr-only">{{ step.state }}</span>
              <small v-if="!props.compact" class="muted">{{ step.detail }}</small>
            </div>
            <button
              v-if="step.action && step.state !== 'ok'"
              type="button"
              class="button ghost compact"
              :disabled="busyStep === step.id"
              @click="runAction(step)"
            >
              {{ busyStep === step.id ? "Working…" : ACTION_LABELS[step.action] }}
            </button>
          </li>
        </ol>
        <p v-if="stepNote" class="muted" role="status">{{ stepNote }}</p>
        <p v-if="!props.compact" class="muted">Optional steps only matter for the flows that need them.</p>
        <div class="button-row">
          <button type="button" class="button ghost compact" @click="setDismissed(true)">Dismiss</button>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.setup-checklist {
  margin-bottom: 0.85rem;
}
.checklist {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}
.checklist li {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.3rem 0;
}
.step-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}
.step-body small {
  font-size: 0.74rem;
}
.step-dot {
  width: 8px;
  height: 8px;
  margin-top: 0.4rem;
  border-radius: 50%;
  background: var(--text-muted);
  flex: 0 0 auto;
}
.step-dot.ok {
  background: var(--green, #6fa86b);
}
.step-dot.warn {
  background: var(--amber, #c49246);
}
.step-dot.todo {
  background: var(--text-muted);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.step-dot.optional,
.step-dot.unknown {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
</style>
