<script setup lang="ts">
/**
 * The changelog tab: CHANGELOG.md as shipped with the build, with a badge
 * counting releases newer than the last one the user opened.
 *
 * A dev build shows the in-progress "Unreleased" section; a packaged build
 * does not, because that section describes code the user does not have.
 */
import { computed, onMounted, ref } from "vue";
import {
  newestReleasedVersion,
  parseChangelog,
  releasesSince,
  type ChangelogRelease,
} from "@core/appSettingsChangelog";
import { normalizeAppSettings, type AppInfo, type AppSettings } from "../../../shared/appSettings.js";
import { getAppSettingsApi } from "./appSettingsApi";
import { useAppSettings } from "./useAppSettings";

const props = defineProps<{ source?: string; info?: AppInfo | null }>();

const store = useAppSettings();
const api = getAppSettingsApi();

const markdown = ref(props.source ?? "");
const missing = ref(false);
const loading = ref(true);
const error = ref("");

const settings = store.slice<AppSettings>("app", normalizeAppSettings);
const packaged = computed(() => props.info?.packaged === true);
const releases = computed<ChangelogRelease[]>(() => parseChangelog(markdown.value));
const visible = computed(() =>
  releases.value.filter((release) => packaged.value === false || release.version.toLowerCase() !== "unreleased"),
);
const fresh = computed(() =>
  releasesSince(releases.value, settings.value.changelog.lastSeenVersion, {
    includeUnreleased: !packaged.value,
  }),
);
const newCount = computed(() => fresh.value.length);
const freshVersions = computed(() => new Set(fresh.value.map((release) => release.version)));

function sections(release: ChangelogRelease): Array<{ name: string; entries: string[] }> {
  const byName = new Map<string, string[]>();
  for (const entry of release.entries) {
    const list = byName.get(entry.section) ?? [];
    list.push(entry.text);
    byName.set(entry.section, list);
  }
  return [...byName.entries()].map(([name, entries]) => ({ name, entries }));
}

async function markSeen(): Promise<void> {
  const newest = newestReleasedVersion(releases.value);
  if (!newest || newest === settings.value.changelog.lastSeenVersion) return;
  try {
    await store.patch<AppSettings>("app", {
      changelog: { ...settings.value.changelog, lastSeenVersion: newest },
    });
  } catch {
    // A failed bookmark only means the badge stays — never surface it.
  }
}

function onToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void markSeen();
}

onMounted(async () => {
  if (props.source !== undefined) {
    loading.value = false;
    return;
  }
  try {
    const payload = await api?.invoke("app:changelog");
    markdown.value = payload?.markdown ?? "";
    missing.value = payload?.missing ?? true;
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The changelog could not be read.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <details class="advanced-options changelog" @toggle="onToggle">
    <summary>
      Changelog
      <span v-if="newCount" class="count-badge">{{ newCount }} new</span>
    </summary>

    <p v-if="props.info" class="muted">
      PoE2 Trade Companion {{ props.info.version }} · {{ props.info.buildMode }} ·
      {{ props.info.packaged ? "packaged" : "development build" }}
    </p>

    <p v-if="loading" class="muted"><span class="spinner" aria-hidden="true"></span> Reading the changelog…</p>
    <p v-else-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
    <div v-else-if="missing || visible.length === 0" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">i</span>
      <p>No changelog shipped with this build.</p>
    </div>

    <template v-else>
      <article v-for="release in visible" :key="release.version">
        <h4>
          {{ release.version }}<template v-if="release.date"> — {{ release.date }}</template>
          <span v-if="freshVersions.has(release.version)" class="pill safe">new</span>
        </h4>
        <template v-for="section in sections(release)" :key="section.name">
          <h5>{{ section.name }}</h5>
          <ul>
            <li v-for="(entry, index) in section.entries" :key="index">{{ entry }}</li>
          </ul>
        </template>
      </article>
    </template>
  </details>
</template>

<style scoped>
.changelog article {
  margin-top: 0.7rem;
}
.changelog h4 {
  margin: 0 0 0.2rem;
  font-size: 0.86rem;
}
.changelog h5 {
  margin: 0.35rem 0 0.15rem;
  font-size: 0.76rem;
  color: var(--text-muted);
}
.changelog ul {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.8rem;
}
</style>
