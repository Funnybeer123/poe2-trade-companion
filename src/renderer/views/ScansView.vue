<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ItemDetail from "../components/ItemDetail.vue";
import type {
  LegacyImportResult,
  ScannerRunSummary,
  ScannerRuntimeEvent,
  ScannerRuntimeStatus,
  ScanSessionDetail,
  ScanSessionView,
} from "../../shared/ipc.js";
import { rendererApi } from "../services/rendererApi";
import {
  formatDate,
  itemFromScanPayload,
} from "../utils/intelligence";

type LoadState = "idle" | "loading" | "ready" | "error";

const sessions = ref<ScanSessionView[]>([]);
const sessionState = ref<LoadState>("idle");
const detailState = ref<LoadState>("idle");
const error = ref("");
const selectedSessionId = ref("");
const detail = ref<ScanSessionDetail | null>(null);
const slotQuery = ref("");
const statusFilter = ref("all");
const importInput = ref("");
const importSourceKey = ref("offline-scan-review");
const importResult = ref<LegacyImportResult | null>(null);
const importing = ref(false);
const scannerStatus = ref<ScannerRuntimeStatus | null>(null);
const scannerGrid = ref<"stash-normal" | "stash-quad" | "inventory">(
  "stash-normal",
);
const scannerDryRun = ref(false);
const scannerAcknowledged = ref(true);
const scannerAllowlist = ref("PathOfExile.exe");
const scannerActionsPerMinute = ref(240);
const scannerError = ref("");
const scannerResult = ref<ScannerRunSummary | null>(null);
const scannerEvents = ref<ScannerRuntimeEvent[]>([]);
let unsubscribeScanner: (() => void) | undefined;

const statusOptions = computed(() => [
  "all",
  ...new Set(detail.value?.slots.map((slot) => slot.status) ?? []),
]);

function statusTone(status: string): "matched" | "missed" | "timeout" | "neutral" {
  const value = status.toLowerCase();
  if (/(match|copied|success|found|complete)/.test(value)) return "matched";
  if (/(timeout|timed-out|expired)/.test(value)) return "timeout";
  if (/(miss|empty|failed|error|rejected|skipped)/.test(value)) return "missed";
  return "neutral";
}

