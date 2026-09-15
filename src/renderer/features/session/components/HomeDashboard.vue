<script setup lang="ts">
import type { HomeOverview } from "../../../../shared/session";
import CharacterCard from "./CharacterCard.vue";
import HomeChecklistCard from "./HomeChecklistCard.vue";
import LastRecapCard from "./LastRecapCard.vue";
import MarketMoversCard from "./MarketMoversCard.vue";
import RecentMapsTable from "./RecentMapsTable.vue";
import RecommendedActions from "./RecommendedActions.vue";
import SessionActivityCard from "./SessionActivityCard.vue";
import StashGainsCard from "./StashGainsCard.vue";

defineProps<{ home: HomeOverview; busy?: boolean }>();
const emit = defineEmits<{ "end-session": []; "show-recap": [] }>();
</script>

<template>
  <div class="home-workspace">
    <div class="home-main">
      <CharacterCard :home="home" />
      <SessionActivityCard
        :home="home"
        :busy="busy"
        @end-session="emit('end-session')"
        @show-recap="emit('show-recap')"
      />
      <LastRecapCard v-if="home.session.lastRecap" :recap="home.session.lastRecap" />
      <RecentMapsTable :runs="home.recentMaps" />
      <StashGainsCard :stash="home.stash" :trade="home.trade" />
      <MarketMoversCard :market="home.market" />
    </div>
    <div class="home-side">
      <HomeChecklistCard :home="home" />
      <RecommendedActions :recommendations="home.recommendations" />
    </div>
  </div>
</template>

<style scoped>
.home-workspace { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr); gap: 1rem; align-items: start; }
.home-main, .home-side { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
@media (max-width: 1380px) {
  .home-workspace { grid-template-columns: minmax(0, 1fr); }
}
</style>
