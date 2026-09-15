<script setup lang="ts">
/**
 * The row "peek": one listing rendered with the app's own item card, so a
 * trade2 row reads like a Ctrl+C item. Escape closes it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listingToNormalizedItem } from "@core/tradeListings";
import type { TradeListing } from "@core/tradeListings";
import ItemDetail from "../../../components/ItemDetail.vue";

const props = defineProps<{ listing: TradeListing }>();
const emit = defineEmits<{ (event: "close"): void }>();

const item = computed(() => listingToNormalizedItem(props.listing));
const root = ref<HTMLElement | null>(null);

/**
 * The peek opens from a button in the row, so focus is OUTSIDE this panel:
 * a `@keydown` on the wrapper alone would never fire and the promised
 * Escape would do nothing. Take focus on mount (so a screen reader lands on
 * the dialog too) and listen at the document as the belt-and-braces path.
 */
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

let opener: HTMLElement | null = null;

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.value?.focus();
  document.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  // Hand focus back to the row button that opened the peek.
  opener?.focus();
});
</script>

<template>
  <div
    ref="root"
    class="listing-peek"
    role="dialog"
    tabindex="-1"
    aria-label="Listing detail"
    @keydown.esc.stop="emit('close')"
  >
    <div class="peek-head">
      <span class="muted">Seller {{ props.listing.seller.account }}</span>
      <button type="button" class="button compact ghost" @click="emit('close')">Close</button>
    </div>
    <ItemDetail :item="item" compact />
    <p class="disclaimer">
      Listings are other players’ asks, not sale prices. The app never buys, trades, or clicks accept.
    </p>
  </div>
</template>

<style scoped>
.listing-peek {
  outline: none;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel-raised);
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.peek-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
</style>
