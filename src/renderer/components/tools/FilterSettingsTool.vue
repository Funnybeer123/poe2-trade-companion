<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRendererPreferences } from "../../composables/useRendererPreferences";
import { useRuntimeState } from "../../composables/useRuntimeState";
import {
  getPriceFeedApi,
  rendererApi,
  type PriceFeedStatusView,
} from "../../services/rendererApi";

defineProps<{
  panel: "filter" | "settings";
}>();

const runtime = useRuntimeState();
const {
  processAllowlist,
  transferActionsPerMinute,
  sortActionsPerMinute,
} = useRendererPreferences();
const filterName = ref("local-intelligence");
const hideBelow = ref(40);
const highlightUniques = ref(true);
const filterText = ref("");
const filterError = ref("");
const copied = ref(false);

const feedApi = getPriceFeedApi();
const feedStatus = ref<PriceFeedStatusView | null>(null);
const feedLeague = ref("auto");
const feedAutoRefresh = ref(false);
const feedSessid = ref("");
const feedSaved = ref("");

onMounted(async () => {
  if (!feedApi) return;
  feedStatus.value = await feedApi.status();
  feedLeague.value = feedStatus.value.config.league;
  feedAutoRefresh.value = feedStatus.value.config.autoRefreshDaily;
});

async function saveFeedConfig(): Promise<void> {
  if (!feedApi) return;
  feedSaved.value = "";
  feedStatus.value = await feedApi.configure({
    league: feedLeague.value.trim() || "auto",
    autoRefreshDaily: feedAutoRefresh.value,
    // Only send the cookie when the user typed one; blank leaves it as-is.
    ...(feedSessid.value.trim() ? { poesessid: feedSessid.value.trim() } : {}),
  });
  feedSessid.value = "";
  feedSaved.value = "Market data settings saved.";
}

async function buildFilter(): Promise<void> {
  filterError.value = "";
  copied.value = false;
  try {
    filterText.value = await rendererApi.generateFilter({
      name: filterName.value.trim() || "local-intelligence",
      hideBelowScore: Math.max(1, Number(hideBelow.value) || 1),
      highlightUniques: highlightUniques.value,
    });
  } catch (reason) {
    filterError.value =
      reason instanceof Error ? reason.message : "Filter generation failed.";
  }
}

async function copyFilter(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard writing is unavailable.");
    }
    await navigator.clipboard.writeText(filterText.value);
    copied.value = true;
  } catch (reason) {
    filterError.value =
      reason instanceof Error ? reason.message : "The filter could not be copied.";
  }
}
</script>

