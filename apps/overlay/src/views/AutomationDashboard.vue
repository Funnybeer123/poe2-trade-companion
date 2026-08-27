<template>
  <section>
    <h2>Automation dashboard</h2>
    <div class="panel">
      <p data-testid="runtime-mode">Mode: {{ operatorState.capabilities.mode }}</p>
      <p data-testid="arming-status">Armed: {{ operatorState.arming.armed ? "yes" : "no" }}</p>
      <p data-testid="stop-status">
        Emergency stop: {{ operatorState.arming.emergencyStopLatched ? "latched" : "clear" }}
      </p>
      <p data-testid="dry-run-status">Dry-run default: {{ operatorState.arming.dryRunDefault ? "yes" : "no" }}</p>
      <p>Selected state: {{ operatorState.world?.selectedState ?? "—" }}</p>
      <div class="row">
        <button
          data-testid="arm-qa"
          type="button"
          :disabled="!canArm"
          @click="arm"
        >
          Arm
        </button>
        <button data-testid="disarm-qa" type="button" @click="disarm">Disarm</button>
        <button class="danger" data-testid="dashboard-stop" type="button" @click="stop">STOP</button>
        <button data-testid="rearm-stop" type="button" @click="rearm">Rearm stop</button>
      </div>
      <p v-if="!canArm" class="muted" data-testid="arm-disabled-reason">
        {{ armDisabledReason }}
      </p>
    </div>
    <div class="panel">
      <h3>Modules</h3>
      <ul>
        <li v-for="(enabled, moduleId) in operatorState.capabilities.modules" :key="moduleId">
          {{ moduleId }}: {{ enabled ? "on" : "off" }}
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { operatorState } from "../operatorState.js";

const canArm = computed(
  () =>
    operatorState.capabilities.mode === "authorized-qa" &&
    operatorState.capabilities.canEmitNativeInput === true,
);

const armDisabledReason = computed(() => {
  if (operatorState.capabilities.mode !== "authorized-qa") {
    return "Public companion cannot arm QA automation.";
  }
  return "Arming is available in authorized QA mode.";
});

async function arm(): Promise<void> {
  if (!canArm.value) {
    return;
  }
  try {
    const result = await operatorState.api.armQa();
    operatorState.arming = result.arming;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function disarm(): Promise<void> {
  try {
    const result = await operatorState.api.disarmQa();
    operatorState.arming = result.arming;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function stop(): Promise<void> {
  try {
    const result = await operatorState.api.tripStop();
    operatorState.arming = result.arming;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function rearm(): Promise<void> {
  try {
    const result = await operatorState.api.rearmStop();
    operatorState.arming = result.arming;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
