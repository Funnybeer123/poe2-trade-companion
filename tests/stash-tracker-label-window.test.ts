import { describe, expect, it } from "vitest";
import type { PriceOverlayItem, PriceOverlayPlan } from "../src/core/stashTrackerOverlay.js";
import {
  LABEL_WINDOW_HTML,
  PriceLabelWindow,
  planForLabelWindow,
  type LabelScreenLike,
  type LabelWindowLike,
  type Rect,
} from "../src/main/features/stashTracker/labelWindow.js";

async function flush(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeWindow() {
  const calls: string[] = [];
  const scripts: string[] = [];
  let destroyed = false;
  let visible = false;
  let loading = true;
  const loadListeners: Array<() => void> = [];
  const closedListeners: Array<() => void> = [];
  const win: LabelWindowLike & {
    calls: string[];
    scripts: string[];
    finishLoad(): void;
    isVisibleNow(): boolean;
  } = {
    calls,
    scripts,
    finishLoad: () => {
      loading = false;
      for (const listener of loadListeners.splice(0)) listener();
    },
    isVisibleNow: () => visible,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    setBounds: (rect) => calls.push(`setBounds ${rect.x},${rect.y} ${rect.width}x${rect.height}`),
    setAlwaysOnTop: (flag, level) => calls.push(`alwaysOnTop ${flag} ${level ?? ""}`.trim()),
    setIgnoreMouseEvents: (ignore, options) =>
      calls.push(`ignoreMouse ${ignore}${options?.forward ? " forward" : ""}`),
    showInactive: () => {
      visible = true;
      calls.push("showInactive");
    },
    hide: () => {
      visible = false;
      calls.push("hide");
    },
    destroy: () => {
      destroyed = true;
      calls.push("destroy");
    },
    once: (_event, callback) => closedListeners.push(callback),
    webContents: {
      isLoading: () => loading,
      once: (_event, callback) => loadListeners.push(callback),
      executeJavaScript: async (code) => {
        scripts.push(code);
        return undefined;
      },
    },
  };
  return win;
}

function identityScreen(): LabelScreenLike {
  return { screenToDipRect: (_window, rect) => rect };
}

/** 150 % display scaling: every screen rect shrinks by 2/3. */
function scaledScreen(factor = 2 / 3): LabelScreenLike {
  return {
    screenToDipRect: (_window, rect: Rect) => ({
      x: Math.round(rect.x * factor),
      y: Math.round(rect.y * factor),
      width: Math.round(rect.width * factor),
      height: Math.round(rect.height * factor),
    }),
  };
}

function item(partial: Partial<PriceOverlayItem> = {}): PriceOverlayItem {
  return {
    area: "stash",
    id: "3,5:1x1",
    row: 3,
    col: 5,
    w: 1,
    h: 1,
    x: 299,
    y: 409,
    width: 52,
    height: 53,
    cells: [{ row: 3, col: 5 }],
    label: "120 ex",
    tone: "table",
    name: "Headhunter",
    valueExalted: 120,
    unitExalted: 120,
    opacity: 1,
    fontPx: 17,
    ...partial,
  };
}

function plan(client = { left: 0, top: 0, width: 3840, height: 2160 }): PriceOverlayPlan {
  const items = [item()];
  return {
    kind: "fill",
    client,
    grids: [
      {
        region: "stash",
        label: "Belts · 3h ago · est. prices",
        x: 34,
        y: 320,
        w: 1261,
        h: 1263,
        cols: 24,
        rows: 24,
      },
    ],
    clicks: [],
    occupied: [],
    detected: [],
    items,
    detectedItems: items,
    tab: "Belts",
    ageLabel: "3h ago",
    totalExalted: 120,
    priced: 1,
    unpriced: 0,
  };
}

describe("planForLabelWindow", () => {
  it("shifts into client space at 100 % scale", () => {
    const { bounds, plan: local } = planForLabelWindow(
      plan({ left: 100, top: 50, width: 1920, height: 1080 }),
      { screenToDipRect: (_window, rect) => rect },
    );
    expect(bounds).toEqual({ x: 100, y: 50, width: 1920, height: 1080 });
    expect(local.client).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(local.grids[0]).toMatchObject({ x: -66, y: 270 });
    expect(local.items[0]).toMatchObject({ x: 199, y: 359, fontPx: 17 });
  });

  it("converts every rect and scales the font on a high-DPI display", () => {
    const { bounds, plan: local } = planForLabelWindow(plan(), scaledScreen());
    expect(bounds).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
    expect(local.client).toEqual({ left: 0, top: 0, width: 2560, height: 1440 });
    expect(local.items[0]).toMatchObject({ x: 199, y: 273, fontPx: 11 });
    expect(local.grids[0]).toMatchObject({ x: 23, y: 213 });
    expect(local.detectedItems).toEqual(local.items);
  });

  it("falls back to the raw rect when the screen module throws", () => {
    const { bounds } = planForLabelWindow(plan(), {
      screenToDipRect: () => {
        throw new Error("no display");
      },
    });
    expect(bounds).toEqual({ x: 0, y: 0, width: 3840, height: 2160 });
  });
});

describe("PriceLabelWindow", () => {
  it("creates the window lazily, is click-through before anything is shown, and never steals focus", async () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const layer = new PriceLabelWindow({
      createWindow: () => {
        const win = fakeWindow();
        windows.push(win);
        return win;
      },
      screen: identityScreen(),
    });
    expect(windows).toHaveLength(0);
    layer.show(plan());
    const win = windows[0]!;
    expect(win.calls[0]).toBe("ignoreMouse true forward");
    win.finishLoad();
    await flush();
    expect(win.scripts[0]).toContain("window.renderPriceLabels({");
    expect(win.calls).toContain("showInactive");
    expect(win.calls).not.toContain("show");
    expect(win.calls).not.toContain("focus");
    expect(layer.isVisible()).toBe(true);
    layer.dispose();
    expect(win.calls).toContain("destroy");
  });

  it("drops a render whose hide arrived while the page was still loading", async () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const layer = new PriceLabelWindow({
      createWindow: () => {
        const win = fakeWindow();
        windows.push(win);
        return win;
      },
      screen: identityScreen(),
    });
    layer.show(plan());
    const win = windows[0]!;
    layer.hide();
    win.finishLoad();
    await flush();
    expect(win.calls).not.toContain("showInactive");
    expect(layer.isVisible()).toBe(false);
    expect(win.scripts.some((script) => script.includes("renderPriceLabels(null)"))).toBe(true);
  });

  it("never builds a second window for a show that arrives after dispose", async () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const layer = new PriceLabelWindow({
      createWindow: () => {
        const win = fakeWindow();
        win.finishLoad();
        windows.push(win);
        return win;
      },
      screen: identityScreen(),
    });
    layer.show(plan());
    await flush();
    layer.dispose();
    // The service's in-flight gesture resolving after shutdown: a new window
    // here would never be destroyed (and throws after app teardown).
    layer.show(plan());
    await flush();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.calls.filter((call) => call === "showInactive")).toHaveLength(1);
    expect(layer.isVisible()).toBe(false);
  });

  it("reuses one window across shows and coalesces the ones that queued up", async () => {
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const layer = new PriceLabelWindow({
      createWindow: () => {
        const win = fakeWindow();
        win.finishLoad();
        windows.push(win);
        return win;
      },
      screen: identityScreen(),
    });
    layer.show(plan());
    layer.show(plan());
    await flush();
    expect(windows).toHaveLength(1);
    // The generation guard drops the render the second show superseded.
    expect(windows[0]!.scripts).toHaveLength(1);
    layer.show(plan());
    await flush();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.scripts).toHaveLength(2);
  });
});

describe("LABEL_WINDOW_HTML", () => {
  it("renders labels and reaches no bridge", () => {
    expect(LABEL_WINDOW_HTML).toContain("window.renderPriceLabels");
    expect(LABEL_WINDOW_HTML).not.toContain("window.poe2");
    expect(LABEL_WINDOW_HTML).not.toContain("addEventListener");
    expect(LABEL_WINDOW_HTML).toContain("pointer-events: none");
  });
});
