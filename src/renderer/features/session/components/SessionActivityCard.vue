<script setup lang="ts">
import { computed, ref } from "vue";
import type { HomeOverview } from "../../../../shared/session";
import { formatDuration, rate, when } from "../format";

const props = defineProps<{ home: HomeOverview; busy?: boolean }>();
const emit = defineEmits<{ "end-session": []; "show-recap": [] }>();

const pendingEnd = ref(false);
const metrics = computed(() => props.home.session.metrics);
const session = computed(() => props.home.session.session);

function endSession(): void {
  if (!pendingEnd.value) {
    pendingEnd.value = true;
    return;
  }
  pendingEnd.value = false;
  emit("end-session");
}
</script>

<template>
  <section class="card session-activity" aria-labelledby="home-session-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Session</span>
        <h2 id="home-session-title">This session</h2>
      </div>
      <span v-if="home.session.active" class="status-chip safe">Running</span>
      <span v-else class="status-chip neutral">Waiting for the game</span>
    </div>

    <p v-if="!session" class="empty-copy">
      Waiting for the game — the session starts with the first Client.txt line or the moment Path of
      Exile is detected.
    </p>
    <template v-else>
      <dl class="metric-grid">
        <div>
          <dt>Started</dt>
          <dd>{{ when(session.startedAt) }}</dd>
        </div>
        <div>
          <dt>Active</dt>
          <dd>{{ formatDuration(metrics?.activeMs) }}</dd>
        </div>
        <div>
          <dt>AFK</dt>
          <dd>{{ formatDuration(metrics?.afkMs) }}</dd>
        </div>
        <div>
          <dt>Maps completed</dt>
          <dd>{{ metrics?.mapsCompleted ?? 0 }}</dd>
        </div>
        <div>
          <dt>Maps per hour</dt>
          <dd>{{ rate(metrics?.mapsPerHour) }}</dd>
        </div>
        <div>
          <dt>Average map</dt>
          <dd>{{ formatDuration(metrics?.avgMapMs) }}</dd>
        </div>
        <div>
          <dt>Deaths</dt>
          <dd>{{ metrics?.deaths ?? 0 }}</dd>
        </div>
        <div>
          <dt>Level-ups</dt>
          <dd>{{ metrics?.levelUps ?? 0 }}</dd>
        </div>
      </dl>
      <p class="muted">
        Completion is counted by hideout return: a map you left through town counts, one the session
        ended inside does not. Maps per hour excludes AFK time and needs ten active minutes first.
      </p>
    </template>

    <div class="button-row">
      <button
        type="button"
        class="button secondary compact"
        :disabled="busy || !session"
        :title="session ? '' : 'No session to end yet.'"
        @click="endSession"
      >
        {{ pendingEnd ? "Confirm: end session" : "End session & start fresh" }}
      </button>
      <button
        type="button"
        class="button ghost compact"
        :disabled="busy || !home.session.overlayAvailable"
        :title="home.session.overlayAvailable ? '' : 'The overlay window is not available in this build.'"
        @click="emit('show-recap')"
      >
        Show recap in overlay
      </button>
      <button v-if="pendingEnd" type="button" class="button ghost compact" @click="pendingEnd = false">
        Cancel
      </button>
    </div>
  </section>
</template>

<style scoped>
.session-activity { display: flex; flex-direction: column; gap: 0.7rem; }
.metric-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: 0.6rem; }
.metric-grid dt { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.metric-grid dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
