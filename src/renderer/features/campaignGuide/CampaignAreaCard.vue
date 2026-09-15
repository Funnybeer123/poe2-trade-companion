<script setup lang="ts">
/**
 * One area: its name, act, level, tags, notes and objectives. Used for the
 * "you are here" strip, for every row of the route accordion and beside the
 * map. Emits patches; it never talks to main.
 */
import { computed } from "vue";
import {
  actLabel,
  experienceChipTone,
  visibleObjectives,
  type CampaignCustomisePatch,
  type CampaignGuideSettings,
  type ExperienceEstimate,
  type MergedArea,
  type MergedObjective,
} from "@core/campaignGuide";
import { formatDate } from "../../utils/intelligence";
import CampaignObjectiveList from "./CampaignObjectiveList.vue";

const props = withDefaults(
  defineProps<{
    area: MergedArea;
    settings: CampaignGuideSettings;
    current?: boolean;
    experience?: ExperienceEstimate;
    compact?: boolean;
    editable?: boolean;
    selected?: boolean;
    busy?: boolean;
  }>(),
  { current: false, compact: false, editable: false, selected: false, busy: false },
);

const emit = defineEmits<{
  select: [id: string];
  customise: [patch: CampaignCustomisePatch];
  "open-wiki": [id: string];
  "edit-area": [area: MergedArea];
  "add-objective": [area: MergedArea];
  edit: [objective: MergedObjective];
}>();

const objectives = computed(() => visibleObjectives(props.area, props.settings));
const label = computed(() => `${actLabel(props.area.part, props.area.act)} · L${props.area.level}`);
const xpTone = computed(() => (props.experience ? experienceChipTone(props.experience) : "neutral"));
</script>

<template>
  <article
    class="campaign-area"
    :class="{ current, selected, hidden: area.hidden }"
    tabindex="0"
    :data-area-id="area.id"
    @click="emit('select', area.id)"
    @keydown.enter.prevent="emit('select', area.id)"
  >
    <header class="area-head">
      <div class="area-copy">
        <strong class="area-name">{{ area.name }}</strong>
        <span class="pill">{{ label }}</span>
        <span v-if="area.town" class="tag neutral">town</span>
        <span v-if="area.waypoint" class="tag neutral">waypoint</span>
        <span v-if="area.branch" class="tag neutral">side area</span>
        <span v-if="area.custom" class="tag neutral">yours</span>
        <span v-else-if="area.edited" class="tag neutral">edited</span>
      </div>
      <div class="area-chips">
        <span v-if="current && experience" class="status-chip" :class="xpTone">
          ~{{ experience.percent }} % XP
        </span>
        <span v-if="area.visitedAt" class="status-chip safe" :title="formatDate(area.visitedAt)">visited</span>
      </div>
    </header>

    <p v-if="area.notes" class="muted area-note">{{ area.notes }}</p>
    <p v-if="area.userNote" class="inline-notice campaign-user-note" role="note">{{ area.userNote }}</p>

    <template v-if="!compact">
      <CampaignObjectiveList
        :area="area"
        :objectives="objectives"
        :editable="editable"
        :busy="busy"
        @customise="emit('customise', $event)"
        @edit="emit('edit', $event)"
      />
      <div v-if="editable" class="button-row area-actions">
        <button type="button" class="button compact ghost" :disabled="busy" @click.stop="emit('add-objective', area)">
          Add objective
        </button>
        <button type="button" class="button compact ghost" :disabled="busy" @click.stop="emit('edit-area', area)">
          Edit area
        </button>
        <button
          type="button"
          class="button compact ghost"
          :disabled="busy"
          @click.stop="emit('customise', { op: area.hidden ? 'restore-area' : 'hide-area', id: area.id })"
        >
          {{ area.hidden ? "Restore area" : "Hide area" }}
        </button>
        <button type="button" class="button compact ghost" :disabled="busy" @click.stop="emit('open-wiki', area.id)">
          Wiki
        </button>
      </div>
    </template>
  </article>
</template>

<style scoped>
.campaign-area {
  display: grid;
  gap: 0.4rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line, #2b3038);
  border-radius: 9px;
  background: var(--panel-soft, #121519);
}
.campaign-area.current {
  border-color: var(--gold, #c8a66a);
}
.campaign-area.selected {
  box-shadow: inset 0 0 0 1px var(--gold-bright, #e4c587);
}
.campaign-area.hidden {
  opacity: 0.55;
}
.area-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  justify-content: space-between;
}
.area-copy,
.area-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.area-name {
  font-size: 0.95rem;
}
.area-note {
  margin: 0;
}
.campaign-user-note {
  margin: 0;
}
.area-actions {
  margin-top: 0.2rem;
}
</style>
