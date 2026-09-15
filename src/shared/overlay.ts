/**
 * Overlay window contract (package "overlay", brief D2).
 *
 * Main owns one transparent always-on-top window that loads the renderer at
 * `#/overlay`; features ask it to show panels and the renderer reports what
 * the user does with them. Everything here is pure (no Electron, no DOM) so
 * both processes and the tests share one source of truth for the payload
 * shapes, the settings sanitizer and the panel-placement maths.
 */
import type { FeatureCall } from "./features.js";

export type OverlayAnchor =
  | "cursor"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "left"
  | "right"
  | "center"
  | { x: number; y: number };

export interface OverlayShowOptions {
  /** Default "cursor". */
  anchor?: OverlayAnchor;
  /** Panel props. */
  payload?: unknown;
  /** Survives "hide all"/Escape until explicitly hidden. */
  pinned?: boolean;
  /** The panel needs keyboard input (search fields): the window becomes focusable. */
  focus?: boolean;
  /** CSS px hints; the panel may resize itself. */
  width?: number;
  height?: number;
}

export interface OverlayPanelEvent {
  panelId: string;
  kind: "shown" | "hidden" | "closed-by-user" | "pointer-enter" | "pointer-leave" | "resized";
  size?: { width: number; height: number };
}

/**
 * Presentation values main attaches to every command so a settings change
 * applies live without a reload: the renderer turns scale/opacity into CSS
 * variables and derives click-outside capture from `closeOnClickOutside`.
 */
export interface OverlayStyle {
  scale: number;
  opacity: number;
  closeOnClickOutside: boolean;
}

/** main → renderer event "overlay:panel". */
export interface OverlayPanelCommand {
  action: "show" | "update" | "hide" | "hide-all";
  panelId?: string;
  payload?: unknown;
  anchor?: OverlayAnchor;
  /** Resolved, in overlay-window CSS px. */
  position?: { x: number; y: number };
  pinned?: boolean;
  focus?: boolean;
  /** Extra: current presentation settings (see OverlayStyle). */
  style?: OverlayStyle;
  /** Extra: size hints from the show options, so the renderer can clamp drags. */
  size?: { width: number; height: number };
}

export interface OverlayState {
  windowVisible: boolean;
  visiblePanels: string[];
  pinnedPanels: string[];
  pointerOverPanel: boolean;
  display?: {
    id: number;
    bounds: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  };
  poeDetected: boolean;
}

export interface OverlaySettings {
  /** 0.6–2, default 1. */
  scale: number;
  /** 0.4–1, default 0.96. */
  opacity: number;
  primaryMonitorOnly: boolean;
  /** restricted = keep panels inside a 16:9 box centred on the display. */
  ultrawideMode: "restricted" | "unrestricted";
  closeOnClickOutside: boolean;
  /** Default true. */
  showOnlyWhilePoeRuns: boolean;
}

export interface OverlayContract {
  "overlay:state": FeatureCall<[], OverlayState>;
  /** renderer → main */
  "overlay:panel-event": FeatureCall<[event: OverlayPanelEvent], void>;
  /** The desktop UI can open panels too. */
  "overlay:show": FeatureCall<[panelId: string, options?: OverlayShowOptions], void>;
  "overlay:hide": FeatureCall<[panelId: string], void>;
  /** Hides every non-pinned panel; `includePinned` (default false) hides those too. */
  "overlay:hide-all": FeatureCall<[includePinned?: boolean], void>;
  /**
   * renderer → main: a panel takes keyboard focus (a search/whisper field got
   * focus) or gives it back without being re-shown. Releasing focus returns
   * the window to non-focusable and hands focus back to the game; it does not
   * count as a click outside, so the panel stays open.
   */
  "overlay:set-focus": FeatureCall<[panelId: string, focus: boolean], void>;
  /** renderer → main while the pointer is over / leaves a panel. */
  "overlay:set-ignore-mouse": FeatureCall<[ignore: boolean], void>;
}

export interface OverlayEvents {
  "overlay:panel": OverlayPanelCommand;
  "overlay:state-changed": OverlayState;
}

