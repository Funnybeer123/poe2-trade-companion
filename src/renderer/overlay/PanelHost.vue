<script setup lang="ts">
/**
 * The chrome around one overlay panel: title bar (drag handle), pin toggle,
 * close button, and the lazily loaded panel component. Pointer enter/leave
 * bubble up so OverlayApp can tell main when the window must take the mouse.
 */
import { computed, defineAsyncComponent, type Component } from "vue";
import type { OverlayPanelDefinition } from "./panels";

export interface OpenPanel {
  id: string;
  definition?: OverlayPanelDefinition;
  payload: unknown;
  position: { x: number; y: number };
  size: { width: number; height: number };
  pinned: boolean;
  focus: boolean;
  visible: boolean;
  /** Stacking order; the highest is "topmost" for Escape. */
  z: number;
}

const props = defineProps<{
  panel: OpenPanel;
  scale: number;
}>();

const emit = defineEmits<{
  close: [];
  "toggle-pin": [];
  move: [position: { x: number; y: number }];
  raise: [];
  "pointer-enter": [];
  "pointer-leave": [];
}>();

/** One async wrapper per panel id, or the lazy import would re-run on every render. */
const asyncComponents = new Map<string, Component>();

const component = computed<Component | undefined>(() => {
  const definition = props.panel.definition;
  if (!definition) return undefined;
  let wrapped = asyncComponents.get(definition.id);
  if (!wrapped) {
    wrapped = defineAsyncComponent(definition.component);
    asyncComponents.set(definition.id, wrapped);
  }
  return wrapped;
});

const title = computed(() => props.panel.definition?.title ?? props.panel.id);

const styleVars = computed(() => ({
  left: `${props.panel.position.x}px`,
  top: `${props.panel.position.y}px`,
  width: `${props.panel.size.width}px`,
  zIndex: String(100 + props.panel.z),
}));

let drag: { startX: number; startY: number; originX: number; originY: number; element: HTMLElement } | undefined;

function onBarPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button")) return;
  const element = (event.currentTarget as HTMLElement).closest(".overlay-panel") as HTMLElement | null;
  if (!element) return;
  drag = {
    startX: event.clientX,
    startY: event.clientY,
    originX: props.panel.position.x,
    originY: props.panel.position.y,
    element,
  };
  emit("raise");
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // happy-dom / older engines: dragging still works while the pointer stays on the bar.
  }
}

function onBarPointerMove(event: PointerEvent): void {
  if (!drag) return;
  const scale = props.scale || 1;
  const width = drag.element.offsetWidth * scale;
  const height = drag.element.offsetHeight * scale;
  const maxX = Math.max(0, window.innerWidth - width);
  const maxY = Math.max(0, window.innerHeight - height);
  emit("move", {
    x: Math.round(Math.min(maxX, Math.max(0, drag.originX + (event.clientX - drag.startX)))),
    y: Math.round(Math.min(maxY, Math.max(0, drag.originY + (event.clientY - drag.startY)))),
  });
}

function onBarPointerUp(): void {
  drag = undefined;
}
</script>

<template>
  <section
    class="overlay-panel"
    :class="{ pinned: panel.pinned, dragging: Boolean(drag) }"
    :style="styleVars"
    :data-panel-id="panel.id"
    role="dialog"
    :aria-label="title"
    @pointerenter="emit('pointer-enter')"
    @pointerleave="emit('pointer-leave')"
    @pointerdown="emit('raise')"
  >
    <header
      class="overlay-panel-bar"
      @pointerdown="onBarPointerDown"
      @pointermove="onBarPointerMove"
      @pointerup="onBarPointerUp"
      @pointercancel="onBarPointerUp"
    >
      <span class="overlay-panel-title">{{ title }}</span>
      <button
        type="button"
        class="icon-button"
        :class="{ active: panel.pinned }"
        :title="panel.pinned ? 'Unpin (Escape and Hide all will close it)' : 'Pin (survives Escape and Hide all)'"
        :aria-pressed="panel.pinned"
        @click="emit('toggle-pin')"
      >
        {{ panel.pinned ? "📌" : "📍" }}
      </button>
      <button type="button" class="icon-button" title="Close" aria-label="Close" @click="emit('close')">×</button>
    </header>
    <div class="overlay-panel-body">
      <component
        :is="component"
        v-if="component"
        :panel-id="panel.id"
        :payload="panel.payload"
        :visible="panel.visible"
        @close="emit('close')"
      />
      <p v-else class="overlay-panel-missing">
        No panel is registered as "{{ panel.id }}" (src/renderer/overlay/panels.ts).
      </p>
    </div>
  </section>
</template>
