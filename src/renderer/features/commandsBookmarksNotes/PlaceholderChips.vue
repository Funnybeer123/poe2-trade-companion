<script setup lang="ts">
/**
 * The ten placeholders a chat line may carry, plus what each would resolve to
 * right now. A value of "—" means the line would be refused until the game
 * log supplies one — better than whispering to nobody.
 */
import { computed } from "vue";
import { CHAT_PLACEHOLDERS } from "@core/chatCommands";
import type { PlaceholderSnapshot } from "../../../shared/commandsBookmarksNotes.js";
import { formatDate } from "../../utils/intelligence";

const props = withDefaults(
  defineProps<{
    snapshot: PlaceholderSnapshot;
    /** When true the tokens are buttons that insert themselves into a line. */
    insertable?: boolean;
  }>(),
  { insertable: false },
);

const emit = defineEmits<{ insert: [token: string] }>();

const SOURCE_LABELS: Record<string, string> = {
  whisper: "latest whisper",
  "trade-whisper": "latest trade whisper",
  area: "current area",
  character: "character",
  "price-feed": "price feed",
};

const rows = computed(() =>
  CHAT_PLACEHOLDERS.map((name) => {
    const value = props.snapshot.context[name];
    const source = props.snapshot.sources[name];
    return {
      name,
      token: `{${name}}`,
      value: value === undefined || value === null || value === "" ? "—" : String(value),
      source: source ? SOURCE_LABELS[source] ?? source : "",
    };
  }),
);
</script>

<template>
  <div class="placeholder-chips">
    <div class="chip-row">
      <template v-if="insertable">
        <button
          v-for="row in rows"
          :key="row.name"
          type="button"
          class="pill"
          :aria-label="`Insert ${row.token}`"
          :title="row.value"
          @click="emit('insert', row.token)"
        >
          {{ row.token }}
        </button>
      </template>
      <template v-else>
        <span v-for="row in rows" :key="`t-${row.name}`" class="pill" :title="row.value">
          {{ row.token }}
        </span>
      </template>
    </div>
    <dl class="property-list compact-list">
      <template v-for="row in rows" :key="`v-${row.name}`">
        <dt>{{ row.token }}</dt>
        <dd>
          {{ row.value }}
          <small v-if="row.source" class="muted">{{ row.source }}</small>
        </dd>
      </template>
    </dl>
    <p class="muted">
      Latest whisper {{ formatDate(snapshot.whisperAt) }} · latest trade whisper
      {{ formatDate(snapshot.tradeWhisperAt) }}
    </p>
  </div>
</template>

<style scoped>
.placeholder-chips {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.property-list dd small {
  margin-left: 0.35rem;
}
</style>
