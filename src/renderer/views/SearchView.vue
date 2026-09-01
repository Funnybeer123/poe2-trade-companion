<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import ViewTabs from "../components/ViewTabs.vue";
import FinderView from "./FinderView.vue";
import RulesView from "./RulesView.vue";

const tabs = [
  { id: "finder", label: "Query builder", hint: "Item → stash search" },
  { id: "rules", label: "Rule studio", hint: "OR-of-AND matchers" },
] as const;

const route = useRoute();
const tab = ref<string>(route.hash === "#rules" ? "rules" : "finder");

watch(
  () => route.hash,
  (hash) => {
    if (hash === "#rules") tab.value = "rules";
    if (hash === "#finder") tab.value = "finder";
  },
);
</script>

<template>
  <div class="merged-view">
    <ViewTabs v-model="tab" :tabs="tabs" label="Search and rules sections" />
    <FinderView v-if="tab === 'finder'" />
    <RulesView v-else />
  </div>
</template>
