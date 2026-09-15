import { describe, expect, it } from "vitest";
import {
  boundsOnSomeDisplay,
  centredBounds,
  DEFAULT_MAIN_WINDOW_SIZE,
  sanitizeWindowBounds,
  type DisplayArea,
} from "../src/core/appSettingsWindow.js";

const PRIMARY: DisplayArea = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: DisplayArea = { x: 1920, y: 0, width: 2560, height: 1400 };

describe("sanitizeWindowBounds", () => {
  it("keeps a plausible rectangle and rounds it", () => {
    expect(sanitizeWindowBounds({ x: 10.4, y: 20.6, width: 800.2, height: 600.8 })).toEqual({
      x: 10,
      y: 21,
      width: 800,
      height: 601,
    });
  });

  it("drops junk, non-finite numbers and tiny rectangles", () => {
    expect(sanitizeWindowBounds(undefined)).toBeUndefined();
    expect(sanitizeWindowBounds("x")).toBeUndefined();
    expect(sanitizeWindowBounds([0, 0, 800, 600])).toBeUndefined();
    expect(sanitizeWindowBounds({ x: Number.NaN, y: 0, width: 800, height: 600 })).toBeUndefined();
    expect(sanitizeWindowBounds({ x: 0, y: 0, width: 199, height: 600 })).toBeUndefined();
    expect(sanitizeWindowBounds({ x: 0, y: 0, width: 800, height: 149 })).toBeUndefined();
  });

  it("accepts negative coordinates (a display to the left of the primary)", () => {
    expect(sanitizeWindowBounds({ x: -1800, y: 40, width: 900, height: 700 })).toEqual({
      x: -1800,
      y: 40,
      width: 900,
      height: 700,
    });
  });
});

describe("boundsOnSomeDisplay", () => {
  it("accepts a window fully inside a display", () => {
    expect(boundsOnSomeDisplay({ x: 100, y: 100, width: 800, height: 600 }, [PRIMARY, SECOND])).toBe(true);
  });

  it("accepts a window half-way over an edge and refuses less than half", () => {
    expect(boundsOnSomeDisplay({ x: 1520, y: 100, width: 800, height: 600 }, [PRIMARY])).toBe(true);
    expect(boundsOnSomeDisplay({ x: 1700, y: 100, width: 800, height: 600 }, [PRIMARY])).toBe(false);
  });

  it("refuses a window on a display that was unplugged", () => {
    const onSecond = { x: 2000, y: 100, width: 900, height: 700 };
    expect(boundsOnSomeDisplay(onSecond, [PRIMARY, SECOND])).toBe(true);
    expect(boundsOnSomeDisplay(onSecond, [PRIMARY])).toBe(false);
    expect(boundsOnSomeDisplay(onSecond, [])).toBe(false);
  });

  it("refuses a degenerate rectangle", () => {
    expect(boundsOnSomeDisplay({ x: 0, y: 0, width: 0, height: 0 }, [PRIMARY])).toBe(false);
  });
});

describe("centredBounds", () => {
  it("centres the default size on the given display", () => {
    expect(centredBounds(PRIMARY)).toEqual({
      x: (1920 - DEFAULT_MAIN_WINDOW_SIZE.width) / 2,
      y: (1040 - DEFAULT_MAIN_WINDOW_SIZE.height) / 2,
      width: DEFAULT_MAIN_WINDOW_SIZE.width,
      height: DEFAULT_MAIN_WINDOW_SIZE.height,
    });
  });

  it("respects the display's own offset and never exceeds it", () => {
    const small: DisplayArea = { x: 1920, y: 0, width: 800, height: 600 };
    const bounds = centredBounds(small);
    expect(bounds.width).toBe(800);
    expect(bounds.height).toBe(600);
    expect(bounds.x).toBe(1920);
  });
});
