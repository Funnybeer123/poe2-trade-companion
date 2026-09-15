<script setup lang="ts">
import { RouterLink } from "vue-router";
import type { HomeRecommendation } from "../../../../shared/session";

defineProps<{ recommendations: HomeRecommendation[] }>();
</script>

<template>
  <aside class="card recommended" aria-labelledby="home-next-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Next</span>
        <h2 id="home-next-title">Recommended</h2>
      </div>
      <span class="count-badge">{{ recommendations.length }}</span>
    </div>

    <p v-if="!recommendations.length" class="empty-copy">Nothing needs attention.</p>
    <ul v-else class="recommend-list" aria-label="Recommended actions">
      <li v-for="entry in recommendations" :key="entry.id">
        <RouterLink class="recommend-copy" :to="entry.route">
          <strong>{{ entry.title }}</strong>
          <small class="muted">{{ entry.detail }}</small>
        </RouterLink>
        <span class="status-chip" :class="entry.tone === 'warning' ? 'warning' : 'neutral'">
          {{ entry.tone === "warning" ? "blocking" : "suggestion" }}
        </span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.recommended { display: flex; flex-direction: column; gap: 0.55rem; }
.recommend-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.recommend-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.55rem; align-items: start; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.45rem; }
.recommend-copy { display: flex; flex-direction: column; min-width: 0; text-decoration: none; color: inherit; }
.recommend-copy small { opacity: 0.7; }
</style>
