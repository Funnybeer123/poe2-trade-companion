<script setup lang="ts">
/**
 * One offer card, shared by the desktop view and the in-game overlay panel.
 * Every button emits ONE action; the parent turns it into exactly one chat
 * line. Nothing here accepts a trade — the app has no click capability.
 */
import { computed, ref } from "vue";
import {
  directionChip,
  formatOfferPrice,
  offerAge,
  priceTitle,
  secureChip,
  stateChip,
} from "../api/formatTrade";
import type { TradeOffer, TradeOfferAction, TradeQuickWhisper } from "../../../../shared/trade";

const props = defineProps<{
  offer: TradeOffer;
  compact: boolean;
  expanded: boolean;
  quickWhispers: TradeQuickWhisper[];
  busy: boolean;
  dryRun: boolean;
  chatEnabled: boolean;
  chatDisabledReason?: string;
  origin: "desktop" | "overlay";
  divineRate?: number;
  divineRateSource?: "price-table" | "fallback";
  feedAgeHours?: number;
  now?: number;
}>();

const emit = defineEmits<{
  action: [action: TradeOfferAction];
  toggle: [];
  focusRequest: [focus: boolean];
}>();

const customOpen = ref(false);
const customText = ref("");
const menuOpen = ref(false);

const body = computed(() => props.expanded || !props.compact);
const direction = computed(() => directionChip(props.offer.direction));
const state = computed(() => stateChip(props.offer.state));
const secure = computed(() => secureChip(props.offer.secure));
const active = computed(() =>
  ["new", "invited", "joined", "trading"].includes(props.offer.state),
);
const age = computed(() => offerAge(props.offer.at, props.now ?? Date.now()));
const priceText = computed(() => formatOfferPrice(props.offer.price));
const priceHint = computed(() =>
  priceTitle(props.offer.price, props.divineRate ?? 0, props.divineRateSource ?? "fallback", props.feedAgeHours),
);
const whispers = computed(() =>
  props.quickWhispers.filter(
    (entry) =>
      entry.show === "both" ||
      (entry.show === "incoming" && props.offer.direction === "incoming") ||
      (entry.show === "outgoing" && props.offer.direction === "outgoing"),
  ),
);
const disabled = computed(() => props.busy || !props.chatEnabled);
const suffix = computed(() => (props.dryRun ? " (dry-run)" : ""));

function run(action: TradeOfferAction): void {
  emit("action", action);
}

function openCustom(): void {
  customOpen.value = true;
  if (props.origin === "overlay") emit("focusRequest", true);
}

function closeCustom(): void {
  customOpen.value = false;
  customText.value = "";
  if (props.origin === "overlay") emit("focusRequest", false);
}

function sendCustom(): void {
  const text = customText.value.trim();
  if (!text) return;
  run({ kind: "custom-whisper", text });
  closeCustom();
}
</script>

