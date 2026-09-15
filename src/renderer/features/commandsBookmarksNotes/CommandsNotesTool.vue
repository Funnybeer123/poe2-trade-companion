<script setup lang="ts">
/**
 * Tools → "Commands & notes": four small lists the user keeps — chat
 * commands, stash searches, bookmarks and cheat-sheet notes — each item
 * bindable to a global hotkey that does exactly one thing per press.
 */
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ViewTabs from "../../components/ViewTabs.vue";
import BookmarksTab from "./BookmarksTab.vue";
import CommandsTab from "./CommandsTab.vue";
import NotesTab from "./NotesTab.vue";
import SearchesTab from "./SearchesTab.vue";
import { getCommandsApi } from "./api";

const TABS = [
  { id: "commands", label: "Commands", hint: "One chat line" },
  { id: "searches", label: "Stash searches", hint: "Typed into the search box" },
  { id: "bookmarks", label: "Bookmarks", hint: "Pages by hotkey" },
  { id: "notes", label: "Notes", hint: "Cheat sheets in the overlay" },
] as const;

const api = getCommandsApi();
const route = useRoute();
const tab = ref<string>("commands");

function tabFromHash(hash: string): string | undefined {
  const id = hash.replace(/^#/, "");
  return TABS.some((entry) => entry.id === id) ? id : undefined;
}

tab.value = tabFromHash(route.hash) ?? "commands";

// One-way hash → tab, like the other merged views.
const stopHash = watch(
  () => route.hash,
  (hash) => {
    const next = tabFromHash(hash);
    if (next) tab.value = next;
  },
);

onBeforeUnmount(() => stopHash());
</script>

<template>
  <section class="card tool-panel commands-notes-tool" aria-labelledby="commands-notes-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Operate</span>
        <h2 id="commands-notes-title">Commands &amp; notes</h2>
      </div>
      <span class="status-chip neutral">One line per key press</span>
    </div>
    <p class="muted">
      Hotkeys that type one chat line, fill the stash search box once, open a page, or show a cheat
      sheet in the overlay. Nothing here runs on its own, repeats itself, or clicks anything; bind the
      keys here or in Tools → Hotkeys.
    </p>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Commands &amp; notes need the desktop app</strong>
      <p>This preview has no bridge to the game or to your saved lists.</p>
    </div>
    <template v-else>
      <ViewTabs v-model="tab" :tabs="TABS" label="Commands &amp; notes sections" />
      <CommandsTab v-if="tab === 'commands'" />
      <SearchesTab v-else-if="tab === 'searches'" />
      <BookmarksTab v-else-if="tab === 'bookmarks'" />
      <NotesTab v-else />
    </template>

    <p class="disclaimer">
      Every send is one chat line typed for you after one key press — never a macro, never a repeat.
    </p>
  </section>
</template>

<style scoped>
.commands-notes-tool {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
</style>