/** Payload of the built-in "notice" panel (a toast any feature can show). */
export interface NoticePayload {
  title: string;
  body: string;
  tone?: "info" | "ok" | "warning" | "danger";
  /** Auto-close after this many ms; omitted = stays until closed. */
  ttlMs?: number;
}

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  scale: 1,
  opacity: 0.96,
  primaryMonitorOnly: false,
  ultrawideMode: "unrestricted",
  closeOnClickOutside: true,
  showOnlyWhilePoeRuns: true,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Settings namespace "overlay": anything read from disk goes through here so
 * a hand-edited file can never produce an invisible (opacity 0) or
 * off-screen overlay.
 */
export function normalizeOverlaySettings(raw: unknown): OverlaySettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof OverlaySettings, unknown>
  >;
  return {
    scale: clampNumber(source.scale, 0.6, 2, DEFAULT_OVERLAY_SETTINGS.scale),
    opacity: clampNumber(source.opacity, 0.4, 1, DEFAULT_OVERLAY_SETTINGS.opacity),
    primaryMonitorOnly: source.primaryMonitorOnly === true,
    ultrawideMode: source.ultrawideMode === "restricted" ? "restricted" : "unrestricted",
    closeOnClickOutside: source.closeOnClickOutside !== false,
    showOnlyWhilePoeRuns: source.showOnlyWhilePoeRuns !== false,
  };
}

export interface PanelPlacementInput {
  anchor: OverlayAnchor;
  /** The overlay window's size in CSS px (= the display's DIP size). */
  window: { width: number; height: number };
  /** Cursor point relative to the window origin, CSS px. */
  cursor: { x: number; y: number };
  /** Size hints; unknown sizes fall back to a small default so clamping still works. */
  size?: { width?: number; height?: number };
  ultrawideMode?: OverlaySettings["ultrawideMode"];
  /** Gap from edges/cursor, CSS px. */
  margin?: number;
}

export const DEFAULT_PANEL_SIZE = { width: 360, height: 240 } as const;

/** The usable box: the whole window, or a centred 16:9 box on ultrawide displays. */
export function overlayUsableBox(
  window: { width: number; height: number },
  ultrawideMode: OverlaySettings["ultrawideMode"] = "unrestricted",
): { x: number; y: number; width: number; height: number } {
  if (ultrawideMode !== "restricted") return { x: 0, y: 0, width: window.width, height: window.height };
  const width = Math.min(window.width, Math.round((window.height * 16) / 9));
  return { x: Math.round((window.width - width) / 2), y: 0, width, height: window.height };
}

/**
 * Resolves an anchor to a top-left position in overlay-window CSS px. The
 * cursor anchor opens the panel just below-right of the pointer (like a
 * tooltip) and flips to the other side when it would leave the box; every
 * anchor is clamped so the panel stays fully on screen.
 */
export function resolvePanelPosition(input: PanelPlacementInput): { x: number; y: number } {
  const margin = input.margin ?? 12;
  const width = Math.max(1, input.size?.width ?? DEFAULT_PANEL_SIZE.width);
  const height = Math.max(1, input.size?.height ?? DEFAULT_PANEL_SIZE.height);
  const box = overlayUsableBox(input.window, input.ultrawideMode);
  const minX = box.x + margin;
  const minY = box.y + margin;
  const maxX = Math.max(minX, box.x + box.width - width - margin);
  const maxY = Math.max(minY, box.y + box.height - height - margin);
  const clamp = (x: number, y: number) => ({
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(maxY, Math.max(minY, y))),
  });
  const anchor = input.anchor;
  if (typeof anchor === "object") return clamp(anchor.x, anchor.y);
  switch (anchor) {
    case "top-left":
      return clamp(minX, minY);
    case "top-right":
      return clamp(maxX, minY);
    case "bottom-left":
      return clamp(minX, maxY);
    case "bottom-right":
      return clamp(maxX, maxY);
    case "left":
      return clamp(minX, box.y + (box.height - height) / 2);
    case "right":
      return clamp(maxX, box.y + (box.height - height) / 2);
    case "center":
      return clamp(box.x + (box.width - width) / 2, box.y + (box.height - height) / 2);
    case "cursor":
    default: {
      let x = input.cursor.x + margin;
      let y = input.cursor.y + margin;
      if (x + width > box.x + box.width - margin) x = input.cursor.x - width - margin;
      if (y + height > box.y + box.height - margin) y = input.cursor.y - height - margin;
      return clamp(x, y);
    }
  }
}
