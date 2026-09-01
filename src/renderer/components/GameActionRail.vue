<script setup lang="ts">
import { onMounted } from "vue";
import { useGameActions } from "../composables/useGameActions";

const {
  dryRun,
  killLatched,
  canStop,
  canStartEmpty,
  canStartFill,
  canStartSort,
  overlayVisible,
  transferStatus,
  railStatus,
  transferBlockReason,
  sortBlockReason,
  initializeGameActions,
  startAssistive,
  sortStash,
  stopGameActions,
  rearmKillSwitch,
  labelOverlayCell,
  canSendToCursor,
  sendingToCursor,
  sendToCursor,
  cursorHandoffBlockReason,
} = useGameActions();

onMounted(() => {
  void initializeGameActions();
});
</script>

<template>
  <section class="game-action-rail" aria-label="Game actions">
    <header class="game-action-heading">
      <h2>Game actions</h2>
      <span
        class="game-action-mode"
        :class="{ live: !dryRun }"
        :title="dryRun ? 'Dry-run: plans and overlays only. Toggle in the top bar.' : 'Live: actions send input to the game. Toggle Dry-run in the top bar.'"
      >
        {{ dryRun ? "Dry-run" : "Live" }}
      </span>
    </header>

    <div class="game-action-grid">
      <button
        type="button"
        class="button compact primary"
        :disabled="!canStartEmpty"
        :title="canStartEmpty ? 'Deposit bag into stash' : transferBlockReason()"
        @click="startAssistive({ kind: 'empty' })"
      >
        Empty
      </button>
      <button
        type="button"
        class="button compact primary"
        :disabled="!canStartFill"
        :title="canStartFill ? 'Fill bag from stash' : transferBlockReason()"
        @click="startAssistive({ kind: 'fill' })"
      >
        Fill
      </button>
      <button
        type="button"
        class="button compact"
        :disabled="!canStartFill"
        :title="canStartFill ? 'Fill then empty' : transferBlockReason()"
        @click="startAssistive({ kind: 'two-cycle' })"
      >
        2-cycle
      </button>
      <button
        type="button"
        class="button compact"
        :disabled="!canStartSort"
        :title="
          canStartSort
            ? dryRun
              ? 'Scan and preview stash sort (dry-run)'
              : 'Scan then sort the open stash tab'
            : sortBlockReason()
        "
        @click="sortStash()"
      >
        Sort
      </button>
    </div>

    <div class="game-action-row">
      <button
        type="button"
        class="button compact danger"
        :disabled="!canStop"
        title="Stop the active transfer or sort"
        @click="stopGameActions()"
      >
        Stop
      </button>
      <button
        v-if="killLatched"
        type="button"
        class="button compact"
        title="Clear the emergency-stop latch"
        @click="rearmKillSwitch()"
      >
        Re-arm
      </button>
      <button
        v-if="canSendToCursor"
        type="button"
        class="button compact"
        :disabled="sendingToCursor"
        :title="cursorHandoffBlockReason()"
        @click="sendToCursor()"
      >
        {{ sendingToCursor ? "Sending…" : "Fix in Cursor" }}
      </button>
    </div>

    <div v-if="overlayVisible" class="game-action-row">
      <button
        type="button"
        class="button compact primary"
        :disabled="!transferStatus.overlaySelection?.length"
        title="Mark the selected overlay item(s) as correctly detected"
        @click="labelOverlayCell('right')"
      >
        Right
      </button>
      <button
        type="button"
        class="button compact danger"
        :disabled="!transferStatus.overlaySelection?.length"
        title="Mark the selected overlay item(s) as incorrectly detected"
        @click="labelOverlayCell('wrong')"
      >
        Wrong
      </button>
    </div>

    <p class="game-action-status" role="status">{{ railStatus }}</p>
  </section>
</template>
