<script setup lang="ts">
/**
 * Add or edit an area, or add/edit one objective. Everything the user can fix
 * in-app so nobody has to edit `route.json` by hand: the bundled data is
 * community knowledge and will be wrong somewhere.
 */
import { computed, ref, watch } from "vue";
import {
  OBJECTIVE_KINDS,
  REWARD_TAGS,
  type CampaignCustomisePatch,
  type MergedArea,
  type MergedObjective,
  type ObjectiveKind,
  type RewardTag,
} from "@core/campaignGuide";
import type { CampaignRouteView } from "../../../shared/campaignGuide.js";

export interface CampaignEditorTarget {
  mode: "add-area" | "edit-area" | "add-objective" | "edit-objective";
  area?: MergedArea;
  objective?: MergedObjective;
  prefill?: { id?: string; name?: string; part?: 1 | 2; act?: number; level?: number };
}

const props = defineProps<{ route: CampaignRouteView | null; target: CampaignEditorTarget; busy?: boolean }>();

const emit = defineEmits<{ customise: [patch: CampaignCustomisePatch]; cancel: [] }>();

const areaId = ref("");
const areaName = ref("");
const areaPart = ref<"1" | "2">("1");
const areaAct = ref("1");
const areaLevel = ref("1");
const areaExits = ref("");
const areaWaypoint = ref(false);
const areaTown = ref(false);
const areaBranch = ref(false);
const areaNote = ref("");

const title = ref("");
const kind = ref<ObjectiveKind>("note");
const detail = ref("");
const targetAreaId = ref("");
const optional = ref(false);
const rewards = ref<Record<RewardTag, boolean>>(
  Object.fromEntries(REWARD_TAGS.map((tag) => [tag, false])) as Record<RewardTag, boolean>,
);

const issue = ref("");

const heading = computed(() => {
  switch (props.target.mode) {
    case "add-area":
      return "Add an area";
    case "edit-area":
      return `Edit ${props.target.area?.name ?? "area"}`;
    case "add-objective":
      return `Add an objective to ${props.target.area?.name ?? "this area"}`;
    default:
      return "Edit objective";
  }
});

const isArea = computed(() => props.target.mode === "add-area" || props.target.mode === "edit-area");

/**
 * `part` and `act` are not `areaOverrides` keys, so an edit could not send
 * them: the fields are disabled rather than accepting a change that silently
 * does nothing.
 */
const placementTitle = computed(() =>
  props.target.mode === "edit-area"
    ? "Act placement comes from the bundled route. Hide the area and add it again to move it."
    : "",
);

watch(
  () => props.target,
  (target) => {
    issue.value = "";
    const area = target.area;
    if (target.mode === "add-area") {
      areaId.value = target.prefill?.id ?? "";
      areaName.value = target.prefill?.name ?? "";
      areaPart.value = target.prefill?.part === 2 ? "2" : "1";
      areaAct.value = String(target.prefill?.act ?? 1);
      areaLevel.value = String(target.prefill?.level ?? 1);
      areaExits.value = "";
      areaWaypoint.value = false;
      areaTown.value = false;
      areaBranch.value = false;
      areaNote.value = "";
    } else if (target.mode === "edit-area" && area) {
      areaId.value = area.id;
      areaName.value = area.name;
      areaPart.value = area.part === 2 ? "2" : "1";
      areaAct.value = String(area.act);
      areaLevel.value = String(area.level);
      areaExits.value = area.exits.join(", ");
      areaWaypoint.value = area.waypoint === true;
      areaTown.value = area.town === true;
      areaBranch.value = area.branch === true;
      areaNote.value = area.userNote ?? "";
    }
    const objective = target.objective;
    title.value = objective?.title ?? "";
    kind.value = objective?.kind ?? "note";
    detail.value = objective?.detail ?? "";
    targetAreaId.value = objective?.targetAreaId ?? "";
    optional.value = objective?.optional === true;
    for (const tag of REWARD_TAGS) rewards.value[tag] = objective?.rewards.includes(tag) ?? false;
  },
  { immediate: true, deep: true },
);

function selectedRewards(): RewardTag[] {
  return REWARD_TAGS.filter((tag) => rewards.value[tag]);
}

function parsedExits(): { exits: string[]; unknown: string[] } {
  const index = props.route?.merged.areaIndex ?? {};
  const exits = areaExits.value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { exits, unknown: exits.filter((exit) => !index[exit]) };
}

