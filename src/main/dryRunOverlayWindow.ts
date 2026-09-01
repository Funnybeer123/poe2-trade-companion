import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  overlayCellAtPoint,
  overlayPlanToClientSpace,
  type DryRunOverlayPlan,
  type OverlayCellRef,
  type OverlayOccupiedCell,
} from "../core/dryRunOverlay.js";

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      overflow: hidden;
      background: transparent;
      user-select: none;
      font: 600 13px "Segoe UI", sans-serif;
      color: #f8f4ea;
    }
    svg { width: 100vw; height: 100vh; display: block; }
    .stash { stroke: #22d3ee; fill: rgba(34, 211, 238, 0.08); }
    .bag { stroke: #f59e0b; fill: rgba(245, 158, 11, 0.08); }
    .search { stroke: #4ade80; fill: rgba(74, 222, 128, 0.16); }
    .grid-line { fill: none; stroke-opacity: 0.4; }
    .item-label { font: 700 12px "Segoe UI", sans-serif; fill: #f8f4ea; pointer-events: none; }
    .selected { fill: rgba(232, 121, 249, 0.28); stroke: #f0abfc; stroke-width: 4; }
    .click-ring { fill: #ffe14a; stroke: #1a1400; stroke-width: 2; }
    .click-text { fill: #1a1400; font: 700 12px "Segoe UI", sans-serif; text-anchor: middle; dominant-baseline: central; }
    .label { font: 700 13px "Segoe UI", sans-serif; }
    .stash-label { fill: #22d3ee; }
    .bag-label { fill: #f59e0b; }
    .search-label { fill: #4ade80; }
    #hud {
      position: fixed;
      left: 50%;
      top: 16px;
      transform: translateX(-50%);
      width: 470px;
      padding: 12px 14px;
      background: rgba(8, 10, 14, 0.86);
      border: 1px solid #ffe14a;
      border-radius: 8px;
      z-index: 2;
      pointer-events: auto;
    }
    #hud .title { color: #ffe14a; margin-bottom: 6px; }
    #hud .muted { color: #c6c0b4; font-weight: 500; }
    #hud .selection { margin: 8px 0; }
    #hud .btns { display: flex; gap: 8px; margin: 8px 0; }
    #hud button {
      flex: 1;
      border: 0;
      border-radius: 6px;
      padding: 8px 10px;
      font: 700 13px "Segoe UI", sans-serif;
      cursor: pointer;
    }
    #hud button:disabled { opacity: 0.45; cursor: default; }
    #right { background: #16a34a; color: #052e16; }
    #wrong { background: #dc2626; color: #fff7ed; }
    #fix-cursor { background: #2563eb; color: #eff6ff; }
    #cursor-status { min-height: 1.2em; }
  </style>
</head>
<body>
  <svg id="overlay" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="hud">
    <div class="title">Dry-run overlay — no game input</div>
    <div class="muted">Each outline is one detected item · yellow numbers = planned clicks</div>
    <div id="selection" class="selection">Click a stash or bag item to label occupancy. Shift-click adds more.</div>
    <div class="btns">
      <button id="right" type="button" disabled>Right — detection is correct</button>
      <button id="wrong" type="button" disabled>Wrong — detection is incorrect</button>
    </div>
    <div class="btns">
      <button id="fix-cursor" type="button" disabled>Fix in Cursor</button>
    </div>
    <div id="cursor-status" class="muted"></div>
    <div class="muted">You are labeling the detection, not the click plan. Overlay captures clicks until Stop or Dry-run is unchecked.</div>
  </div>
  <script>
    const COLORS = { stash: "#22d3ee", bag: "#f59e0b", search: "#4ade80" };
    const ITEM_COLORS = ["#22d3ee", "#38bdf8", "#818cf8", "#c084fc", "#f472b6", "#fb7185", "#fbbf24", "#34d399"];
    let currentPlan = null;
    function el(name, attrs, text) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      if (text != null) node.textContent = text;
      return node;
    }
    function cellRect(grid, row, col) {
      const cols = Number(grid.cols) || 1;
      const rows = Number(grid.rows) || 1;
      const w = grid.w / cols;
      const h = grid.h / rows;
      return { x: grid.x + col * w, y: grid.y + row * h, w: w, h: h };
    }
    function drawGrid(svg, grid) {
      const g = el("g", { class: grid.region });
      g.appendChild(el("rect", {
        x: grid.x, y: grid.y, width: grid.w, height: grid.h,
        "stroke-width": 3
      }));
      const cols = Number(grid.cols) || 0;
      const rows = Number(grid.rows) || 0;
      if (cols > 1 && rows > 1) {
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
      }
      g.appendChild(el("text", {
        class: "label " + grid.region + "-label",
        x: grid.x + 8,
        y: Math.max(16, grid.y - 8)
      }, grid.label));
      svg.appendChild(g);
    }
    function selectedCells(plan) {
      if (!plan || !plan.selected) return [];
      return Array.isArray(plan.selected) ? plan.selected : [plan.selected];
    }
    function cellKey(cell) {
      return (cell.area || "") + ":" + cell.row + "," + cell.col;
    }
    function drawItem(svg, item, index) {
      const color = ITEM_COLORS[index % ITEM_COLORS.length];
      svg.appendChild(el("rect", {
        class: "item-footprint",
        x: item.x, y: item.y, width: item.width, height: item.height,
        fill: color, "fill-opacity": "0.36", stroke: color, "stroke-width": 3
      }));
      const label = (index + 1) + " " + item.w + "×" + item.h + (item.itemClass ? " " + item.itemClass : "");
      svg.appendChild(el("text", {
        class: "item-label",
        x: item.x + 6,
        y: item.y + 14
      }, label));
    }
    function drawSelected(svg, plan) {
      const cells = selectedCells(plan);
      if (!cells.length) return;
      const covered = new Set();
      for (const item of plan.items || []) {
        const itemCells = item.cells || [];
        if (!itemCells.length) continue;
        const allSelected = itemCells.every(function (entry) {
          return cells.some(function (cell) {
            return cell.area === item.area && cell.row === entry.row && cell.col === entry.col;
          });
        });
        if (!allSelected) continue;
        svg.appendChild(el("rect", {
          class: "selected",
          x: item.x, y: item.y, width: item.width, height: item.height
        }));
        for (const entry of itemCells) covered.add(item.area + ":" + entry.row + "," + entry.col);
      }
      for (const cell of cells) {
        if (covered.has(cellKey(cell))) continue;
        const grid = (plan.grids || []).find(function (entry) { return entry.region === cell.area; });
        if (!grid) continue;
        const box = cellRect(grid, cell.row, cell.col);
        svg.appendChild(el("rect", {
          class: "selected",
          x: box.x, y: box.y, width: box.w, height: box.h
        }));
      }
    }
    function drawClick(svg, click) {
      const g = el("g", {});
      if (click.kind === "drag-to") {
        g.appendChild(el("rect", {
          class: "click-ring",
          x: click.x - 9, y: click.y - 9, width: 18, height: 18
        }));
      } else {
        g.appendChild(el("circle", {
          class: "click-ring",
          cx: click.x, cy: click.y, r: 11
        }));
      }
      g.appendChild(el("text", {
        class: "click-text",
        x: click.x, y: click.y
      }, String(click.n)));
      svg.appendChild(g);
    }
    function updateHud(plan) {
      const selection = document.getElementById("selection");
      const right = document.getElementById("right");
      const wrong = document.getElementById("wrong");
      const fix = document.getElementById("fix-cursor");
      const cells = selectedCells(plan);
      right.disabled = cells.length === 0;
      wrong.disabled = cells.length === 0;
      if (fix) fix.disabled = !plan;
      if (!plan || cells.length === 0) {
        selection.textContent = "Click a stash or bag item to label occupancy. Shift-click adds more.";
        return;
      }
      if (cells.length === 1) {
        const selected = cells[0];
        selection.textContent =
          "Selected " + selected.area + " r" + selected.row + " c" + selected.col +
          " · perceived " + (selected.occupied ? "OCCUPIED (item detected)" : "EMPTY (no item detected)");
        return;
      }
      const areas = {};
      for (const cell of cells) areas[cell.area] = true;
      const mix = areas.stash && areas.bag ? " (stash + bag)" : "";
      selection.textContent = cells.length + " cells selected" + mix + " · Wrong will invert all";
    }
    window.renderDryRunOverlay = function (plan) {
      currentPlan = plan || null;
      const svg = document.getElementById("overlay");
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      updateHud(currentPlan);
      if (!plan) return;
      svg.setAttribute("viewBox", "0 0 " + plan.client.width + " " + plan.client.height);
      for (const grid of plan.grids || []) drawGrid(svg, grid);
      (plan.items || []).forEach(function (item, index) { drawItem(svg, item, index); });
      drawSelected(svg, plan);
      for (const click of plan.clicks || []) drawClick(svg, click);
    };
    function overlayApi() {
      return window.poe2 && window.poe2.assistive;
    }
    document.getElementById("overlay").addEventListener("click", function (event) {
      if (!currentPlan) return;
      const svg = event.currentTarget;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) * (currentPlan.client.width / rect.width);
      const y = (event.clientY - rect.top) * (currentPlan.client.height / rect.height);
      const api = overlayApi();
      if (api && api.selectOverlayCell) api.selectOverlayCell(x, y, Boolean(event.shiftKey));
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      const api = overlayApi();
      if (api && api.selectOverlayCell) api.selectOverlayCell(-1, -1, false);
    });
    document.getElementById("right").addEventListener("click", function (event) {
      event.stopPropagation();
      const api = overlayApi();
      if (api && api.labelOverlayCell) api.labelOverlayCell("right");
    });
    document.getElementById("wrong").addEventListener("click", function (event) {
      event.stopPropagation();
      const api = overlayApi();
      if (api && api.labelOverlayCell) api.labelOverlayCell("wrong");
    });
    document.getElementById("fix-cursor").addEventListener("click", function (event) {
      event.stopPropagation();
      const api = overlayApi();
      const status = document.getElementById("cursor-status");
      if (!api || !api.sendToCursor) {
        if (status) status.textContent = "Fix in Cursor needs the Electron app.";
        return;
      }
      if (status) status.textContent = "Packaging logs…";
      Promise.resolve(api.sendToCursor()).then(function (result) {
        if (status) status.textContent = result && result.message ? result.message : "Sent.";
      }).catch(function (err) {
        if (status) status.textContent = String(err && err.message ? err.message : err);
      });
    });
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

function shiftOccupied(cell: OverlayOccupiedCell, box: Electron.Rectangle, bounds: Electron.Rectangle): OverlayOccupiedCell {
  return {
    ...cell,
    x: box.x - bounds.x,
    y: box.y - bounds.y,
    w: box.width,
    h: box.height,
  };
}

function shiftItem<T extends { x: number; y: number; width: number; height: number }>(
  item: T,
  box: Electron.Rectangle,
  bounds: Electron.Rectangle,
): T {
  return {
    ...item,
    x: box.x - bounds.x,
    y: box.y - bounds.y,
    width: box.width,
    height: box.height,
  };
}

function planForOverlayWindow(plan: DryRunOverlayPlan): {
  bounds: Electron.Rectangle;
  plan: DryRunOverlayPlan;
} {
  const bounds = dipRect(plan.client.left, plan.client.top, plan.client.width, plan.client.height);
  if (bounds.x === plan.client.left && bounds.y === plan.client.top) {
    return { bounds, plan: overlayPlanToClientSpace(plan) };
  }
  return {
    bounds,
    plan: {
      ...plan,
      client: { left: 0, top: 0, width: bounds.width, height: bounds.height },
      grids: plan.grids.map((grid) => {
        const box = dipRect(grid.x, grid.y, grid.w, grid.h);
        return { ...grid, x: box.x - bounds.x, y: box.y - bounds.y, w: box.width, h: box.height };
      }),
      clicks: plan.clicks.map((click) => {
        const point = dipPoint(click.x, click.y);
        return { ...click, x: point.x - bounds.x, y: point.y - bounds.y };
      }),
      occupied: plan.occupied.map((cell) =>
        shiftOccupied(cell, dipRect(cell.x, cell.y, cell.w, cell.h), bounds),
      ),
      detected: plan.detected.map((cell) =>
        shiftOccupied(cell, dipRect(cell.x, cell.y, cell.w, cell.h), bounds),
      ),
      items: (plan.items ?? []).map((item) =>
        shiftItem(item, dipRect(item.x, item.y, item.width, item.height), bounds),
      ),
      detectedItems: (plan.detectedItems ?? []).map((item) =>
        shiftItem(item, dipRect(item.x, item.y, item.width, item.height), bounds),
      ),
    },
  };
}

function preloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs");
}

/**
 * Always-on-top overlay aligned to the PoE client.
 * Preview only: never emits game input. While visible it captures clicks so
 * the operator can select item footprints and label occupancy detection.
 */
export class DryRunOverlayWindow {
  private win?: BrowserWindow;
  private ready = Promise.resolve();
  private generation = 0;
  private localPlan: DryRunOverlayPlan | null = null;

  cellAtLocalPoint(x: number, y: number): OverlayCellRef | undefined {
    if (!this.localPlan) return undefined;
    return overlayCellAtPoint(this.localPlan, x, y);
  }

  show(plan: DryRunOverlayPlan): void {
    const token = ++this.generation;
    const { bounds, plan: local } = planForOverlayWindow(plan);
    this.localPlan = local;
    const win = this.ensureWindow();
    win.setBounds(bounds);
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    win.setAlwaysOnTop(true, "screen-saver");
    this.ready = this.ready.then(async () => {
      if (token !== this.generation || win.isDestroyed()) return;
      if (win.webContents.isLoading()) {
        await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      }
      if (token !== this.generation || win.isDestroyed()) return;
      await win.webContents.executeJavaScript(
        `window.renderDryRunOverlay(${JSON.stringify(local)})`,
      );
      if (token !== this.generation || win.isDestroyed()) return;
      win.showInactive();
    });
  }

  hide(): void {
    this.generation += 1;
    this.localPlan = null;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(true);
    this.win.setFocusable(false);
    void this.win.webContents.executeJavaScript("window.renderDryRunOverlay(null)").catch(() => {});
    this.win.hide();
  }

  dispose(): void {
    this.localPlan = null;
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
      focusable: true,
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
    win.setIgnoreMouseEvents(true);
    win.setMenuBarVisibility(false);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
    this.win = win;
    return win;
  }
}
