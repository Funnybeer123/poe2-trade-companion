/**
 * The click-through price label layer.
 *
 * A package-owned transparent window aligned to the PoE client that draws
 * one rounded rectangle + price per item footprint. It is the dry-run
 * overlay's proven construction (src/main/dryRunOverlayWindow.ts) minus the
 * HUD, the preload and the clicks:
 *
 *   - `setIgnoreMouseEvents(true, { forward: true })` from construction, so
 *     every click over the stash reaches the game;
 *   - `focusable: false` and `showInactive()` only, so the game never loses
 *     focus to it;
 *   - no preload and `sandbox: true`, so the page cannot reach any bridge.
 *
 * Electron is imported lazily (`electronLabelWindowFactory`) so this module
 * stays importable under plain Node and the tests drive a fake window.
 */
import type { PriceOverlayPlan } from "../../../core/stashTrackerOverlay.js";
import { overlayPlanToClientSpace } from "../../../core/dryRunOverlay.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of BrowserWindow the layer drives (fakeable). */
export interface LabelWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  setBounds(rect: Rect): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  once(event: "closed", callback: () => void): unknown;
  webContents: {
    isLoading(): boolean;
    once(event: "did-finish-load", callback: () => void): unknown;
    executeJavaScript(code: string): Promise<unknown>;
  };
}

export interface LabelScreenLike {
  screenToDipRect(window: null, rect: Rect): Rect;
}

export interface LabelWindowPort {
  show(plan: PriceOverlayPlan): void;
  hide(): void;
  isVisible(): boolean;
  dispose(): void;
}