const visibleSlots = computed(() => {
  const query = slotQuery.value.trim().toLowerCase();
  return (detail.value?.slots ?? [])
    .filter(
      (slot) =>
        statusFilter.value === "all" || slot.status === statusFilter.value,
    )
    .filter((slot) => {
      if (!query) return true;
      return [
        slot.slotKey,
        slot.status,
        slot.itemFingerprint ?? "",
        JSON.stringify(slot.payload),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .map((slot) => ({
      slot,
      item: itemFromScanPayload(slot.payload),
      tone: statusTone(slot.status),
    }));
});

const outcomeCounts = computed(() => {
  const counts = { matched: 0, missed: 0, timeout: 0, neutral: 0 };
  for (const slot of detail.value?.slots ?? []) counts[statusTone(slot.status)] += 1;
  return counts;
});

function summaryText(summary: unknown): string {
  if (summary === null || summary === undefined) return "No summary payload";
  if (typeof summary === "string") return summary;
  try {
    return JSON.stringify(summary, null, 2);
  } catch {
    return "Summary payload could not be displayed.";
  }
}

async function loadSessions(preferredId?: string): Promise<void> {
  sessionState.value = "loading";
  error.value = "";
  try {
    sessions.value = await rendererApi.intelligence.scans.list();
    sessionState.value = "ready";
    const nextId =
      preferredId && sessions.value.some((session) => session.id === preferredId)
        ? preferredId
        : sessions.value.some((session) => session.id === selectedSessionId.value)
          ? selectedSessionId.value
          : sessions.value[0]?.id;
    if (nextId) await selectSession(nextId);
    else {
      selectedSessionId.value = "";
      detail.value = null;
    }
  } catch (reason) {
    sessionState.value = "error";
    error.value =
      reason instanceof Error ? reason.message : "Scan sessions could not be loaded.";
  }
}

async function selectSession(sessionId: string): Promise<void> {
  selectedSessionId.value = sessionId;
  detailState.value = "loading";
  error.value = "";
  slotQuery.value = "";
  statusFilter.value = "all";
  try {
    detail.value = await rendererApi.intelligence.scans.get(sessionId);
    detailState.value = "ready";
    if (!detail.value) error.value = "The selected scan session no longer exists.";
  } catch (reason) {
    detailState.value = "error";
    error.value =
      reason instanceof Error ? reason.message : "Scan detail could not be loaded.";
  }
}

async function importScanJsonl(): Promise<void> {
  importing.value = true;
  importResult.value = null;
  error.value = "";
  try {
    importResult.value = await rendererApi.intelligence.imports.legacy({
      kind: "scan-jsonl",
      input: importInput.value,
      sourceKey: importSourceKey.value.trim() || "offline-scan-review",
    });
    const importedSessionId = importResult.value.entityIds.find((entityId) =>
      entityId.startsWith("scan"),
    );
    await loadSessions(importedSessionId);
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : "Offline scan import failed.";
  } finally {
    importing.value = false;
  }
}

async function refreshScannerStatus(): Promise<void> {
  scannerStatus.value = await rendererApi.scanner.status();
}

async function startScanner(): Promise<void> {
  scannerError.value = "";
  scannerResult.value = null;
  try {
    scannerResult.value = await rendererApi.scanner.start({
      gridKind: scannerGrid.value,
      dryRun: scannerDryRun.value,
      qaAcknowledged: scannerAcknowledged.value,
      allowlist: scannerAllowlist.value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      actionsPerMinute: Math.max(
        1,
        Math.floor(scannerActionsPerMinute.value),
      ),
    });
    await refreshScannerStatus();
    await loadSessions(scannerResult.value.sessionId);
  } catch (reason) {
    scannerError.value =
      reason instanceof Error ? reason.message : "Scanner run failed.";
    await refreshScannerStatus().catch(() => undefined);
  }
}

async function stopScanner(): Promise<void> {
  scannerStatus.value = await rendererApi.scanner.stop();
}

onMounted(() => {
  void loadSessions();
  void refreshScannerStatus();
  unsubscribeScanner = rendererApi.scanner.onEvent((event) => {
    scannerEvents.value = [event, ...scannerEvents.value].slice(0, 12);
    void refreshScannerStatus();
  });
});

onUnmounted(() => unsubscribeScanner?.());
</script>

<template>
  <div class="scans-workspace">
    <aside class="card collection-panel scan-sessions" aria-labelledby="scan-sessions-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Offline history</span>
          <h2 id="scan-sessions-title">Sessions</h2>
        </div>
        <span class="count-badge">{{ sessions.length }}</span>
      </div>
      <button type="button" class="button secondary full-button" @click="loadSessions()">
        Refresh sessions
      </button>
      <div v-if="sessionState === 'loading'" class="state-panel compact-state">
        <span class="spinner" aria-hidden="true" />
        <p>Loading scan sessions…</p>
      </div>
      <div v-else-if="!sessions.length" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">▦</span>
        <strong>No scan sessions</strong>
        <p>Run an audited scan or import legacy JSONL for offline review.</p>
      </div>
      <ul v-else class="collection-list scan-session-list">
        <li v-for="session in sessions" :key="session.id">
          <button
            type="button"
            :class="{ selected: selectedSessionId === session.id }"
            @click="selectSession(session.id)"
          >
            <span>
              <strong>{{ session.source }}</strong>
              <small>{{ formatDate(session.startedAt) }}</small>
            </span>
            <span class="tag" :class="statusTone(session.status)">{{ session.status }}</span>
          </button>
        </li>
      </ul>

      <details class="import-panel scan-import">
        <summary>Import offline JSONL</summary>
        <p class="muted">Import creates review records only and emits no game input.</p>
        <label class="field-stack">
          Source key
          <input v-model="importSourceKey" />
        </label>
        <label class="field-stack">
          Scan JSONL
          <textarea v-model="importInput" rows="6" spellcheck="false" />
        </label>
        <button
          type="button"
          class="button secondary full-button"
          :disabled="importing || !importInput.trim()"
          @click="importScanJsonl"
        >
          {{ importing ? "Importing…" : "Import for review" }}
        </button>
        <div v-if="importResult" class="import-result">
          <strong>{{ importResult.parsedRecords }} records parsed</strong>
          <p>{{ importResult.persistedEntities }} entities persisted.</p>
          <ul v-if="importResult.warnings.length">
            <li v-for="warning in importResult.warnings" :key="`${warning.code}-${warning.line ?? ''}`">
              {{ warning.message }}
            </li>
          </ul>
        </div>
      </details>

    </aside>

    <section class="scan-detail">
      <details class="card scan-import scanner-controls">
        <summary>Stash scanner</summary>
        <p class="muted">
          Hover-copy the calibrated grid. Dry runs write journal records without
          sending input. Live runs require an open Path of Exile window.
        </p>
        <label class="field-stack">
          Grid
          <select v-model="scannerGrid">
            <option value="stash-normal">Normal stash · 12×12</option>
            <option value="stash-quad">Quad stash · 24×24</option>
            <option value="inventory">Inventory · 12×5</option>
          </select>
        </label>
        <label class="field-stack">
          Process allowlist
          <input
            v-model="scannerAllowlist"
            placeholder="PathOfExile.exe"
          />
        </label>
        <label class="field-stack">
          Actions per minute
          <input
            v-model.number="scannerActionsPerMinute"
            type="number"
            min="1"
            max="1200"
          />
        </label>
        <label class="inline-toggle">
          <input v-model="scannerDryRun" type="checkbox" />
          Dry run · no generated input
        </label>
        <div class="button-row">
          <button
            type="button"
            class="button primary"
            :disabled="scannerStatus?.running"
            @click="startScanner"
          >
            {{
              scannerStatus?.running
                ? "Scanner running…"
                : scannerDryRun
                  ? "Run dry scan"
                  : "Run live scan"
            }}
          </button>
          <button
            type="button"
            class="button danger ghost"
            :disabled="!scannerStatus?.running"
            @click="stopScanner"
          >
            Stop
          </button>
        </div>
        <p v-if="scannerError" class="inline-notice danger" role="alert">
          {{ scannerError }}
        </p>
        <div v-if="scannerResult" class="import-result" role="status">
          <strong>{{ scannerResult.status }} · {{ scannerResult.recordCount }} records</strong>
          <p>{{ scannerResult.reason }}</p>
        </div>
        <ol v-if="scannerEvents.length" class="semantics-list">
          <li
            v-for="event in scannerEvents"
            :key="`${event.at}-${event.phase}-${event.message}`"
          >
            <span>{{ event.phase === "error" ? "!" : "·" }}</span>
            <p>
              <strong>{{ event.phase }}</strong>
              {{ event.message }}
            </p>
          </li>
        </ol>
      </details>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <div v-if="detailState === 'loading'" class="card state-panel">
        <span class="spinner" aria-hidden="true" />
        <strong>Loading session detail…</strong>
      </div>
      <div v-else-if="!detail" class="card state-panel item-empty">
        <span class="state-icon large" aria-hidden="true">▦</span>
        <span class="eyebrow">No selection</span>
        <h2>Select a scan session</h2>
        <p>Session status, evidence records, and item payloads will appear here.</p>
      </div>
      <template v-else>
        <section class="card session-overview" aria-labelledby="session-detail-title">
          <div class="section-heading">
            <div>
              <span class="eyebrow">{{ detail.session.source }}</span>
              <h2 id="session-detail-title">{{ detail.session.id }}</h2>
            </div>
            <span class="status-chip" :class="statusTone(detail.session.status)">
              {{ detail.session.status }}
            </span>
          </div>
          <dl class="session-metadata">
            <div><dt>Started</dt><dd>{{ formatDate(detail.session.startedAt) }}</dd></div>
            <div><dt>Ended</dt><dd>{{ formatDate(detail.session.endedAt) }}</dd></div>
            <div><dt>Profile</dt><dd>{{ detail.session.profileId || "Not linked" }}</dd></div>
            <div><dt>Records</dt><dd>{{ detail.slots.length }}</dd></div>
          </dl>
          <div class="coverage-summary scan-counts">
            <span class="covered"><strong>{{ outcomeCounts.matched }}</strong> matched</span>
            <span class="missing"><strong>{{ outcomeCounts.missed }}</strong> missed</span>
            <span class="timeout"><strong>{{ outcomeCounts.timeout }}</strong> timeout</span>
            <span><strong>{{ outcomeCounts.neutral }}</strong> other</span>
          </div>
          <details class="summary-payload">
            <summary>Session summary payload</summary>
            <pre>{{ summaryText(detail.session.summary) }}</pre>
          </details>
        </section>

        <section class="card slot-browser" aria-labelledby="slot-records-title">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Evidence</span>
              <h2 id="slot-records-title">Slot records</h2>
            </div>
            <span class="count-badge">{{ visibleSlots.length }} / {{ detail.slots.length }}</span>
          </div>
          <div class="filter-bar">
            <label class="search-field">
              <span class="sr-only">Filter slot records</span>
              <span aria-hidden="true">⌕</span>
              <input v-model="slotQuery" type="search" placeholder="Slot, status, fingerprint…" />
            </label>
            <label>
              <span class="sr-only">Filter by status</span>
              <select v-model="statusFilter">
                <option v-for="status in statusOptions" :key="status" :value="status">
                  {{ status === "all" ? "All statuses" : status }}
                </option>
              </select>
            </label>
          </div>

          <div v-if="!visibleSlots.length" class="state-panel compact-state">
            <strong>No records match these filters</strong>
            <p>Clear the status or text filter to restore the session timeline.</p>
          </div>
          <ol v-else class="slot-record-list">
            <li
              v-for="{ slot, item, tone } in visibleSlots"
              :key="slot.id"
              class="slot-record"
              :class="tone"
            >
              <header>
                <span class="slot-ordinal">{{ slot.ordinal + 1 }}</span>
                <span>
                  <strong>{{ slot.slotKey }}</strong>
                  <small>{{ formatDate(slot.scannedAt ?? slot.createdAt) }}</small>
                </span>
                <span class="tag" :class="tone">{{ slot.status }}</span>
              </header>
              <p v-if="slot.itemFingerprint" class="fingerprint">
                {{ slot.itemFingerprint }}
              </p>
              <ItemDetail v-if="item" :item="item" compact />
              <details v-else class="payload-details">
                <summary>Raw record payload</summary>
                <pre>{{ summaryText(slot.payload) }}</pre>
              </details>
            </li>
          </ol>
        </section>
      </template>
    </section>
  </div>
</template>
