<script setup lang="ts">
/**
 * Everyday trade toggles — cards, panel behaviour, timeouts, quick whispers,
 * notification channels. NO secret inputs: the Discord / Telegram fields live
 * once, in Tools → Settings → Trade webhooks, next to the market cookie.
 */
import { computed, ref, watch } from "vue";
import { untypableChars, unresolvedPlaceholders, CHAT_PLACEHOLDERS } from "@core/chatCommands";
import {
  MAX_QUICK_WHISPERS,
  type TradeQuickWhisper,
  type TradeSettings,
} from "../../../../shared/trade";

const props = defineProps<{ settings: TradeSettings; busy: boolean }>();
const emit = defineEmits<{ save: [patch: Partial<TradeSettings>] }>();

function clone(value: TradeSettings): TradeSettings {
  return {
    ...value,
    quickWhispers: value.quickWhispers.map((entry) => ({ ...entry })),
    notifications: { ...value.notifications },
    webhooks: { ...value.webhooks },
  };
}

const draft = ref<TradeSettings>(clone(props.settings));

watch(
  () => props.settings,
  (next) => {
    draft.value = clone(next);
  },
  { deep: true },
);

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.settings));

function whisperIssues(entry: TradeQuickWhisper): string[] {
  const issues: string[] = [];
  const template = entry.template.trim();
  if (!template.startsWith("@{player}") && !template.startsWith("/")) {
    issues.push("must start with @{player} or /");
  }
  const untypable = untypableChars(template.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""));
  if (untypable.length) issues.push(`the input host cannot type: ${untypable.join(" ")}`);
  const unknown = unresolvedPlaceholders(template).filter(
    (name) => !(CHAT_PLACEHOLDERS as readonly string[]).includes(name),
  );
  if (unknown.length) issues.push(`unknown placeholder(s): ${unknown.map((name) => `{${name}}`).join(", ")}`);
  if (!entry.label.trim()) issues.push("a label is required");
  return issues;
}

const issues = computed(() => draft.value.quickWhispers.flatMap(whisperIssues));

function addWhisper(): void {
  if (draft.value.quickWhispers.length >= MAX_QUICK_WHISPERS) return;
  draft.value.quickWhispers.push({
    id: `quick-${draft.value.quickWhispers.length + 1}`,
    label: "New",
    template: "@{player} ",
    show: "both",
  });
}

function removeWhisper(index: number): void {
  draft.value.quickWhispers.splice(index, 1);
}

function save(): void {
  emit("save", clone(draft.value));
}

function revert(): void {
  draft.value = clone(props.settings);
}
</script>

<template>
  <div class="trade-settings">
    <div class="form-grid">
      <label class="toggle-field"><input v-model="draft.compact" type="checkbox" /> Compact cards</label>
      <label class="toggle-field"><input v-model="draft.invertedOrder" type="checkbox" /> Newest at bottom</label>
      <label class="toggle-field"><input v-model="draft.autoExpandInTown" type="checkbox" /> Auto-expand in town</label>
      <label>
        In-game panel opens
        <select v-model="draft.showPanelOnOffer">
          <option value="always">Always</option>
          <option value="town">Only in town or hideout</option>
          <option value="never">Never</option>
        </select>
      </label>
      <label class="toggle-field">
        <input v-model="draft.hidePanelWhenIdle" type="checkbox" /> Hide panel when no offers
      </label>
      <label>
        Panel anchor
        <select v-model="draft.panelAnchor">
          <option value="top-right">Top right</option>
          <option value="right">Right</option>
          <option value="left">Left</option>
          <option value="bottom-right">Bottom right</option>
          <option value="bottom-left">Bottom left</option>
        </select>
      </label>
      <label>Offer timeout (min)<input v-model.number="draft.offerTtlMinutes" type="number" min="5" max="720" /></label>
      <label>
        Keep finished cards (min)
        <input v-model.number="draft.completedLingerMinutes" type="number" min="1" max="60" />
      </label>
      <label>
        History retention (days)
        <input v-model.number="draft.historyRetentionDays" type="number" min="1" max="90" />
      </label>
      <label class="toggle-field">
        <input v-model="draft.recordUnmatched" type="checkbox" /> Record unmatched trades
      </label>
      <label class="toggle-field">
        <input v-model="draft.importShopSales" type="checkbox" /> Import verified shop sales
      </label>
    </div>

    <h4>Quick whispers</h4>
    <ul class="whisper-rows">
      <li v-for="(entry, index) in draft.quickWhispers" :key="`${entry.id}-${index}`">
        <input v-model="entry.label" type="text" maxlength="24" aria-label="Quick whisper label" />
        <input v-model="entry.template" type="text" maxlength="240" aria-label="Quick whisper template" />
        <select v-model="entry.show" aria-label="Show this quick whisper for">
          <option value="both">Buyers and sellers</option>
          <option value="incoming">Buyers</option>
          <option value="outgoing">Sellers</option>
        </select>
        <button type="button" class="button ghost compact" @click="removeWhisper(index)">Remove</button>
        <p v-if="whisperIssues(entry).length" class="inline-notice danger" role="alert">
          {{ whisperIssues(entry).join(" · ") }}
        </p>
      </li>
    </ul>
    <div class="button-row">
      <button
        type="button"
        class="button ghost compact"
        :disabled="draft.quickWhispers.length >= MAX_QUICK_WHISPERS"
        @click="addWhisper"
      >
        Add whisper
      </button>
    </div>
    <p class="muted">
      Placeholders: {{ "{player} {item} {price} {tab} {left} {top} {league} {char} {area} {latestWhisper}" }}
    </p>

    <h4>Notifications</h4>
    <div class="form-grid">
      <label class="toggle-field">
        <input v-model="draft.notifications.windows" type="checkbox" /> Windows notification
      </label>
      <label class="toggle-field"><input v-model="draft.notifications.toast" type="checkbox" /> In-game toast</label>
      <label class="toggle-field"><input v-model="draft.notifications.sound" type="checkbox" /> Sound</label>
      <label class="toggle-field">
        <input v-model="draft.notifications.outgoing" type="checkbox" /> Also for my own whispers
      </label>
    </div>
    <p class="muted">
      Discord / Telegram webhooks are set up under Tools → Settings → Trade webhooks (next to the market-data
      cookie).
    </p>

    <div class="button-row">
      <button type="button" class="button primary compact" :disabled="busy || !dirty || issues.length > 0" @click="save">
        {{ busy ? "Saving…" : "Save settings" }}
      </button>
      <button type="button" class="button ghost compact" :disabled="busy || !dirty" @click="revert">Revert</button>
    </div>
    <ul v-if="issues.length" class="notice-list">
      <li v-for="issue in issues" :key="issue">{{ issue }}</li>
    </ul>
  </div>
</template>

<style scoped>
.trade-settings {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.trade-settings h4 {
  margin: 0.2rem 0 0;
}
.whisper-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.whisper-rows li {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(220px, 3fr) minmax(140px, 1fr) auto;
  gap: 0.4rem;
  align-items: center;
}
.whisper-rows .inline-notice {
  grid-column: 1 / -1;
}
</style>