<template>
  <article
    class="trade-offer"
    :class="[
      offer.direction,
      `state-${offer.state}`,
      { compact: props.compact, expanded: props.expanded },
    ]"
    tabindex="0"
    @keydown.enter.self="emit('toggle')"
    @keydown.space.self.prevent="emit('toggle')"
  >
    <header class="trade-offer-head" @click="emit('toggle')">
      <span class="pill" :class="direction.tone">{{ direction.label }}</span>
      <strong class="player">{{ offer.player }}</strong>
      <small v-if="offer.guildTag" class="muted">&lt;{{ offer.guildTag }}&gt;</small>
      <span class="muted">{{ age }}</span>
      <span class="status-chip" :class="state.tone">{{ state.label }}</span>
      <span v-if="offer.repeats > 1" class="pill warning">×{{ offer.repeats }}</span>
      <span v-if="offer.leagueMatches === false" class="pill danger">wrong league</span>
      <span v-if="secure" class="pill" :class="secure.tone">{{ secure.label }}</span>
      <span v-if="!offer.templateTested" class="pill neutral">untested template</span>
    </header>

    <div v-if="body" class="trade-offer-body">
      <p class="trade-item">
        <strong>{{ offer.item.display }}</strong>
        <span class="trade-price" :title="priceHint">{{ priceText }}</span>
      </p>
      <p class="muted">
        <span v-if="offer.stash">stash “{{ offer.stash.tab }}” · left {{ offer.stash.left }}, top {{ offer.stash.top }} · </span>
        {{ offer.league }}
      </p>
      <p v-if="offer.lastMessage" class="trade-last-message muted">
        {{ offer.lastMessage.direction === "in" ? "↩" : "↪" }} {{ offer.lastMessage.text }}
      </p>

      <nav class="trade-actions button-row" :aria-label="`Actions for offer from ${offer.player}`">
        <template v-if="active && offer.direction === 'incoming'">
          <button
            type="button"
            class="button compact primary"
            :disabled="disabled"
            :title="chatDisabledReason"
            @click="run({ kind: 'invite' })"
          >
            Invite{{ suffix }}
          </button>
          <button
            type="button"
            class="button compact"
            :disabled="disabled"
            :title="chatDisabledReason"
            @click="run({ kind: 'trade' })"
          >
            Trade{{ suffix }}
          </button>
        </template>
        <template v-else-if="active">
          <button
            type="button"
            class="button compact primary"
            :disabled="disabled"
            :title="chatDisabledReason"
            @click="run({ kind: 'hideout' })"
          >
            Hideout{{ suffix }}
          </button>
          <button
            type="button"
            class="button compact"
            :disabled="disabled"
            :title="chatDisabledReason"
            @click="run({ kind: 'trade' })"
          >
            Trade{{ suffix }}
          </button>
        </template>

        <button
          v-if="active && offer.direction === 'incoming'"
          type="button"
          class="button compact"
          :disabled="disabled"
          :title="chatDisabledReason ?? 'Types the item name into the stash search box — open your stash first.'"
          @click="run({ kind: 'highlight' })"
        >
          Highlight{{ suffix }}
        </button>

        <details
          class="trade-whisper-menu"
          :open="menuOpen"
          @toggle="menuOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>Whisper</summary>
          <ul class="whisper-list">
            <li v-for="whisper in whispers" :key="whisper.id">
              <button
                type="button"
                class="button ghost compact"
                :disabled="disabled"
                :title="chatDisabledReason"
                @click="run({ kind: 'quick-whisper', id: whisper.id })"
              >
                {{ whisper.label }}{{ suffix }}
              </button>
            </li>
            <li>
              <button type="button" class="button ghost compact" :disabled="busy" @click="openCustom">
                Custom…
              </button>
            </li>
            <li>
              <button type="button" class="button ghost compact" :disabled="busy" @click="run({ kind: 'copy-whisper' })">
                Copy whisper line
              </button>
            </li>
          </ul>
          <div v-if="customOpen" class="custom-whisper">
            <label>
              <span class="sr-only">Whisper to {{ offer.player }}</span>
              <input
                v-model="customText"
                type="text"
                maxlength="200"
                placeholder="ty, on my way"
                @keydown.ctrl.enter.prevent="sendCustom"
                @keydown.esc.stop.prevent="closeCustom"
              />
            </label>
            <button type="button" class="button compact" :disabled="disabled" @click="sendCustom">
              Send{{ suffix }}
            </button>
          </div>
        </details>

        <button
          v-if="offer.direction === 'incoming' && offer.state !== 'dismissed'"
          type="button"
          class="button ghost compact"
          :disabled="disabled"
          :title="chatDisabledReason"
          @click="run({ kind: 'kick' })"
        >
          Kick{{ suffix }}
        </button>
        <button
          v-if="offer.direction === 'outgoing' && offer.state !== 'dismissed'"
          type="button"
          class="button ghost compact"
          :disabled="disabled"
          :title="chatDisabledReason"
          @click="run({ kind: 'leave' })"
        >
          Leave{{ suffix }}
        </button>

        <button
          v-if="!active"
          type="button"
          class="button ghost compact"
          :disabled="busy"
          @click="run({ kind: 'reopen' })"
        >
          Reopen
        </button>
        <button type="button" class="button ghost compact" :disabled="busy" @click="run({ kind: 'dismiss' })">
          Dismiss
        </button>
      </nav>
    </div>
  </article>
</template>

<style scoped>
.trade-offer {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line, #2b3038);
  border-radius: 10px;
  background: var(--panel-soft, #121519);
}
.trade-offer.state-completed,
.trade-offer.state-cancelled,
.trade-offer.state-dismissed {
  opacity: 0.72;
}
.trade-offer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}
.player {
  font-size: 0.92rem;
}
.trade-offer-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.trade-item {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
}
.trade-price {
  color: var(--gold, #c8a66a);
  font-variant-numeric: tabular-nums;
}
.trade-last-message {
  margin: 0;
  font-style: italic;
}
.trade-offer-body p.muted {
  margin: 0;
}
.trade-whisper-menu {
  display: inline-block;
}
.trade-whisper-menu summary {
  cursor: pointer;
  font-size: 0.78rem;
  padding: 0.2rem 0.4rem;
}
.whisper-list {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.custom-whisper {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  margin-top: 0.35rem;
}
.custom-whisper input {
  min-width: 180px;
}
</style>
