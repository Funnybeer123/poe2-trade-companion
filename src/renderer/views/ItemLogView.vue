<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import ViewTabs from "../components/ViewTabs.vue";
import ItemsView from "./ItemsView.vue";
import ScansView from "./ScansView.vue";

const tabs = [
  { id: "catalog", label: "Evaluate & catalog", hint: "Parse, value, keep" },
  { id: "scans", label: "Scan sessions", hint: "Session review" },
] as const;

const route = useRoute();
const tab = ref<string>(route.hash === "#scans" ? "scans" : "catalog");

watch(
  () => route.hash,
  (hash) => {
    if (hash === "#scans") tab.value = "scans";
    if (hash === "#catalog") tab.value = "catalog";
  },
);
</script>

<template>
  <div class="merged-view">
    <ViewTabs v-model="tab" :tabs="tabs" label="Item log sections" />
    <ItemsView v-if="tab === 'catalog'" />
    <ScansView v-else />
  </div>
</template>