export interface PriceLabelWindowOptions {
  createWindow(): LabelWindowLike;
  screen: LabelScreenLike;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

/**
 * The page. Pure SVG over a transparent body; `window.renderPriceLabels`
 * replaces everything on each show and clears on `null`. No bridge, no
 * network, no event handlers — nothing here can be clicked.
 */
export const LABEL_WINDOW_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; overflow: hidden; background: transparent; user-select: none; }
    svg { width: 100vw; height: 100vh; display: block; pointer-events: none; }
    .grid-outline { fill: none; stroke: rgba(200, 166, 106, 0.35); stroke-width: 2; }
    .grid-caption { font: 700 14px "Segoe UI", sans-serif; fill: #e4c587; }
    .slot { stroke-width: 2; rx: 4; ry: 4; }
    .tone-table { stroke: #e0c46a; fill: rgba(224, 196, 106, 0.08); }
    .tone-estimate { stroke: #79afc7; fill: rgba(121, 175, 199, 0.08); }
    .tone-unknown { stroke: rgba(180, 180, 190, 0.6); fill: rgba(180, 180, 190, 0.08); }
    .price {
      font-family: "Cascadia Code", Consolas, monospace;
      font-weight: 700;
      fill: #ffffff;
      text-anchor: middle;
      dominant-baseline: central;
      paint-order: stroke;
      stroke: rgba(6, 8, 11, 0.92);
      stroke-width: 3;
      stroke-linejoin: round;
    }
  </style>
</head>
<body>
  <svg id="labels" xmlns="http://www.w3.org/2000/svg"></svg>
  <script>
    function el(name, attrs, text) {
      var node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (var key in attrs || {}) node.setAttribute(key, String(attrs[key]));
      if (text != null) node.textContent = text;
      return node;
    }
    window.renderPriceLabels = function (plan) {
      var svg = document.getElementById("labels");
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!plan) return;
      svg.setAttribute("viewBox", "0 0 " + plan.client.width + " " + plan.client.height);
      var grids = plan.grids || [];
      for (var g = 0; g < grids.length; g += 1) {
        var grid = grids[g];
        svg.appendChild(el("rect", {
          class: "grid-outline", x: grid.x, y: grid.y, width: grid.w, height: grid.h
        }));
        svg.appendChild(el("text", {
          class: "grid-caption", x: grid.x + 6, y: Math.max(18, grid.y - 10)
        }, grid.label));
      }
      var items = plan.items || [];
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        svg.appendChild(el("rect", {
          class: "slot tone-" + item.tone,
          x: item.x + 1, y: item.y + 1,
          width: Math.max(1, item.width - 2), height: Math.max(1, item.height - 2),
          opacity: item.opacity
        }));
        svg.appendChild(el("text", {
          class: "price",
          x: item.x + item.width / 2,
          y: item.y + item.height / 2,
          "font-size": item.fontPx,
          opacity: item.opacity
        }, item.label));
      }
    };
  </script>
</body>
</html>`;

function scaleItems(plan: PriceOverlayPlan, factor: number): PriceOverlayPlan["items"] {
  if (factor === 1) return plan.items;
  return plan.items.map((item) => ({
    ...item,
    fontPx: Math.max(8, Math.round(item.fontPx * factor)),
  }));
}

/**
 * Screen px → the window's DIP space, the same algorithm the dry-run
 * overlay uses. At 100 % scale the rects only shift by the client origin;
 * at 150 % every rect is converted and the label font shrinks with it.
 */
export function planForLabelWindow(
  plan: PriceOverlayPlan,
  screen: LabelScreenLike,
): { bounds: Rect; plan: PriceOverlayPlan } {
  const toDip = (x: number, y: number, width: number, height: number): Rect => {
    try {
      return screen.screenToDipRect(null, { x, y, width, height });
    } catch {
      return { x, y, width, height };
    }
  };
  const bounds = toDip(plan.client.left, plan.client.top, plan.client.width, plan.client.height);
  // Width is part of the test: a client at 0,0 on a scaled display reports
  // the same origin but a smaller DIP size, and shifting alone would leave
  // every label at physical-pixel coordinates.
  if (
    bounds.x === plan.client.left &&
    bounds.y === plan.client.top &&
    bounds.width === plan.client.width
  ) {
    return { bounds, plan: overlayPlanToClientSpace(plan) as PriceOverlayPlan };
  }
  const factor = plan.client.width > 0 ? bounds.width / plan.client.width : 1;
  const items = scaleItems(plan, factor).map((item) => {
    const box = toDip(item.x, item.y, item.width, item.height);
    return {
      ...item,
      x: box.x - bounds.x,
      y: box.y - bounds.y,
      width: box.width,
      height: box.height,
    };
  });
  return {
    bounds,
    plan: {
      ...plan,
      client: { left: 0, top: 0, width: bounds.width, height: bounds.height },
      grids: plan.grids.map((grid) => {
        const box = toDip(grid.x, grid.y, grid.w, grid.h);
        return { ...grid, x: box.x - bounds.x, y: box.y - bounds.y, w: box.width, h: box.height };
      }),
      items,
      detectedItems: items,
    },
  };
}

export class PriceLabelWindow implements LabelWindowPort {
  private win: LabelWindowLike | undefined;
  private ready: Promise<void> = Promise.resolve();
  private generation = 0;
  private visible = false;
  private disposed = false;

  constructor(private readonly options: PriceLabelWindowOptions) {}

  show(plan: PriceOverlayPlan): void {
    // A show queued before shutdown must not resurrect the layer: a new
    // BrowserWindow built here would never be destroyed, and building one
    // after app teardown throws.
    if (this.disposed) return;
    const token = ++this.generation;
    const { bounds, plan: local } = planForLabelWindow(plan, this.options.screen);
    const win = this.ensureWindow();
    win.setBounds(bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    // Re-assert on every show: a window that lost click-through would eat
    // clicks meant for the stash.
    win.setIgnoreMouseEvents(true, { forward: true });
    this.visible = true;
    this.ready = this.ready.then(async () => {
      if (token !== this.generation || win.isDestroyed()) return;
      if (win.webContents.isLoading()) {
        await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      }
      if (token !== this.generation || win.isDestroyed()) return;
      try {
        await win.webContents.executeJavaScript(
          `window.renderPriceLabels(${JSON.stringify(local)})`,
        );
      } catch (error) {
        this.options.log?.("warn", "price label render failed", error);
        return;
      }
      if (token !== this.generation || win.isDestroyed()) return;
      win.showInactive();
    });
  }

  hide(): void {
    this.generation += 1;
    this.visible = false;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    void Promise.resolve(win.webContents.executeJavaScript("window.renderPriceLabels(null)")).catch(
      () => {
        // The page may already be gone; hiding is what matters.
      },
    );
    win.hide();
  }

  isVisible(): boolean {
    const win = this.win;
    if (!win || win.isDestroyed()) return false;
    try {
      return this.visible && win.isVisible();
    } catch {
      return this.visible;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.visible = false;
    const win = this.win;
    this.win = undefined;
    if (!win || win.isDestroyed()) return;
    win.destroy();
  }

  private ensureWindow(): LabelWindowLike {
    const existing = this.win;
    if (existing && !existing.isDestroyed()) return existing;
    const win = this.options.createWindow();
    win.setIgnoreMouseEvents(true, { forward: true });
    try {
      win.once("closed", () => {
        this.win = undefined;
        this.visible = false;
      });
    } catch {
      // Fakes in tests may not be event emitters.
    }
    this.win = win;
    return win;
  }
}

/** Lazily built so importing this module never pulls Electron in. */
export async function electronLabelWindowFactory(): Promise<() => LabelWindowLike> {
  const { BrowserWindow } = await import("electron");
  return () => {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setMenuBarVisibility(false);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LABEL_WINDOW_HTML)}`);
    return win as unknown as LabelWindowLike;
  };
}
