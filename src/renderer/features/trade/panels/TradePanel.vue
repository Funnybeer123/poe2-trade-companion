<script setup lang="ts">
/**
 * The in-game trade panel. It renders the same cards as the desktop view but
 * with `origin="overlay"`, so main sends chat lines WITHOUT bringing another
 * window forward — the game already has focus.
 *
 * The one exception is the "Custom…" input: it needs the keyboard, so the
 * panel asks main for focus (`trade:panel-focus(true)`) and gives it back
 * before the line is typed. While it holds focus, clicking the game blurs the
 * overlay and the click-outside rule closes an unpinned panel — pin it, or
 * press Escape first.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TradeOfferList from "../components/TradeOfferList.vue";
import { getTradeApi } from "../api/tradeApi";
import { describeChatOutcome } from "../api/formatTrade";
import { createFeatureApi } from "../../../services/featureApi";
import type { ChatContract, ChatEvents } from "../../../../shared/chatCommands";
import { isOverlayWindow, playOfferSound } from "../api/useTradeSound";
import {
  DEFAULT_TRADE_SETTINGS,
  type TradeOffer,
  type TradeOfferAction,
  type TradePanelPayload,
  type TradeStatus,
} from "../../../../shared/trade";

const props = defineProps<{ panelId: string; payload: unknown; visible: boolean }>();
defineEmits<{ close: [] }>();

const api = getTradeApi();
const offers = ref<TradeOffer[]>([]);
const status = ref<TradeStatus | null>(null);
const settings = ref(DEFAULT_TRADE_SETTINGS);
const busyOfferId = ref("");
const busy = ref(false);
const notice = ref("");
/** A refusal is announced as an alert; "Typed …"/"Dry-run …" is just status. */
const noticeIsError = ref(false);

const chatEnabled = computed(() => status.value?.chat?.enabled !== false);
// The in-game panel must say WHY a button is dead, exactly like the desktop
// view: a greyed-out button with no tooltip is unexplainable mid-trade.
const chatDisabledReason = computed(() =>
  chatEnabled.value ? undefined : "Chat commands are disabled in Tools → Settings",
);

const seed = computed<Partial<TradePanelPayload>>(() =>
  typeof props.payload === "object" && props.payload !== null ? (props.payload as TradePanelPayload) : {},
);

function applySeed(): void {
  const value = seed.value;
  if (Array.isArray(value.offers)) offers.value = value.offers;
  if (value.status) status.value = value.status;
  if (value.settings) settings.value = { ...DEFAULT_TRADE_SETTINGS, ...value.settings };
}

/** Active cards plus anything finished in the last two minutes (Thanks / Kick). */
const shown = computed(() => {
  const now = Date.now();
  return offers.value.filter((offer) => {
    if (["new", "invited", "joined", "trading"].includes(offer.state)) return true;
    const at = Date.parse(offer.stateAt);
    return Number.isFinite(at) && now - at < 2 * 60_000;
  });
});

const compact = computed(() => settings.value.compact || shown.value.length > 3);

let unsubscribers: Array<() => void> = [];

// The seed is applied immediately (and again whenever main pushes a new
// payload) so the panel paints its cards on the very first frame.
watch(() => props.payload, applySeed, { immediate: true });

onMounted(() => {
  if (!api) return;
  unsubscribers = [
    api.on("trade:changed", (next) => {
      offers.value = next;
    }),
    api.on("trade:status", (next) => {
      status.value = next;
    }),
    api.on("trade:offer", (event) => {
      if (event.reason !== "new" || event.playSoundIn !== "overlay") return;
      if (isOverlayWindow()) playOfferSound();
    }),
  ];
  // The chat service announces its own enabled / kill-switch / budget state:
  // without this the in-game buttons keep the state the payload was built with.
  const chatApi = createFeatureApi<ChatContract, ChatEvents>();
  if (chatApi) {
    unsubscribers.push(
      chatApi.on("chat:status", () => {
        void api.invoke("trade:status").then(
          (next) => {
            status.value = next;
          },
          () => undefined,
        );
      }),
    );
  }
});

onBeforeUnmount(() => {
  for (const stop of unsubscribers) {
    try {
      stop();
    } catch {
      // Already gone.
    }
  }
  unsubscribers = [];
});

async function runAction(offerId: string, action: TradeOfferAction): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  busyOfferId.value = offerId;
  try {
    const outcome = await api.invoke("trade:offer-action", offerId, action, "overlay");
    // A blocked chat line sets no top-level `error` — the reason lives on
    // `chat`. Without describeChatOutcome the panel showed nothing at all for
    // a kill-switch, not-foreground, rate-limit or disabled refusal.
    notice.value = outcome.error ?? describeChatOutcome(outcome.chat);
    noticeIsError.value = !outcome.ok;
    offers.value = await api.invoke("trade:offers");
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "That action could not be run.";
    noticeIsError.value = true;
  } finally {
    busy.value = false;
    busyOfferId.value = "";
  }
}

async function setFocus(focus: boolean): Promise<void> {
  if (!api) return;
  try {
    status.value = await api.invoke("trade:panel-focus", focus);
  } catch {
    // Focus is best-effort: the buttons keep working without it.
  }
}
</script>

<template>
  <div class="trade-panel">
    <div v-if="!api" class="muted">Trade needs the desktop app.</div>
    <template v-else>
      <TradeOfferList
        v-if="shown.length"
        :offers="shown"
        :compact="compact"
        :in-town="status?.area?.inTown ?? false"
        :auto-expand-in-town="settings.autoExpandInTown"
        :quick-whispers="settings.quickWhispers"
        :busy-offer-id="busyOfferId"
        :busy="busy"
        :dry-run="status?.dryRun ?? false"
        :chat-enabled="chatEnabled"
        :chat-disabled-reason="chatDisabledReason"
        origin="overlay"
        :divine-rate="status?.divineRate"
        :divine-rate-source="status?.divineRateSource"
        :feed-age-hours="status?.feedAgeHours"
        @action="runAction"
        @focus-request="setFocus"
      />
      <p v-else class="muted">No active offers</p>
      <p v-if="notice && noticeIsError" class="trade-panel-alert" role="alert">{{ notice }}</p>
      <p v-else-if="notice" class="muted" role="status">{{ notice }}</p>
    </template>
  </div>
</template>

<style scoped>
.trade-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.84rem;
}
.trade-panel-alert {
  margin: 0;
  color: var(--danger, #d98b8b);
}
</style>
