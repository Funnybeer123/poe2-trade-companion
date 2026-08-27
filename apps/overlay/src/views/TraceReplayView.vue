<template>
  <section>
    <h2>Trace replay</h2>
    <div class="panel row">
      <label for="replay-id">Replay id</label>
      <input id="replay-id" data-testid="replay-id" v-model="replayId" />
      <button class="primary" data-testid="run-replay" type="button" @click="run">Run replay</button>
    </div>
    <p v-if="selectedStates.length > 0" data-testid="replay-states">
      {{ selectedStates.join(" → ") }}
    </p>
    <table data-testid="trace-table">
      <thead>
        <tr>
          <th>Tick</th>
          <th>State</th>
          <th>Reason</th>
          <th>Interlock</th>
          <th>Executed</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="trace in operatorState.traces" :key="trace.id">
          <td>{{ trace.tickId }}</td>
          <td>{{ trace.selectedState }}</td>
          <td>{{ trace.decisionReason }}</td>
          <td>{{ trace.interlockCode }}</td>
          <td>{{ trace.executed ? "yes" : "no" }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { operatorState, refreshWorld } from "../operatorState.js";

const replayId = ref("full-loop");
const selectedStates = computed(() => operatorState.traces.map((trace) => trace.selectedState));

async function run(): Promise<void> {
  try {
    const result = await operatorState.api.runReplay(replayId.value);
    operatorState.traces = result.traces;
    await refreshWorld();
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
