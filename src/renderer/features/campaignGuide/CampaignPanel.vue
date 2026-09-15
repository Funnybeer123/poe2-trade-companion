<script setup lang="ts">
/**
 * The in-game overlay panel. Main shows it (pinned, non-focus) when the
 * player enters a campaign area and hides it again when they leave.
 *
 * It is display-only: no search field, no keyboard capture, no game input.
 * The × tells main the player dismissed it for this area; Escape and
 * "hide all" leave a pinned panel alone.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  actLabel,
  experienceChipTone,
  visibleObjectives,
  type CampaignCustomisePatch,
  type MergedArea,
} from "@core/campaignGuide";
import type { CampaignPanelPayload } from "../../../shared/campaignGuide.js";
import CampaignObjectiveList from "./CampaignObjectiveList.vue";
import { disposeCampaignGuide, useCampaignGuide } from "./useCampaignGuide";

const props = defineProps<{ panelId: string; payload: unknown; visible: boolean }>();

defineEmits<{ close: [] }>();

const store = useCampaignGuide();
const browsedId = ref("");
let stopSubscription: (() => void) | undefined;
let disposed = false;

/** Anything can arrive in `payload`; fall back instead of throwing. */
const payload = computed<CampaignPanelPayload>(() => {
  const source = (typeof props.payload === "object" && props.payload !== null ? props.payload : {}) as Partial<CampaignPanelPayload>;
  return {
    ...(typeof source.areaId === "string" && source.areaId ? { areaId: source.areaId } : {}),
    compact: source.compact === true,
    reason: source.reason === "hotkey" || source.reason === "desktop" ? source.reason : "auto",
  };
});

const current = computed(() => store.state.value?.current);
const routeAreas = computed(() => {
  const acts = store.route.value?.merged.acts ?? [];
  return acts.flatMap((act) => act.areas).filter((area) => !area.hidden);
});
const shownArea = computed<MergedArea | undefined>(() => {
  const index = store.route.value?.merged.areaIndex;
  if (!index) return undefined;
  if (browsedId.value) return index[browsedId.value];
  const id = payload.value.areaId ?? current.value?.normalizedId;
  return id ? index[id] : undefined;
});
const isCurrent = computed(() => shownArea.value?.id === current.value?.normalizedId);
const objectives = computed(() => {
  const area = shownArea.value;
  const settings = store.route.value?.settings;
  if (!area || !settings) return [];
  return visibleObjectives(area, settings);
});
const estimate = computed(() => (isCurrent.value ? store.state.value?.experience : undefined));
const tone = computed(() => (estimate.value ? experienceChipTone(estimate.value) : "neutral"));
/** The number is never a guarantee, and this panel is where it is read most. */
const estimateTitle = computed(() =>
  estimate.value ? `${estimate.value.message} (estimate, community formula)` : "",
);

const nextText = computed(() => {
  if (!isCurrent.value) return "";
  const next = store.state.value?.next;
  if (!next) return "";
  switch (next.kind) {
    case "objective":
      return `Next (suggested): ${next.objective.title}`;
    case "exit":
      return `Next (suggested): ${next.area.name}${next.area.waypoint ? " (waypoint)" : ""}`;
    case "act-complete":
      return next.town ? `Act complete — head to ${next.town.name}` : "Act complete";
    default:
      return "";
  }
});

function browse(delta: number): void {
  const areas = routeAreas.value;
  if (!areas.length) return;
  const id = shownArea.value?.id;
  const index = areas.findIndex((area) => area.id === id);
  const target = Math.min(areas.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
  browsedId.value = areas[target].id;
}

function backToCurrent(): void {
  browsedId.value = "";
}

function customise(patch: CampaignCustomisePatch): void {
  void store.customise(patch);
}

watch(
  () => payload.value.areaId,
  () => {
    browsedId.value = "";
  },
);

onMounted(async () => {
  stopSubscription = store.subscribe();
  await store.load();
  if (!disposed) store.loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopSubscription?.();
  disposeCampaignGuide();
});
</script>

<template>
  <div class="campaign-panel" :data-panel-id="panelId">
    <p v-if="!store.api" class="overlay-panel-missing">Campaign guide needs the desktop app.</p>
    <p v-else-if="store.loading.value" class="muted">Loading…</p>
    <p v-else-if="!store.route.value" class="overlay-panel-missing" role="alert">
      Campaign route unavailable: {{ store.error.value || "no answer from the app" }}
    </p>
    <template v-else>
      <header v-if="shownArea" class="panel-head">
        <strong>{{ shownArea.name }}</strong>
        <span class="pill">{{ actLabel(shownArea.part, shownArea.act) }} · L{{ current && isCurrent ? current.observedLevel : shownArea.level }}</span>
        <span v-if="estimate" class="status-chip" :class="tone" :title="estimateTitle">
          ~{{ estimate.percent }} % XP
        </span>
        <span v-if="isCurrent && current?.isCruel" class="tag neutral">Cruel</span>
      </header>
      <p class="community-note">Community route — verify in game · XP % is an estimate</p>

      <p v-if="!shownArea && current && current.kind === 'unknown-campaign'" class="muted">
        Unknown area {{ current.areaId }} — add it under Tools → Campaign guide.
      </p>
      <p v-else-if="!shownArea" class="muted">Not in a campaign area</p>

      <template v-else>
        <p v-if="nextText" class="next-step">{{ nextText }}</p>
        <CampaignObjectiveList
          v-if="!payload.compact"
          :area="shownArea"
          :objectives="objectives"
          :busy="store.busy.value"
          @customise="customise"
        />
        <p v-if="shownArea.userNote" class="campaign-user-note">{{ shownArea.userNote }}</p>
      </template>

      <div class="button-row panel-foot">
        <button type="button" class="button compact ghost" @click="browse(-1)">◀ Prev</button>
        <button type="button" class="button compact ghost" @click="browse(1)">Next ▶</button>
        <button v-if="browsedId" type="button" class="button compact secondary" @click="backToCurrent">
          Back to current
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.campaign-panel {
  display: grid;
  gap: 0.4rem;
  max-height: calc(100vh - 24px);
  overflow: auto;
  font-size: 0.82rem;
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.community-note {
  margin: 0;
  font-size: 0.7rem;
  color: var(--text-muted, #888b8e);
}
.next-step {
  margin: 0;
  color: var(--gold-bright, #e4c587);
}
.campaign-user-note {
  margin: 0;
  font-size: 0.76rem;
  color: var(--text-soft, #b9b4aa);
}
.overlay-panel-missing {
  margin: 0;
  color: var(--amber, #d0a45f);
}
.panel-foot {
  margin-top: 0.2rem;
}
</style>
