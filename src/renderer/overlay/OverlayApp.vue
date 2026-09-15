<script setup lang="ts">
/**
 * Root of the transparent overlay window ("#/overlay"). Main drives it with
 * "overlay:panel" commands; this component keeps the list of open panels,
 * hosts their chrome, and reports the user's actions back through
 * "overlay:panel-event" / "overlay:set-ignore-mouse".
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  OverlayContract,
  OverlayEvents,
  OverlayPanelCommand,
  OverlayPanelEvent,
  OverlayStyle,
} from "../../shared/overlay.js";
import { createFeatureApi } from "../services/featureApi";
import PanelHost, { type OpenPanel } from "./PanelHost.vue";
import { findOverlayPanel } from "./panels";
import "./overlay.css";

const api = createFeatureApi<OverlayContract, OverlayEvents>();
const panels = ref<OpenPanel[]>([]);
const style = ref<OverlayStyle>({ scale: 1, opacity: 0.96, closeOnClickOutside: true });
let nextZ = 1;
let hovered = 0;
let stopPanelEvents: (() => void) | undefined;

const cssVars = computed(() => ({
  "--overlay-scale": String(style.value.scale),
  "--overlay-opacity": String(style.value.opacity),
}));

function send(event: OverlayPanelEvent): void {
  void api?.invoke("overlay:panel-event", event).catch(() => {});
}

function setIgnoreMouse(ignore: boolean): void {
  void api?.invoke("overlay:set-ignore-mouse", ignore).catch(() => {});
}

function upsert(command: OverlayPanelCommand): void {
  const id = String(command.panelId ?? "");
  if (!id) return;
  const definition = findOverlayPanel(id);
  const existing = panels.value.find((panel) => panel.id === id);
  const size = command.size ?? existing?.size ?? definition?.defaultSize ?? { width: 360, height: 240 };
  const position = command.position ?? existing?.position ?? { x: 24, y: 24 };
  const next: OpenPanel = {
    id,
    definition,
    payload: command.payload !== undefined ? command.payload : existing?.payload,
    position,
    size,
    pinned: command.pinned ?? existing?.pinned ?? false,
    focus: command.focus ?? existing?.focus ?? false,
    visible: true,
    z: nextZ++,
  };
  panels.value = [...panels.value.filter((panel) => panel.id !== id), next];
  send({ panelId: id, kind: "shown" });
}

function remove(ids: string[]): void {
  if (!ids.length) return;
  panels.value = panels.value.filter((panel) => !ids.includes(panel.id));
}

function handleCommand(command: OverlayPanelCommand): void {
  if (!command || typeof command !== "object") return;
  if (command.style) {
    style.value = {
      scale: Number.isFinite(command.style.scale) ? command.style.scale : style.value.scale,
      opacity: Number.isFinite(command.style.opacity) ? command.style.opacity : style.value.opacity,
      closeOnClickOutside: command.style.closeOnClickOutside !== false,
    };
  }
  switch (command.action) {
    case "show":
      upsert(command);
      break;
    case "update": {
      if (!command.panelId) break;
      const panel = panels.value.find((entry) => entry.id === command.panelId);
      if (panel && command.payload !== undefined) panel.payload = command.payload;
      break;
    }
    case "hide":
      remove(command.panelId ? [command.panelId] : []);
      break;
    case "hide-all":
      remove(panels.value.filter((panel) => command.pinned === true || !panel.pinned).map((panel) => panel.id));
      break;
    default:
      break;
  }
  if (panels.value.length === 0) resetHover();
}

/** The user closed a panel (×, Escape, click outside, the panel itself). */
function closeByUser(id: string): void {
  if (!panels.value.some((panel) => panel.id === id)) return;
  remove([id]);
  send({ panelId: id, kind: "closed-by-user" });
  if (panels.value.length === 0) resetHover();
}

function togglePin(id: string): void {
  const panel = panels.value.find((entry) => entry.id === id);
  if (panel) panel.pinned = !panel.pinned;
}

function move(id: string, position: { x: number; y: number }): void {
  const panel = panels.value.find((entry) => entry.id === id);
  if (panel) panel.position = position;
}

function raise(id: string): void {
  const panel = panels.value.find((entry) => entry.id === id);
  if (panel && panel.z !== nextZ - 1) panel.z = nextZ++;
}

function onPointerEnter(id: string): void {
  hovered += 1;
  if (hovered === 1) setIgnoreMouse(false);
  send({ panelId: id, kind: "pointer-enter" });
}

function onPointerLeave(id: string): void {
  hovered = Math.max(0, hovered - 1);
  if (hovered === 0) setIgnoreMouse(true);
  send({ panelId: id, kind: "pointer-leave" });
}

function resetHover(): void {
  if (hovered > 0) setIgnoreMouse(true);
  hovered = 0;
}

/** Escape closes the topmost unpinned panel; with none left, main hides the window. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const topmost = [...panels.value].filter((panel) => !panel.pinned).sort((a, b) => b.z - a.z)[0];
  if (topmost) {
    event.preventDefault();
    closeByUser(topmost.id);
    return;
  }
  void api?.invoke("overlay:hide-all").catch(() => {});
}

onMounted(() => {
  stopPanelEvents = api?.on("overlay:panel", handleCommand);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  stopPanelEvents?.();
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="overlay-root" :style="cssVars" data-testid="overlay-root">
    <p v-if="!api" class="overlay-panel overlay-panel-missing" style="left: 24px; top: 24px; padding: 0.8rem">
      The overlay runs inside the desktop app: open it there and press a panel hotkey.
    </p>
    <PanelHost
      v-for="panel in panels"
      :key="panel.id"
      :panel="panel"
      :scale="style.scale"
      @close="closeByUser(panel.id)"
      @toggle-pin="togglePin(panel.id)"
      @move="move(panel.id, $event)"
      @raise="raise(panel.id)"
      @pointer-enter="onPointerEnter(panel.id)"
      @pointer-leave="onPointerLeave(panel.id)"
    />
  </div>
</template>
