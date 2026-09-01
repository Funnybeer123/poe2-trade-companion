<script setup lang="ts">
defineProps<{
  tabs: ReadonlyArray<{ id: string; label: string; hint?: string }>;
  modelValue: string;
  label: string;
}>();

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <div class="view-tabs" role="tablist" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.id"
      :class="{ selected: modelValue === tab.id }"
      @click="$emit('update:modelValue', tab.id)"
    >
      <strong>{{ tab.label }}</strong>
      <small v-if="tab.hint">{{ tab.hint }}</small>
    </button>
  </div>
</template>