function submit(): void {
  issue.value = "";
  if (isArea.value) {
    const id = areaId.value.trim();
    if (!/^[A-Za-z0-9_]{1,40}$/.test(id)) {
      issue.value = "The area id may only contain letters, digits and underscores.";
      return;
    }
    if (!areaName.value.trim()) {
      issue.value = "A name is required.";
      return;
    }
    const { exits, unknown } = parsedExits();
    if (unknown.length) {
      issue.value = `Unknown exit area: ${unknown.join(", ")}`;
      return;
    }
    const part = areaPart.value === "2" ? 2 : 1;
    const base = {
      id,
      name: areaName.value.trim(),
      part: part as 1 | 2,
      act: Math.max(1, Math.min(part === 1 ? 4 : 3, Math.round(Number(areaAct.value) || 1))),
      level: Math.max(1, Math.min(100, Math.round(Number(areaLevel.value) || 1))),
      exits,
      waypoint: areaWaypoint.value,
      town: areaTown.value,
      branch: areaBranch.value,
    };
    if (props.target.mode === "add-area") {
      emit("customise", { op: "add-area", area: base });
    } else {
      emit("customise", {
        op: "edit-area",
        id,
        patch: {
          name: base.name,
          level: base.level,
          exits: base.exits,
          waypoint: base.waypoint,
          town: base.town,
          branch: base.branch,
        },
      });
    }
    if (areaNote.value.trim() || props.target.mode === "edit-area") {
      emit("customise", { op: "set-note", areaId: id, note: areaNote.value });
    }
    return;
  }

  if (!title.value.trim()) {
    issue.value = "A title is required.";
    return;
  }
  if (kind.value === "reach" && targetAreaId.value && !props.route?.merged.areaIndex[targetAreaId.value]) {
    issue.value = `Unknown target area: ${targetAreaId.value}`;
    return;
  }
  const shape = {
    title: title.value.trim(),
    kind: kind.value,
    rewards: selectedRewards(),
    detail: detail.value.trim(),
    ...(targetAreaId.value ? { targetAreaId: targetAreaId.value.trim() } : {}),
    optional: optional.value,
  };
  if (props.target.mode === "add-objective") {
    const area = props.target.area;
    if (!area) {
      issue.value = "Pick an area first.";
      return;
    }
    emit("customise", { op: "add-objective", areaId: area.id, objective: shape });
  } else if (props.target.objective) {
    emit("customise", { op: "edit-objective", id: props.target.objective.id, patch: shape });
  }
}
</script>

<template>
  <!-- Escape closes the editor while the focus is in any of its fields. -->
  <section class="card campaign-editor" aria-labelledby="campaign-editor-title" @keydown.esc="emit('cancel')">
    <div class="section-heading">
      <h3 id="campaign-editor-title">{{ heading }}</h3>
      <button type="button" class="button compact ghost" @click="emit('cancel')">Close</button>
    </div>

    <div v-if="isArea" class="form-grid">
      <label>
        <span>Area id (as Client.txt writes it)</span>
        <input v-model="areaId" type="text" :disabled="target.mode === 'edit-area'" />
      </label>
      <label>
        <span>Name</span>
        <input v-model="areaName" type="text" />
      </label>
      <label :title="placementTitle">
        <span>Half</span>
        <select v-model="areaPart" :disabled="target.mode === 'edit-area'">
          <option value="1">First half (acts 1-4)</option>
          <option value="2">Second half</option>
        </select>
      </label>
      <label :title="placementTitle">
        <span>Act</span>
        <input v-model="areaAct" type="number" min="1" max="4" :disabled="target.mode === 'edit-area'" />
      </label>
      <label>
        <span>Recommended level</span>
        <input v-model="areaLevel" type="number" min="1" max="100" />
      </label>
      <label>
        <span>Exits (area ids, comma separated)</span>
        <input v-model="areaExits" type="text" placeholder="G1_2, G1_3" />
      </label>
      <label class="toggle-field"><input v-model="areaWaypoint" type="checkbox" /><span>Waypoint</span></label>
      <label class="toggle-field"><input v-model="areaTown" type="checkbox" /><span>Town</span></label>
      <label class="toggle-field"><input v-model="areaBranch" type="checkbox" /><span>Side area</span></label>
      <label class="wide">
        <span>Your note for this area</span>
        <textarea v-model="areaNote" rows="2" maxlength="2000"></textarea>
      </label>
    </div>

    <div v-else class="form-grid">
      <label class="wide">
        <span>Title</span>
        <input v-model="title" type="text" maxlength="120" />
      </label>
      <label>
        <span>Kind</span>
        <select v-model="kind">
          <option v-for="option in OBJECTIVE_KINDS" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <label v-if="kind === 'reach'">
        <span>Target area id</span>
        <input v-model="targetAreaId" type="text" placeholder="G1_2" />
      </label>
      <label class="wide">
        <span>Detail</span>
        <textarea v-model="detail" rows="2" maxlength="600"></textarea>
      </label>
      <div class="check-row wide" role="group" aria-label="Reward tags">
        <label v-for="tag in REWARD_TAGS" :key="tag" class="toggle-field">
          <input v-model="rewards[tag]" type="checkbox" />
          <span>{{ tag }}</span>
        </label>
      </div>
      <label class="toggle-field"><input v-model="optional" type="checkbox" /><span>Optional</span></label>
    </div>

    <p v-if="issue" class="inline-notice danger" role="alert">{{ issue }}</p>
    <div class="button-row">
      <button type="button" class="button primary" :disabled="busy" @click="submit">
        {{ busy ? "Saving…" : "Save" }}
      </button>
      <button type="button" class="button ghost" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </section>
</template>

<style scoped>
.campaign-editor {
  display: grid;
  gap: 0.7rem;
}
.form-grid .wide {
  grid-column: 1 / -1;
}
</style>
