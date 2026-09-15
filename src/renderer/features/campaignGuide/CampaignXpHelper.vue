<script setup lang="ts">
/**
 * The under/over-levelled helper. The area level is the instance's REAL
 * monster level from the "Generating level N area" line; the character level
 * comes from the last level-up line (or the user's override). The percentage
 * is an ESTIMATE from the community formula — never a guarantee.
 */
import { computed, ref, watch } from "vue";
import { experienceChipTone } from "@core/campaignGuide";
import { formatDate } from "../../utils/intelligence";
import type { CampaignStateView } from "../../../shared/campaignGuide.js";

const props = withDefaults(
  defineProps<{ state: CampaignStateView; busy?: boolean }>(),
  { busy: false },
);

const emit = defineEmits<{ "set-level": [level: number | null]; rescan: [] }>();

const draft = ref<string>("");

watch(
  () => props.state.character?.level,
  (level) => {
    if (props.state.character?.source === "override" && typeof level === "number") draft.value = String(level);
  },
  { immediate: true },
);

const estimate = computed(() => props.state.experience);
const tone = computed(() => (estimate.value ? experienceChipTone(estimate.value) : "neutral"));
const areaLevel = computed(() => props.state.current?.observedLevel);

function apply(): void {
  const raw = draft.value.trim();
  if (!raw) {
    emit("set-level", null);
    return;
  }
  const value = Math.min(100, Math.max(1, Math.round(Number(raw) || 0)));
  emit("set-level", value);
}
</script>

<template>
  <section class="xp-helper" aria-label="Experience helper">
    <div class="xp-line">
      <span class="status-chip" :class="tone">
        {{ estimate ? `~${estimate.percent} % XP` : "XP unknown" }}
      </span>
      <span v-if="estimate" class="muted">{{ estimate.message }}</span>
      <span v-else class="muted">
        Character level unknown — rescan the log or set it by hand to get an estimate.
      </span>
    </div>
    <p class="muted xp-facts">
      <template v-if="state.character">
        Character level {{ state.character.level }}
        ({{ state.character.source === "override" ? "set by you" : `from the log at ${formatDate(state.character.seenAt)}` }})
      </template>
      <template v-else>No level-up line seen yet.</template>
      <template v-if="areaLevel"> · area level {{ areaLevel }} (the instance's own level)</template>
    </p>
    <div class="button-row xp-actions">
      <label class="xp-override">
        <span>Character level override</span>
        <input
          v-model="draft"
          type="number"
          min="1"
          max="100"
          inputmode="numeric"
          placeholder="from log"
          :disabled="busy"
          @keydown.enter.prevent="apply"
        />
      </label>
      <button type="button" class="button compact secondary" :disabled="busy" @click="apply">
        {{ busy ? "Saving…" : "Use this level" }}
      </button>
      <button type="button" class="button compact ghost" :disabled="busy" @click="emit('rescan')">
        Rescan log (16 MB)
      </button>
    </div>
    <p class="disclaimer">
      XP percentages are estimates from the community formula, never a guarantee.
    </p>
  </section>
</template>

<style scoped>
.xp-helper {
  display: grid;
  gap: 0.35rem;
}
.xp-line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  align-items: center;
}
.xp-facts {
  margin: 0;
}
.xp-actions {
  align-items: end;
  gap: 0.5rem;
}
.xp-override {
  display: grid;
  gap: 0.3rem;
  max-width: 12rem;
}
</style>
