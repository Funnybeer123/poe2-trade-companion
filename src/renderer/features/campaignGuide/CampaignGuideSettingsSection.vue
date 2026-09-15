<script setup lang="ts">
/**
 * "Guide settings" — the five preferences of the campaign guide.
 *
 * They live on this feature's own panel (REVIEW-conflicts §6: "P4/P6/P8/P9 on
 * their tools", and the repo's minimal-config rule 4), not under
 * Tools → Settings, which only cross-references them. The component depends
 * on nothing but the two api accessors, so it can be re-homed with one import.
 */
import { computed, ref } from "vue";
import type { CampaignGuideSettings, CampaignOverlayAnchor } from "@core/campaignGuide";
import { getAppFeatureApi } from "../../services/featureApi";

const props = defineProps<{ settings: CampaignGuideSettings }>();

const emit = defineEmits<{ changed: [] }>();

const api = getAppFeatureApi();
const busy = ref(false);
const error = ref("");

const ANCHORS: Array<{ value: CampaignOverlayAnchor; label: string }> = [
  { value: "right", label: "Right edge" },
  { value: "left", label: "Left edge" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
];

const levelOverride = computed(() =>
  props.settings.characterLevelOverride === null ? "" : String(props.settings.characterLevelOverride),
);

async function save(patch: Partial<CampaignGuideSettings>): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    await api.invoke("settings:set", "campaign-guide", patch);
    error.value = "";
    emit("changed");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The setting could not be saved.";
  } finally {
    busy.value = false;
  }
}

function onLevel(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw) {
    void save({ characterLevelOverride: null });
    return;
  }
  void save({ characterLevelOverride: Math.min(100, Math.max(1, Math.round(Number(raw) || 1))) });
}
</script>

<template>
  <details class="advanced-options campaign-guide-settings">
    <summary>Guide settings</summary>
    <p v-if="!api" class="empty-copy">These settings need the desktop app.</p>
    <div v-else class="form-grid">
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.autoShowInCampaign"
          :disabled="busy"
          @change="save({ autoShowInCampaign: ($event.target as HTMLInputElement).checked })"
        />
        <span>Show the overlay automatically in campaign areas</span>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.hideOutsideCampaign"
          :disabled="busy"
          @change="save({ hideOutsideCampaign: ($event.target as HTMLInputElement).checked })"
        />
        <span>Hide it again when you leave the campaign</span>
      </label>
      <label>
        <span>Overlay position</span>
        <select
          :value="settings.overlayAnchor"
          :disabled="busy"
          @change="save({ overlayAnchor: ($event.target as HTMLSelectElement).value as CampaignOverlayAnchor })"
        >
          <option v-for="anchor in ANCHORS" :key="anchor.value" :value="anchor.value">{{ anchor.label }}</option>
        </select>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.overlayCompact"
          :disabled="busy"
          @change="save({ overlayCompact: ($event.target as HTMLInputElement).checked })"
        />
        <span>Compact overlay (header and next step only)</span>
      </label>
      <label>
        <span>Character level override (blank = from the log)</span>
        <input
          type="number"
          min="1"
          max="100"
          :value="levelOverride"
          :disabled="busy"
          placeholder="from log"
          @change="onLevel"
        />
      </label>
    </div>
    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
  </details>
</template>

<style scoped>
.campaign-guide-settings summary {
  cursor: pointer;
  color: var(--text-muted, #888b8e);
  font-size: 0.78rem;
}
.campaign-guide-settings .form-grid {
  margin-top: 0.5rem;
}
</style>
