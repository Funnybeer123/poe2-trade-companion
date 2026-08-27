<template>
  <div v-if="operatorState.ipcError" class="error-panel" data-testid="ipc-error">
    <strong>IPC error</strong>
    <p data-testid="ipc-error-message">{{ operatorState.ipcError.message }}</p>
    <button type="button" data-testid="ipc-error-dismiss" @click="dismissIpcError">Dismiss error</button>
  </div>
</template>

<script setup lang="ts">
import { dismissIpcError, operatorState } from "../operatorState.js";
</script>
