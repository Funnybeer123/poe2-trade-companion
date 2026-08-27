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
import { canArmFromUi } from "@core/uiPolicy";
import framesFixture from "../../../../fixtures/perception/full-loop.json";
import { useRendererPreferences } from "../../composables/useRendererPreferences";
import { useRuntimeState } from "../../composables/useRuntimeState";

defineProps<{
  panel: "qa" | "replay";
}>();

const runtime = useRuntimeState();
const { defaultDryRun: dryRun } = useRendererPreferences();
const qaAcknowledged = ref(false);
const allowlist = ref(
  "PathOfExileSteam.exe, PathOfExile.exe, PathOfExile_x64Steam.exe",
);
const selectedScenario = ref(PRESET_SCENARIOS[5]?.id ?? "full-loop");
const armed = ref(false);
const replaying = ref(false);
const replayError = ref("");
const traces = ref("Replay a fixture session to populate the deterministic action trace.");

const allowlistEntries = computed(() =>
  allowlist.value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const buildAllowsQa = computed(() => runtime.mode.value === "authorized-qa");
const canArm = computed(
  () =>
    canArmFromUi(runtime.mode.value, buildAllowsQa.value) &&
    qaAcknowledged.value &&
    allowlistEntries.value.length > 0 &&
    !runtime.killLatched.value,
);
const scenario = computed(
  () =>
    PRESET_SCENARIOS.find((entry) => entry.id === selectedScenario.value) ??
    PRESET_SCENARIOS[0]!,
);

function arm(): void {
  if (canArm.value) armed.value = true;
}

function disarm(): void {
  armed.value = false;
}

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
      buildAllowsQa: buildAllowsQa.value,
      qaAcknowledged: qaAcknowledged.value,
      assistiveAcknowledged: false,
      allowlist: allowlistEntries.value,
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
  <section v-if="panel === 'qa'" class="card tool-panel" aria-labelledby="qa-dashboard-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Capability gate</span>
        <h2 id="qa-dashboard-title">Automation dashboard</h2>
      </div>
      <span
        class="status-chip"
        :class="runtime.mode.value === 'authorized-qa' ? 'warning' : 'safe'"
      >
        {{ runtime.mode.value }}
      </span>
    </div>
    <p class="muted">
      These controls stage the selected QA scenario. Game-affecting actions remain behind the
      main-process interlocks and the auditable GameInputController.
    </p>
    <p v-if="runtime.mode.value !== 'authorized-qa'" class="inline-notice warning">
      Automation cannot be armed in this build. Public companion intelligence remains available.
    </p>
    <p v-if="runtime.killLatched.value" class="inline-notice danger">
      The emergency stop is latched. Re-arm it from the application header before staging a scenario.
    </p>

    <div class="qa-gate-grid">
      <label class="toggle-card">
        <input v-model="qaAcknowledged" type="checkbox" />
        <span>
          <strong>Authorized QA acknowledgement</strong>
          <small>Required before any scenario can be staged.</small>
        </span>
      </label>
      <label class="toggle-card">
        <input v-model="dryRun" type="checkbox" />
        <span>
          <strong>Dry-run default</strong>
          <small>Plans and traces actions without sending input.</small>
        </span>
      </label>
    </div>
    <div class="form-grid">
      <label>
        Scenario
        <select v-model="selectedScenario">
          <option v-for="entry in PRESET_SCENARIOS" :key="entry.id" :value="entry.id">
            {{ entry.name }}
          </option>
        </select>
      </label>
      <label>
        Process allowlist
        <input v-model="allowlist" />
      </label>
    </div>

    <section class="scenario-summary" aria-labelledby="scenario-summary-title">
      <div class="section-heading">
        <h3 id="scenario-summary-title">{{ scenario.name }}</h3>
        <span class="tag">{{ scenario.actionsPerMinute }} actions/min max</span>
      </div>
      <dl class="metric-grid">
        <div><dt>Modules</dt><dd>{{ scenario.enabledModules.join(", ") || "None" }}</dd></div>
        <div><dt>Confidence floor</dt><dd>{{ Math.round(scenario.confidenceThreshold * 100) }}%</dd></div>
        <div><dt>Retry limit</dt><dd>{{ scenario.retryLimit }}</dd></div>
        <div><dt>Timing profile</dt><dd>{{ scenario.timingProfile }}</dd></div>
      </dl>
    </section>

    <div class="button-row">
      <button type="button" class="button primary" :disabled="!canArm || armed" @click="arm">
        Stage selected modules
      </button>
      <button type="button" class="button secondary" :disabled="!armed" @click="disarm">
        Disarm
      </button>
      <span class="status-chip" :class="armed && canArm ? 'warning' : 'neutral'">
        {{ armed && canArm ? "Staged" : "Not staged" }}
      </span>
    </div>
  </section>

  <section v-else class="card tool-panel replay-tool" aria-labelledby="replay-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Deterministic simulation</span>
        <h2 id="replay-title">Replay &amp; action traces</h2>
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
      <label class="toggle-field">
        <input v-model="qaAcknowledged" type="checkbox" />
        <span>Authorized QA acknowledgement</span>
      </label>
    </div>
    <label class="toggle-field">
      <input v-model="dryRun" type="checkbox" />
      <span>Mark replay scenario dry-run (FakeInputSink is used either way)</span>
    </label>
    <button
      type="button"
      class="button primary"
      :disabled="replaying"
      @click="runReplay"
    >
      {{ replaying ? "Replaying…" : "Replay fixture session" }}
    </button>
    <p v-if="replayError" class="inline-notice danger" role="alert">{{ replayError }}</p>
    <pre class="trace-output" tabindex="0">{{ traces }}</pre>
  </section>
</template>
