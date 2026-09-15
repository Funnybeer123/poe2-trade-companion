<script setup lang="ts">
/**
 * The drop-in root for Tools → Settings: the first-run checklist plus the
 * six disclosures this package owns. One desktop-only notice covers the whole
 * block (the browser preview has no settings to fake), and one settings read
 * is shared by every section.
 *
 * Per-feature namespaces (evaluate, inspect, market, trade, …) are NOT
 * rendered here — each package ships its own section.
 */
import { onMounted, ref } from "vue";
import { useRouter, type Router } from "vue-router";
import type { AppInfo } from "../../../shared/appSettings.js";
import { getAppSettingsApi } from "./appSettingsApi";
import { useAppSettings } from "./useAppSettings";
import SetupChecklistCard from "./SetupChecklistCard.vue";
import OverlaySettingsSection from "./OverlaySettingsSection.vue";
import NotificationsSettingsSection from "./NotificationsSettingsSection.vue";
import GameClientSection from "./GameClientSection.vue";
import WindowSettingsSection from "./WindowSettingsSection.vue";
import ChangelogSection from "./ChangelogSection.vue";
import MaintenanceSection from "./MaintenanceSection.vue";

const api = getAppSettingsApi();
const store = useAppSettings();
/** Undefined when the block is mounted without a router (component tests). */
const router = useRouter() as Router | undefined;

const info = ref<AppInfo | null>(null);

function navigate(path: string): void {
  if (router) void router.push(path);
}

onMounted(async () => {
  if (!api) return;
  await store.load();
  try {
    info.value = await api.invoke("app:info");
  } catch {
    info.value = null;
  }
});
</script>

<template>
  <div class="app-settings">
    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <p>App settings need the desktop app.</p>
    </div>

    <template v-else>
      <p v-if="!store.loaded.value" class="muted">
        <span class="spinner" aria-hidden="true"></span> Loading settings…
      </p>
      <!--
        Error and sections are mutually exclusive. A failed `settings:get`
        leaves every slice on its defaults, so rendering the controls anyway
        would show the wrong state AND let the first toggle persist those
        defaults over the settings we could not read.
      -->
      <p v-else-if="store.error.value" class="inline-notice danger" role="alert">
        {{ store.error.value }}
        <button type="button" class="button ghost compact" @click="store.load()">Retry</button>
      </p>

      <template v-else>
        <SetupChecklistCard @navigate="navigate" />
        <OverlaySettingsSection />
        <NotificationsSettingsSection />
        <!--
          Fails CLOSED: until `app:info` answers we assume the public build,
          which must never offer the elevated relaunch.
        -->
        <GameClientSection :build-mode="info?.buildMode ?? 'public-companion'" />
        <WindowSettingsSection />
        <ChangelogSection :info="info" />
        <MaintenanceSection :info="info" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.app-settings {
  margin-top: 0.85rem;
}
</style>
