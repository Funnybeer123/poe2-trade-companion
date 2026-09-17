<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import BagTriageTool from "../components/tools/BagTriageTool.vue";
import CalibrationPanel from "../CalibrationPanel.vue";
import SortStashPanel from "../SortStashPanel.vue";
import StashTabAdminPanel from "../components/StashTabAdminPanel.vue";
import TransferPanel from "../TransferPanel.vue";
import FilterSettingsTool from "../components/tools/FilterSettingsTool.vue";
import HotkeyActionsTool from "../components/tools/HotkeyActionsTool.vue";
import QaReplayTool from "../components/tools/QaReplayTool.vue";
import MarketTrendsTool from "../components/tools/MarketTrendsTool.vue";
import WatchlistTool from "../components/tools/WatchlistTool.vue";
import CommandsNotesTool from "../features/commandsBookmarksNotes/CommandsNotesTool.vue";
import PricingHistoryTool from "../features/pricingHistory/PricingHistoryTool.vue";
import StashTrackerTool from "../features/stashTracker/StashTrackerTool.vue";
import CampaignGuideTool from "../features/campaignGuide/CampaignGuideTool.vue";
import PriceTrainingTool from "../features/priceTraining/PriceTrainingTool.vue";

const route = useRoute();

const tools = [
  { id: "bag-triage", label: "Bag cleanup & rings", detail: "Scan, gamble & vendor" },
  { id: "calibration", label: "Calibration", detail: "Screen regions" },
  { id: "transfers", label: "Transfers", detail: "Audited stash movement" },
  { id: "sort-stash", label: "Sort stash", detail: "Preview & execute" },
  { id: "stash-tabs", label: "Stash tabs", detail: "Rename & recolour" },
  { id: "hotkeys", label: "Hotkeys", detail: "Numpad game actions" },
  { id: "commands", label: "Commands & notes", detail: "Hotkeys, searches, bookmarks" },
  { id: "diagnostics", label: "Diagnostics", detail: "Replay & traces" },
  { id: "filter", label: "Loot filter", detail: "Local generation" },
  { id: "settings", label: "Settings", detail: "Automation defaults" },
  { id: "market", label: "Market", detail: "Trends & stack advice" },
  { id: "deals", label: "Deals", detail: "Underpriced listings" },
  { id: "pricing", label: "Pricing", detail: "History & favorites" },
  { id: "price-training", label: "Price training", detail: "Teach prices & review items" },
  { id: "stash-tracker", label: "Stash tracker", detail: "Snapshots & history" },
  { id: "campaign", label: "Campaign guide", detail: "Route, map & XP" },
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
      <CalibrationPanel v-if="selectedTool === 'calibration'" />
      <BagTriageTool v-else-if="selectedTool === 'bag-triage'" />
      <TransferPanel v-else-if="selectedTool === 'transfers'" />
      <SortStashPanel v-else-if="selectedTool === 'sort-stash'" />
      <StashTabAdminPanel v-else-if="selectedTool === 'stash-tabs'" />
      <HotkeyActionsTool v-else-if="selectedTool === 'hotkeys'" />
      <CommandsNotesTool v-else-if="selectedTool === 'commands'" />
      <QaReplayTool v-else-if="selectedTool === 'diagnostics'" />
      <FilterSettingsTool v-else-if="selectedTool === 'filter'" panel="filter" />
      <MarketTrendsTool v-else-if="selectedTool === 'market'" />
      <WatchlistTool v-else-if="selectedTool === 'deals'" />
      <PricingHistoryTool v-else-if="selectedTool === 'pricing'" />
      <PriceTrainingTool v-else-if="selectedTool === 'price-training'"
        :initial-item-text="typeof route.query.item === 'string' ? route.query.item : undefined" />
      <StashTrackerTool v-else-if="selectedTool === 'stash-tracker'" />
      <CampaignGuideTool v-else-if="selectedTool === 'campaign'" />
      <FilterSettingsTool v-else panel="settings" />
    </div>
  </div>
</template>
