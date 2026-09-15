import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSPECT_SETTINGS,
  INSPECT_HOTKEY_ACTION,
  INSPECT_PANEL_ID,
  INSPECT_PANEL_SIZE,
  INSPECT_SETTINGS_ID,
  isInspectReport,
  normalizeInspectSettings,
} from "../src/shared/inspect.js";
import { inspectItemText } from "../src/core/inspect.js";
import { readFileSync } from "node:fs";

describe("normalizeInspectSettings", () => {
  it("falls back to the defaults for junk", () => {
    expect(normalizeInspectSettings(undefined)).toEqual(DEFAULT_INSPECT_SETTINGS);
    expect(normalizeInspectSettings("nope")).toEqual(DEFAULT_INSPECT_SETTINGS);
    expect(normalizeInspectSettings([])).toEqual(DEFAULT_INSPECT_SETTINGS);
  });

  it("keeps a known anchor and rejects anything else", () => {
    expect(normalizeInspectSettings({ anchor: "top-right" }).anchor).toBe("top-right");
    expect(normalizeInspectSettings({ anchor: "somewhere" }).anchor).toBe("cursor");
  });

  it("keeps the display toggles on unless they are explicitly false", () => {
    expect(normalizeInspectSettings({ showQualityNormalised: false }).showQualityNormalised).toBe(false);
    expect(normalizeInspectSettings({ showQualityNormalised: "yes" }).showQualityNormalised).toBe(true);
    expect(normalizeInspectSettings({ followClipboardWhilePinned: false }).followClipboardWhilePinned).toBe(false);
  });

  it("keeps copy-on-hotkey off unless it is explicitly true", () => {
    expect(DEFAULT_INSPECT_SETTINGS.copyOnHotkey).toBe(false);
    expect(normalizeInspectSettings({ copyOnHotkey: true }).copyOnHotkey).toBe(true);
    expect(normalizeInspectSettings({ copyOnHotkey: "true" }).copyOnHotkey).toBe(false);
  });

  it("filters the map overrides by id charset and severity", () => {
    const value = normalizeInspectSettings({
      mapModOverrides: {
        "no-regen": "ignore",
        "monster-crit-chance": "caution",
        "Bad Id": "deadly",
        "players-cursed": "catastrophic",
        "monster-life": 7,
      },
    });
    expect(value.mapModOverrides).toEqual({ "no-regen": "ignore", "monster-crit-chance": "caution" });
  });

  it("caps the override table so a hand-edited file cannot grow forever", () => {
    const overrides: Record<string, string> = {};
    for (let index = 0; index < 400; index += 1) overrides[`mod-${index}`] = "info";
    const value = normalizeInspectSettings({ mapModOverrides: overrides });
    expect(Object.keys(value.mapModOverrides)).toHaveLength(200);
  });
});

describe("isInspectReport", () => {
  const real = inspectItemText(
    readFileSync(new URL("../fixtures/inspect/plain-rare-ring.txt", import.meta.url), "utf8"),
  )!;

  it("accepts a real report", () => {
    expect(isInspectReport(real)).toBe(true);
  });

  it("refuses anything malformed", () => {
    expect(isInspectReport(undefined)).toBe(false);
    expect(isInspectReport("report")).toBe(false);
    expect(isInspectReport({ ...real, schemaVersion: 2 })).toBe(false);
    expect(isInspectReport({ ...real, mods: "many" })).toBe(false);
    expect(isInspectReport({ ...real, item: null })).toBe(false);
    expect(isInspectReport({ ...real, textKind: "rich" })).toBe(false);
    expect(isInspectReport({ ...real, links: undefined })).toBe(false);
  });
});

describe("the package's shared constants", () => {
  it("matches the ids the integrator wires up", () => {
    expect(INSPECT_SETTINGS_ID).toBe("inspect");
    expect(INSPECT_PANEL_ID).toBe("inspect");
    expect(INSPECT_PANEL_SIZE).toEqual({ width: 440, height: 560 });
    expect(INSPECT_HOTKEY_ACTION).toMatchObject({
      id: "inspect.show",
      group: "Overlay",
      defaultAccelerator: "Alt+I",
    });
  });
});
