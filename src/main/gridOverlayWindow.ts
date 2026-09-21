import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JuiceGridOverlayPlan } from "../core/gridLattice.js";

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; overflow: hidden; background: transparent; user-select: none; }
    svg { width: 100vw; height: 100vh; display: block; }
    .maps { stroke: #ff6b8a; fill: rgba(255, 107, 138, 0.06); }
    .bag { stroke: #f5c14a; fill: rgba(245, 193, 74, 0.06); }
    .grid-line { fill: none; stroke-opacity: 0.85; }
    .label { font: 700 14px "Segoe UI", sans-serif; }
    .maps-label { fill: #ff6b8a; }
    .bag-label { fill: #f5c14a; }
    .dot { stroke-width: 1.5; }
    .maps-dot { fill: #ff6b8a; stroke: #1a0408; }
    .bag-dot { fill: #f5c14a; stroke: #1a1400; }
    #hud {
      position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
      padding: 10px 14px; background: rgba(8, 10, 14, 0.86);
      border: 1px solid #ffe14a; border-radius: 8px;
      font: 600 13px "Segoe UI", sans-serif; color: #f8f4ea; pointer-events: none;
    }
    #hud .title { color: #ffe14a; margin-bottom: 4px; }
    #hud .muted { color: #c6c0b4; font-weight: 500; }
  </style>
</head>
<body>
  <svg id="overlay" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="hud">
    <div class="title">Juice grid overlay — no game input</div>
    <div class="muted">Pink = Maps 12×8 wells · gold = bag. Ctrl+Alt+G toggles this overlay off and on.</div>
  </div>
  <script>
    const COLORS = { maps: "#ff6b8a", bag: "#f5c14a" };
    function el(name, attrs, text) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      if (text != null) node.textContent = text;
      return node;
    }
    window.renderJuiceGridOverlay = function (plan) {
      const svg = document.getElementById("overlay");
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!plan) return;
      svg.setAttribute("viewBox", "0 0 " + plan.client.width + " " + plan.client.height);
      for (const grid of plan.grids || []) {
        const g = el("g", { class: grid.region });
        g.appendChild(el("rect", { x: grid.x, y: grid.y, width: grid.w, height: grid.h, "stroke-width": 3 }));
        const cols = Number(grid.cols) || 0;
        const rows = Number(grid.rows) || 0;
        for (let col = 1; col < cols; col += 1) {
          const x = grid.x + (grid.w * col) / cols;
          g.appendChild(el("line", {
            class: "grid-line", x1: x, y1: grid.y, x2: x, y2: grid.y + grid.h,
            stroke: COLORS[grid.region], "stroke-width": 1
          }));
        }
        for (let row = 1; row < rows; row += 1) {
          const y = grid.y + (grid.h * row) / rows;
          g.appendChild(el("line", {
            class: "grid-line", x1: grid.x, y1: y, x2: grid.x + grid.w, y2: y,
            stroke: COLORS[grid.region], "stroke-width": 1
          }));
        }
        g.appendChild(el("text", {
          class: "label " + grid.region + "-label",
          x: grid.x + 8,
          y: Math.max(18, grid.y - 8)
        }, grid.label));
        svg.appendChild(g);
      }
      for (const click of plan.clicks || []) {
        svg.appendChild(el("circle", {
          class: "dot " + click.region + "-dot",
          cx: click.x, cy: click.y, r: 4
        }));
      }
    };
  </script>
</body>
</html>`;

function dipRect(x: number, y: number, width: number, height: number): Electron.Rectangle {
  try {
    return screen.screenToDipRect(null, { x, y, width, height });
  } catch {
    return { x, y, width, height };
  }
}

function dipPoint(x: number, y: number): { x: number; y: number } {
  try {
    return screen.screenToDipPoint({ x, y });
  } catch {
    return { x, y };
  }
}

function planForOverlayWindow(plan: JuiceGridOverlayPlan): { bounds: Electron.Rectangle; plan: JuiceGridOverlayPlan } {
  const bounds = dipRect(plan.client.left, plan.client.top, plan.client.width, plan.client.height);
  return {
    bounds,
    plan: {
      client: { left: 0, top: 0, width: bounds.width, height: bounds.height },
      grids: plan.grids.map((grid) => {
        const box = dipRect(grid.x, grid.y, grid.w, grid.h);
        return { ...grid, x: box.x - bounds.x, y: box.y - bounds.y, w: box.width, h: box.height };
      }),
      clicks: plan.clicks.map((click) => {
        const point = dipPoint(click.x, click.y);
        return { ...click, x: point.x - bounds.x, y: point.y - bounds.y };
      }),
    },
  };
}

function preloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs");
}

/** Click-through lattice over the PoE client. Preview only — never emits game input. */
export class GridOverlayWindow {
  private win?: BrowserWindow;
  private ready = Promise.resolve();
  private generation = 0;

  show(plan: JuiceGridOverlayPlan): void {
    const token = ++this.generation;
    const { bounds, plan: local } = planForOverlayWindow(plan);
    const win = this.ensureWindow();
    win.setBounds(bounds);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.setAlwaysOnTop(true, "screen-saver");
    this.ready = this.ready.then(async () => {
      if (token !== this.generation || win.isDestroyed()) return;
      if (win.webContents.isLoading()) {
        await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      }
      if (token !== this.generation || win.isDestroyed()) return;
      await win.webContents.executeJavaScript(`window.renderJuiceGridOverlay(${JSON.stringify(local)})`);
      if (token !== this.generation || win.isDestroyed()) return;
      win.showInactive();
    });
  }

  hide(): void {
    this.generation += 1;
    if (!this.win || this.win.isDestroyed()) return;
    void this.win.webContents.executeJavaScript("window.renderJuiceGridOverlay(null)").catch(() => {});
    this.win.hide();
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  dispose(): void {
    this.generation += 1;
    if (!this.win || this.win.isDestroyed()) {
      this.win = undefined;
      return;
    }
    this.win.destroy();
    this.win = undefined;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
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
        preload: preloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setMenuBarVisibility(false);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
    this.win = win;
    return win;
  }
}
