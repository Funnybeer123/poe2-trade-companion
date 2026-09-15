<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import type { NoticePayload } from "../../shared/overlay.js";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

/** Anything can arrive in `payload`; render a safe default instead of throwing. */
const notice = computed<NoticePayload>(() => {
  const source = (typeof props.payload === "object" && props.payload !== null ? props.payload : {}) as Partial<NoticePayload>;
  const tone = source.tone;
  return {
    title: typeof source.title === "string" && source.title ? source.title : "Notice",
    body: typeof source.body === "string" ? source.body : "",
    tone: tone === "ok" || tone === "warning" || tone === "danger" ? tone : "info",
    ttlMs: typeof source.ttlMs === "number" && Number.isFinite(source.ttlMs) && source.ttlMs > 0 ? source.ttlMs : undefined,
  };
});

let timer: ReturnType<typeof setTimeout> | undefined;

function armTtl(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const ttl = notice.value.ttlMs;
  if (!ttl || !props.visible) return;
  timer = setTimeout(() => emit("close"), ttl);
}

watch(() => [notice.value.ttlMs, props.visible, props.payload], armTtl, { immediate: true });
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="notice" :class="`tone-${notice.tone}`" role="status">
    <strong class="notice-title">{{ notice.title }}</strong>
    <p v-if="notice.body" class="notice-body">{{ notice.body }}</p>
  </div>
</template>

<style scoped>
.notice {
  display: grid;
  gap: 0.3rem;
  padding: 0.2rem 0.1rem;
  border-left: 3px solid var(--blue, #79afc7);
  padding-left: 0.6rem;
}
.notice.tone-ok {
  border-left-color: var(--green, #80b886);
}
.notice.tone-warning {
  border-left-color: var(--amber, #d0a45f);
}
.notice.tone-danger {
  border-left-color: var(--red, #d57b76);
}
.notice-title {
  font-size: 0.86rem;
}
.notice-body {
  margin: 0;
  color: var(--text-soft, #b9b4aa);
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: pre-wrap;
}
</style>