<template>
  <section v-if="panel === 'filter'" class="card tool-panel filter-tool" aria-labelledby="filter-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Local output</span>
        <h2 id="filter-title">Loot filter generator</h2>
      </div>
      <span class="status-chip neutral">No account sync</span>
    </div>
    <p class="muted">
      Generate a local text filter from desirability thresholds. This does not access the
      filesystem or an account API from the renderer.
    </p>
    <div class="form-grid">
      <label>
        Filter name
        <input v-model="filterName" />
      </label>
      <label>
        Hide normal items below item level
        <input v-model.number="hideBelow" type="number" min="1" max="100" />
      </label>
    </div>
    <label class="toggle-field">
      <input v-model="highlightUniques" type="checkbox" />
      <span>Highlight unique items with an alert</span>
    </label>
    <div class="button-row">
      <button type="button" class="button primary" @click="buildFilter">Generate filter</button>
      <button
        type="button"
        class="button secondary"
        :disabled="!filterText"
        @click="copyFilter"
      >
        {{ copied ? "Copied" : "Copy filter text" }}
      </button>
    </div>
    <p v-if="filterError" class="inline-notice danger" role="alert">{{ filterError }}</p>
    <pre v-if="filterText" class="filter-output" tabindex="0">{{ filterText }}</pre>
    <div v-else class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">▽</span>
      <strong>No filter generated</strong>
      <p>Choose a threshold, then generate copy-ready local filter text.</p>
    </div>
  </section>

  <section v-else class="settings-grid" aria-labelledby="settings-title">
    <div class="card tool-panel">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Safe defaults</span>
          <h2 id="settings-title">Automation defaults</h2>
        </div>
      </div>
      <p class="muted">
        Every transfer, sort, and scan uses these defaults. The Dry-run switch
        lives in the top bar and applies everywhere at once.
      </p>
      <div class="form-grid">
        <label>
          Process allowlist
          <input v-model="processAllowlist" placeholder="PathOfExileSteam.exe, PathOfExile.exe" />
        </label>
        <label>
          Transfer actions per minute
          <input v-model.number="transferActionsPerMinute" type="number" min="1" max="600" />
        </label>
        <label>
          Sort actions per minute
          <input v-model.number="sortActionsPerMinute" type="number" min="1" max="1200" />
        </label>
      </div>

      <template v-if="feedApi">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Market data</span>
            <h3>Live prices</h3>
          </div>
        </div>
        <p class="muted">
          The price feed pulls poe2scout prices into the price table on demand
          (Prices tab) or daily. Market comps for one item use the official
          trade2 API and work without a session cookie; adding your
          <code>POESESSID</code> is optional and only ever sent to
          pathofexile.com.
        </p>
        <div class="form-grid">
          <label>
            League <span class="optional">("auto" tracks the current league)</span>
            <input v-model="feedLeague" placeholder="auto" />
          </label>
          <label>
            POESESSID <span class="optional">(optional{{ feedStatus?.config.poesessid ? " · saved" : "" }})</span>
            <input v-model="feedSessid" type="password" autocomplete="off" placeholder="leave blank to keep current" />
          </label>
        </div>
        <label class="toggle-field">
          <input v-model="feedAutoRefresh" type="checkbox" />
        <span>Refresh market prices daily while the app is open</span>
        </label>
        <div class="button-row">
          <button type="button" class="button secondary" @click="saveFeedConfig">
            Save market settings
          </button>
          <button
            v-if="feedStatus?.config.poesessid"
            type="button"
            class="button ghost compact"
            @click="feedApi?.configure({ poesessid: '' }).then((status) => { feedStatus = status; feedSaved = 'Saved cookie cleared.'; })"
          >
            Clear saved cookie
          </button>
          <span v-if="feedSaved" class="success-text" role="status">{{ feedSaved }}</span>
        </div>
      </template>

      <div class="settings-facts">
        <article>
          <span class="nav-glyph" aria-hidden="true">PC</span>
          <div>
            <strong>Price-check hotkey</strong>
            <p>Hover an item, copy it in PoE2, then use Ctrl+D in the Electron app.</p>
          </div>
        </article>
        <article>
          <span class="nav-glyph" aria-hidden="true">ES</span>
          <div>
            <strong>Emergency stop</strong>
            <p>Ctrl+Shift+Esc immediately latches generated input in authorized QA mode.</p>
          </div>
        </article>
        <article>
          <span class="nav-glyph" aria-hidden="true">VO</span>
          <div>
            <strong>Voice transfer</strong>
            <p>Ctrl+Alt+V by default; configure exact behavior in Transfers.</p>
          </div>
        </article>
      </div>
    </div>

    <aside class="card runtime-card">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Environment</span>
          <h2>Runtime status</h2>
        </div>
        <span class="status-chip" :class="runtime.isNative.value ? 'safe' : 'neutral'">
          {{ runtime.isNative.value ? "Electron bridge" : "Browser preview" }}
        </span>
      </div>
      <dl class="property-list">
        <div><dt>Mode</dt><dd>{{ runtime.mode.value }}</dd></div>
        <div><dt>Emergency stop</dt><dd>{{ runtime.killLatched.value ? "Latched" : "Ready" }}</dd></div>
        <div><dt>PoE windows</dt><dd>{{ runtime.poeWindows.value.length }}</dd></div>
      </dl>
      <ul v-if="runtime.poeWindows.value.length" class="window-list">
        <li v-for="entry in runtime.poeWindows.value" :key="`${entry.name}-${entry.title}`">
          <strong>{{ entry.name }}</strong>
          <span>{{ entry.title }}</span>
        </li>
      </ul>
      <p v-else class="muted">
        {{ runtime.isNative.value ? "No configured Path of Exile window is currently detected." : "Preview mode never generates game input." }}
      </p>
      <button
        type="button"
        class="button secondary full-button"
        @click="runtime.refreshRuntime"
      >
        Refresh runtime status
      </button>
    </aside>
  </section>
</template>
