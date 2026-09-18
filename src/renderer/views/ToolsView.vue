<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CalibrationPanel from "../CalibrationPanel.vue";
import SortStashPanel from "../SortStashPanel.vue";
import StashTabAdminPanel from "../components/StashTabAdminPanel.vue";
import TransferPanel from "../TransferPanel.vue";
import FilterSettingsTool from "../components/tools/FilterSettingsTool.vue";
import HotkeyActionsTool from "../components/tools/HotkeyActionsTool.vue";
import QaReplayTool from "../components/tools/QaReplayTool.vue";
import FollowerTool from "../components/tools/FollowerTool.vue";
import CombatAssistTool from "../components/tools/CombatAssistTool.vue";
import PriceHelperTool from "../components/tools/PriceHelperTool.vue";
import BagTriageTool from "../components/tools/BagTriageTool.vue";

const route = useRoute();

const tools = [
  { id: "follower", label: "Follow & Loot", detail: "Two-PC connection & route preview" },
  { id: "price-helper", label: "Price helper", detail: "Live prices & Island Rumours" },
  { id: "combat", label: "Flasks & Unleash", detail: "Health, mana & cooldowns" },
  { id: "bag-triage", label: "Bag triage", detail: "Capture, identify & triage" },
  { id: "calibration", label: "Calibration", detail: "Screen regions" },
  { id: "transfers", label: "Transfers", detail: "Audited stash movement" },
  { id: "sort-stash", label: "Sort stash", detail: "Preview & execute" },
  { id: "stash-tabs", label: "Stash tabs", detail: "Rename & recolour" },
  { id: "hotkeys", label: "Hotkeys", detail: "Numpad game actions" },
  { id: "diagnostics", label: "Diagnostics", detail: "Replay & traces" },
  { id: "filter", label: "Loot filter", detail: "Local generation" },
  { id: "settings", label: "Settings", detail: "Automation defaults" },
] as const;

type ToolId = (typeof tools)[number]["id"];

const selectedTool = computed<ToolId>(() => {
  const value = Array.isArray(route.params.tool)
    ? route.params.tool[0]
    : route.params.tool;
  return tools.some((tool) => tool.id === value)
    ? (value as ToolId)
    : "calibration";
});
</script>

<template>
  <div class="tools-workspace">
    <nav class="tool-nav card" aria-label="Tools and QA sections">
      <RouterLink
        v-for="tool in tools"
        :key="tool.id"
        :to="`/tools/${tool.id}`"
        :class="{ selected: selectedTool === tool.id }"
      >
        <strong>{{ tool.label }}</strong>
        <span class="tool-detail">{{ tool.detail }}</span>
      </RouterLink>
    </nav>

    <div class="tool-content">
      <PriceHelperTool v-if="selectedTool === 'price-helper'" />
      <FollowerTool v-else-if="selectedTool === 'follower'" />
      <CombatAssistTool v-else-if="selectedTool === 'combat'" />
      <BagTriageTool v-else-if="selectedTool === 'bag-triage'" />
      <CalibrationPanel v-else-if="selectedTool === 'calibration'" />
      <TransferPanel v-else-if="selectedTool === 'transfers'" />
      <SortStashPanel v-else-if="selectedTool === 'sort-stash'" />
      <StashTabAdminPanel v-else-if="selectedTool === 'stash-tabs'" />
      <HotkeyActionsTool v-else-if="selectedTool === 'hotkeys'" />
      <QaReplayTool v-else-if="selectedTool === 'diagnostics'" />
      <FilterSettingsTool v-else-if="selectedTool === 'filter'" panel="filter" />
      <FilterSettingsTool v-else panel="settings" />
    </div>
  </div>
</template>
