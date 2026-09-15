<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { HomeOverview } from "../../../../shared/session";
import { when } from "../format";

const props = defineProps<{ home: HomeOverview }>();

const character = computed(() => props.home.character);
const identity = computed(() => {
  const entry = character.value;
  if (!entry) return "";
  return [entry.name, entry.className, entry.level !== undefined ? `lvl ${entry.level}` : ""]
    .filter(Boolean)
    .join(" · ");
});
const sourceNote = computed(() => {
  switch (character.value?.source) {
    case "level-up":
      return "from a level-up line";
    case "backfill":
      return "from the last level-up in the log window";
    case "override":
      return "set by hand in Tools → Settings";
    case "death":
      return "name only, from a death line";
    default:
      return "";
  }
});
</script>

<template>
  <section class="card home-hero" aria-labelledby="home-character-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Character</span>
        <h2 id="home-character-title">Who is playing</h2>
      </div>
      <span class="status-chip neutral">Read from Client.txt</span>
    </div>

    <p v-if="!character" class="empty-copy">
      No character yet — level up once, or set the name under Tools → Settings → Session &amp; recap.
      <span v-if="!home.clientLog.watching"> Client.txt is not being read yet.</span>
    </p>
    <template v-else>
      <p class="identity">{{ identity }}</p>
      <p class="muted">{{ sourceNote }} · seen {{ when(character.seenAt) }}</p>
    </template>

    <dl class="property-list">
      <div>
        <dt>Area now</dt>
        <dd v-if="home.area">
          {{ home.area.name }}<span v-if="home.area.unverified" class="muted"> (name unverified)</span>
          <small class="muted">{{ home.area.category }} · level {{ home.area.level }}</small>
        </dd>
        <dd v-else>—</dd>
      </div>
      <div v-if="home.campaign">
        <dt>Campaign</dt>
        <dd>
          Act {{ home.campaign.act }}<span v-if="home.campaign.part === 2"> (part 2)</span> ·
          {{ home.campaign.name }}
          <small v-if="home.campaign.hint" class="muted">{{ home.campaign.hint }}</small>
        </dd>
      </div>
      <div>
        <dt>XP per hour</dt>
        <dd><span class="status-chip neutral">Needs account link (not available)</span></dd>
      </div>
      <div>
        <dt>Time to next level</dt>
        <dd><span class="status-chip neutral">Needs account link (not available)</span></dd>
      </div>
    </dl>

    <p class="muted">
      Level and class come from the game's own log lines; the app has no account link, so experience
      numbers are never estimated.
      <RouterLink class="text-link" to="/tools/campaign">Campaign guide</RouterLink>
    </p>
  </section>
</template>

<style scoped>
.home-hero { display: flex; flex-direction: column; gap: 0.6rem; }
.identity { margin: 0; font-size: 1.05rem; font-weight: 650; }
.property-list { margin: 0; display: grid; gap: 0.45rem; }
.property-list div { display: grid; grid-template-columns: minmax(0, 10rem) minmax(0, 1fr); gap: 0.6rem; }
.property-list dt { font-size: 0.78rem; opacity: 0.75; }
.property-list dd { margin: 0; }
.property-list dd small { display: block; }
</style>
