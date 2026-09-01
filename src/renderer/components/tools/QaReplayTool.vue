<script setup lang="ts">
import { computed, ref } from "vue";
import { RuntimeCapabilities } from "@core/capabilities";
import { GameInputController } from "@core/gameInputController";
import { FakeInputSink } from "@core/inputSink";
import { KillSwitch } from "@core/killSwitch";
import { RecordedFrameSource } from "@core/perception";
import { replayScenario } from "@core/replay";
import { PRESET_SCENARIOS } from "@core/scenarios";
import type { PerceptionFrame } from "@core/types";
import framesFixture from "../../../../fixtures/perception/full-loop.json";
import { useGameActions } from "../../composables/useGameActions";
import { allowlistEntries, useRendererPreferences } from "../../composables/useRendererPreferences";
import { useRuntimeState } from "../../composables/useRuntimeState";

const runtime = useRuntimeState();
const { defaultDryRun: dryRun, processAllowlist } = useRendererPreferences();
const gameActions = useGameActions();
const selectedScenario = ref(PRESET_SCENARIOS[5]?.id ?? "full-loop");
const replaying = ref(false);
const replayError = ref("");
const traces = ref("Replay a fixture session to populate the deterministic action trace.");

const scenario = computed(
  () =>
    PRESET_SCENARIOS.find((entry) => entry.id === selectedScenario.value) ??
    PRESET_SCENARIOS[0]!,
);

async function runReplay(): Promise<void> {
  replaying.value = true;
  replayError.value = "";
  try {
    const sink = new FakeInputSink();
    const controller = new GameInputController(
      sink,
      new KillSwitch(),
      runtime.mode.value,
    );
    const replayProfile = {
      ...scenario.value,
      dryRun: dryRun.value,
    };
    const capabilities = new RuntimeCapabilities({
      mode: runtime.mode.value,
      buildAllowsQa: true,
      qaAcknowledged: true,
      assistiveAcknowledged: false,
      allowlist: allowlistEntries(processAllowlist.value),
      bannerVisible: runtime.mode.value === "authorized-qa",
      emergencyStopRegistered: true,
    });
    await replayScenario(
      new RecordedFrameSource(framesFixture as PerceptionFrame[]),
      replayProfile,
      controller,
      capabilities,
      "fixture-replay",
    );
    traces.value = JSON.stringify(controller.actionTraces, null, 2);
  } catch (reason) {
    replayError.value =
      reason instanceof Error ? reason.message : "Fixture replay failed.";
  } finally {
    replaying.value = false;
  }
}
</script>

<template>
  <section class="card tool-panel replay-tool" aria-labelledby="diagnostics-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Deterministic simulation</span>
        <h2 id="diagnostics-title">Diagnostics — replay &amp; traces</h2>
      </div>
      <span class="status-chip safe">Fake input sink</span>
    </div>
    <p class="muted">
      Recorded perception frames are replayed through the decision stack. This panel always uses
      FakeInputSink and therefore cannot emit real OS input.
    </p>
    <div class="form-grid">
      <label>
        Scenario
        <select v-model="selectedScenario">
          <option v-for="entry in PRESET_SCENARIOS" :key="entry.id" :value="entry.id">
            {{ entry.name }}
          </option>
        </select>
      </label>
    </div>
    <dl class="metric-grid scenario-facts">
      <div><dt>Modules</dt><dd>{{ scenario.enabledModules.join(", ") || "None" }}</dd></div>
      <div><dt>Rate limit</dt><dd>{{ scenario.actionsPerMinute }} actions/min</dd></div>
      <div><dt>Confidence floor</dt><dd>{{ Math.round(scenario.confidenceThreshold * 100) }}%</dd></div>
      <div><dt>Timing profile</dt><dd>{{ scenario.timingProfile }}</dd></div>
    </dl>
    <div class="button-row">
      <button
        type="button"
        class="button primary"
        :disabled="replaying"
        @click="runReplay"
      >
        {{ replaying ? "Replaying…" : "Replay fixture session" }}
      </button>
      <button
        v-if="gameActions.canSendToCursor.value"
        type="button"
        class="button secondary"
        :disabled="gameActions.sendingToCursor.value"
        :title="gameActions.cursorHandoffBlockReason()"
        @click="gameActions.sendToCursor()"
      >
        {{ gameActions.sendingToCursor.value ? "Sending…" : "Fix in Cursor" }}
      </button>
    </div>
    <p v-if="replayError" class="inline-notice danger" role="alert">{{ replayError }}</p>
    <pre class="trace-output" tabindex="0">{{ traces }}</pre>
  </section>
</template>
