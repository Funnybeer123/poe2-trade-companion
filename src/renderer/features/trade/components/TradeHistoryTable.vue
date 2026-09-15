<script setup lang="ts">
/**
 * The 14-day trade history: totals (estimates at the current divine rate),
 * inline edit, two-click delete and the CSV export — whose button says out
 * loud that the file contains the other players' names.
 */
import { computed, ref } from "vue";
import { formatAmount, formatDate } from "../../../utils/intelligence";
import { formatExalted } from "../api/formatTrade";
import type { TradeHistoryEdit, TradeHistoryEntry, TradeHistoryView } from "../../../../shared/trade";

const props = defineProps<{ view: TradeHistoryView; busy: boolean }>();

const emit = defineEmits<{
  save: [edit: TradeHistoryEdit];
  remove: [id: string];
  export: [target: "file" | "clipboard"];
}>();

interface DraftRow {
  id?: string;
  at: string;
  kind: "sale" | "purchase" | "unknown";
  player: string;
  name: string;
  baseType: string;
  quantity: string;
  amount: string;
  currency: string;
  note: string;
}

const draft = ref<DraftRow | null>(null);
const pendingDeleteId = ref("");

const totals = computed(() => props.view.totals);

function localInput(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function startAdd(): void {
  draft.value = {
    at: localInput(new Date().toISOString()),
    kind: "sale",
    player: "",
    name: "",
    baseType: "",
    quantity: "",
    amount: "",
    currency: "exalted",
    note: "",
  };
}

function startEdit(entry: TradeHistoryEntry): void {
  draft.value = {
    id: entry.id,
    at: localInput(entry.at),
    kind: entry.kind,
    player: entry.player,
    name: entry.item.name,
    baseType: entry.item.baseType ?? "",
    quantity: entry.item.quantity === undefined ? "" : String(entry.item.quantity),
    amount: String(entry.price.amount),
    currency: entry.price.currency,
    note: entry.note ?? "",
  };
}

function cancelEdit(): void {
  draft.value = null;
}

function submit(): void {
  const row = draft.value;
  if (!row) return;
  const at = row.at ? new Date(row.at) : new Date();
  const edit: TradeHistoryEdit = {
    at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    kind: row.kind,
    player: row.player.trim(),
    item: { name: row.name.trim() || "Unknown trade" },
    price: { amount: Number(row.amount) || 0, currency: row.currency.trim() },
    note: row.note.trim(),
  };
  if (row.id) edit.id = row.id;
  if (row.baseType.trim() && edit.item) edit.item.baseType = row.baseType.trim();
  const quantity = Number(row.quantity);
  if (edit.item && Number.isFinite(quantity) && quantity > 1) edit.item.quantity = Math.round(quantity);
  emit("save", edit);
  draft.value = null;
}

function confirmDelete(entry: TradeHistoryEntry): void {
  if (pendingDeleteId.value === entry.id) {
    emit("remove", entry.id);
    pendingDeleteId.value = "";
    return;
  }
  pendingDeleteId.value = entry.id;
}

function sourceLabel(entry: TradeHistoryEntry): string {
  switch (entry.matched) {
    case "offer":
      return "offer card";
    case "shop-ledger":
      return "shop ledger";
    case "unmatched":
      return "unmatched";
    default:
      return "manual";
  }
}
</script>

<template>
  <section class="trade-history">
    <dl class="metric-grid">
      <div>
        <dt>Earnings</dt>
        <dd>≈ {{ formatExalted(totals.earningsExalted) }}</dd>
      </div>
      <div>
        <dt>Spendings</dt>
        <dd>≈ {{ formatExalted(totals.spendingsExalted) }}</dd>
      </div>
      <div>
        <dt>Profit</dt>
        <dd>≈ {{ formatExalted(totals.profitExalted) }}</dd>
      </div>
      <div>
        <dt>Trades</dt>
        <dd>{{ totals.count }}</dd>
      </div>
    </dl>
    <p class="muted">
      at {{ formatAmount(totals.divineRate) }} ex/div ({{ totals.divineRateSource === "price-table" ? "price table" : "fallback" }})
      · {{ totals.unpriced }} unpriced · {{ view.shopLedger.imported }} from the shop ledger
      · retention {{ view.retentionDays }} days
    </p>

    <div class="button-row">
      <button type="button" class="button secondary compact" :disabled="busy" @click="emit('export', 'file')">
        Export CSV (includes player names)…
      </button>
      <button type="button" class="button ghost compact" :disabled="busy" @click="emit('export', 'clipboard')">
        Copy CSV
      </button>
      <button type="button" class="button ghost compact" :disabled="busy" @click="startAdd">Add trade</button>
    </div>

    <p v-if="view.lastError" class="inline-notice warning">{{ view.lastError }}</p>
    <p v-if="view.shopLedger.lastError" class="inline-notice warning">
      Shop ledger: {{ view.shopLedger.lastError }}
    </p>

    <form v-if="draft" class="form-grid history-edit" @submit.prevent="submit">
      <label>When<input v-model="draft.at" type="datetime-local" /></label>
      <label>
        Kind
        <select v-model="draft.kind">
          <option value="sale">Sale</option>
          <option value="purchase">Purchase</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label>Player<input v-model="draft.player" type="text" maxlength="120" /></label>
      <label>Item<input v-model="draft.name" type="text" maxlength="120" /></label>
      <label>Base type<input v-model="draft.baseType" type="text" maxlength="120" /></label>
      <label>Quantity<input v-model="draft.quantity" type="number" min="1" /></label>
      <label>Amount<input v-model="draft.amount" type="number" min="0" step="0.01" /></label>
      <label>Currency<input v-model="draft.currency" type="text" maxlength="40" /></label>
      <label>Note<input v-model="draft.note" type="text" maxlength="500" /></label>
      <div class="button-row">
        <button type="submit" class="button primary compact" :disabled="busy">Save trade</button>
        <button type="button" class="button ghost compact" :disabled="busy" @click="cancelEdit">Cancel</button>
      </div>
    </form>

    <p v-if="!view.entries.length" class="empty-copy">
      No trades recorded yet. A "Trade accepted" line in Client.txt lands here.
    </p>
    <div v-else class="table-scroll">
      <table class="trade-history-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Kind</th>
            <th scope="col">Player</th>
            <th scope="col">Item</th>
            <th scope="col">Price</th>
            <th scope="col">≈ ex</th>
            <th scope="col">League</th>
            <th scope="col">Secure</th>
            <th scope="col">Source</th>
            <th scope="col">Note</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in view.entries" :key="entry.id">
            <td>{{ formatDate(entry.at) }}</td>
            <td>{{ entry.kind }}</td>
            <td>{{ entry.player || "—" }}</td>
            <td>{{ entry.item.name }}{{ entry.item.quantity ? ` ×${entry.item.quantity}` : "" }}</td>
            <td class="num">{{ formatAmount(entry.price.amount) }} {{ entry.price.currency }}</td>
            <td class="num">{{ entry.price.exalted === undefined ? "—" : formatAmount(entry.price.exalted) }}</td>
            <td>{{ entry.league ?? "—" }}</td>
            <td>{{ entry.secure }}</td>
            <td>{{ sourceLabel(entry) }}</td>
            <td>{{ entry.note ?? "" }}</td>
            <td>
              <div class="button-row">
                <button type="button" class="button ghost compact" :disabled="busy" @click="startEdit(entry)">
                  Edit
                </button>
                <button
                  type="button"
                  class="button ghost compact"
                  :class="{ danger: pendingDeleteId === entry.id }"
                  :disabled="busy"
                  :aria-label="pendingDeleteId === entry.id ? `Confirm delete trade with ${entry.player || entry.item.name}` : `Delete trade with ${entry.player || entry.item.name}`"
                  @click="confirmDelete(entry)"
                >
                  {{ pendingDeleteId === entry.id ? "Confirm" : "Delete" }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="disclaimer">
      Exalted values are estimates from the price table at view time, never guaranteed sale prices.
    </p>
  </section>
</template>

<style scoped>
.trade-history {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.table-scroll {
  overflow-x: auto;
}
.trade-history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.trade-history-table th,
.trade-history-table td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.trade-history-table th {
  text-transform: uppercase;
  font-size: 0.72rem;
  opacity: 0.7;
}
.trade-history-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.history-edit {
  border: 1px dashed var(--line-strong, #3b424d);
  border-radius: 10px;
  padding: 0.7rem;
}
</style>
