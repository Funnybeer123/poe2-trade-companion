<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CalibrationPanel from "../CalibrationPanel.vue";
import SortStashPanel from "../SortStashPanel.vue";
import TransferPanel from "../TransferPanel.vue";
import FilterSettingsTool from "../components/tools/FilterSettingsTool.vue";
import OpportunityTool from "../components/tools/OpportunityTool.vue";
import QaReplayTool from "../components/tools/QaReplayTool.vue";
import { useRuntimeState } from "../composables/useRuntimeState";

const route = useRoute();
const runtime = useRuntimeState();

const tools = [
  { id: "overview", label: "Overview", group: "General", detail: "Tool directory" },
  { id: "opportunity", label: "Deal analysis", group: "General", detail: "Manual margin signal" },
  { id: "calibration", label: "Calibration", group: "Authorized QA", detail: "Screen regions" },
  { id: "transfers", label: "Transfers", group: "Authorized QA", detail: "Audited stash movement" },
  { id: "sort-stash", label: "Sort stash", group: "Authorized QA", detail: "Preview & execute" },
  { id: "qa", label: "QA dashboard", group: "Authorized QA", detail: "Capability gates" },
  { id: "replay", label: "Replay & traces", group: "Diagnostics", detail: "Zero-input simulation" },
  { id: "filter", label: "Loot filter", group: "Companion", detail: "Local generation" },
  { id: "settings", label: "Settings", group: "General", detail: "Defaults & runtime" },
] as const;

type ToolId = (typeof tools)[number]["id"];

const selectedTool = computed<ToolId>(() => {
  const value = Array.isArray(route.params.tool)
    ? route.params.tool[0]
    : route.params.tool;
  return tools.some((tool) => tool.id === value)
    ? (value as ToolId)
    : "overview";
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
        <span>
          <small>{{ tool.group }}</small>
          <strong>{{ tool.label }}</strong>
        </span>
        <span class="tool-detail">{{ tool.detail }}</span>
      </RouterLink>
    </nav>

    <div class="tool-content">
      <section v-if="selectedTool === 'overview'" class="tools-overview">
        <div class="card tool-hero">
          <div>
            <span class="eyebrow">Operations</span>
            <h2>Item intelligence and stash automation share one app</h2>
            <p>
              Transfers, sorting, and scans can send input to Path of Exile. They still
              require calibration, a matching game window, and the emergency stop
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd>.
            </p>
          </div>
          <div class="safety-seal" :class="{ qa: runtime.isAuthorizedQa.value }">
            <span aria-hidden="true">{{ runtime.isAuthorizedQa.value ? "QA" : "PC" }}</span>
            <strong>{{ runtime.mode.value }}</strong>
            <small>{{ runtime.killLatched.value ? "Stop latched" : "Safety ready" }}</small>
          </div>
        </div>

        <div class="tool-card-grid">
          <RouterLink
            v-for="tool in tools.filter((entry) => entry.id !== 'overview')"
            :key="tool.id"
            :to="`/tools/${tool.id}`"
            class="card tool-directory-card"
          >
            <span class="eyebrow">{{ tool.group }}</span>
            <h3>{{ tool.label }}</h3>
            <p>{{ tool.detail }}</p>
            <span class="text-link">Open tool <span aria-hidden="true">→</span></span>
          </RouterLink>
        </div>
      </section>

      <OpportunityTool v-else-if="selectedTool === 'opportunity'" />
      <CalibrationPanel v-else-if="selectedTool === 'calibration'" />
      <TransferPanel v-else-if="selectedTool === 'transfers'" />
      <SortStashPanel v-else-if="selectedTool === 'sort-stash'" />
      <QaReplayTool v-else-if="selectedTool === 'qa'" panel="qa" />
      <QaReplayTool v-else-if="selectedTool === 'replay'" panel="replay" />
      <FilterSettingsTool v-else-if="selectedTool === 'filter'" panel="filter" />
      <FilterSettingsTool v-else panel="settings" />
    </div>
  </div>
</template>
