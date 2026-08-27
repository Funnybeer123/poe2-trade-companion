<script setup lang="ts">
import { ref } from "vue";
import { useRendererPreferences } from "../../composables/useRendererPreferences";
import { useRuntimeState } from "../../composables/useRuntimeState";
import { rendererApi } from "../../services/rendererApi";

defineProps<{
  panel: "filter" | "settings";
}>();

const runtime = useRuntimeState();
const { defaultDryRun } = useRendererPreferences();
const filterName = ref("local-intelligence");
const hideBelow = ref(40);
const highlightUniques = ref(true);
const filterText = ref("");
const filterError = ref("");
const copied = ref(false);

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
          <h2 id="settings-title">Renderer settings</h2>
        </div>
      </div>
      <label class="toggle-card">
        <input v-model="defaultDryRun" type="checkbox" />
        <span>
          <strong>Default scenarios to dry-run</strong>
          <small>Stored locally and shared with the QA/replay workspace.</small>
        </span>
      </label>
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
