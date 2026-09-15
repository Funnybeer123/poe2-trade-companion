import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "../src/shared/appSettings.js";

describe("normalizeAppSettings", () => {
  it("falls back to the defaults for undefined and junk", () => {
    expect(normalizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings("nonsense")).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings([1, 2, 3])).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings({ window: 42, setup: "x", changelog: null })).toEqual(
      DEFAULT_APP_SETTINGS,
    );
  });

  it("keeps every boolean the caller actually set", () => {
    const value = normalizeAppSettings({
      window: { rememberBounds: false, alwaysOnTop: false, showOnGameStart: true },
    });
    expect(value.window).toEqual({
      rememberBounds: false,
      alwaysOnTop: false,
      showOnGameStart: true,
    });
  });

  it("keeps usable bounds and drops tiny or malformed ones", () => {
    const kept = normalizeAppSettings({
      window: { bounds: { x: 120, y: 80, width: 1180, height: 900 } },
    });
    expect(kept.window.bounds).toEqual({ x: 120, y: 80, width: 1180, height: 900 });

    expect(normalizeAppSettings({ window: { bounds: { x: 0, y: 0, width: 10, height: 10 } } }).window.bounds)
      .toBeUndefined();
    expect(normalizeAppSettings({ window: { bounds: { x: "a", y: 0, width: 800, height: 600 } } }).window.bounds)
      .toBeUndefined();
    expect(normalizeAppSettings({ window: { bounds: "somewhere" } }).window.bounds).toBeUndefined();
  });

  it("keeps only ISO timestamps that parse", () => {
    const value = normalizeAppSettings({
      setup: { dismissedAt: "2026-09-12T10:00:00.000Z", overlayTestedAt: "never" },
    });
    expect(value.setup.dismissedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(value.setup.overlayTestedAt).toBeUndefined();
  });

  it("filters the last-seen version", () => {
    expect(normalizeAppSettings({ changelog: { lastSeenVersion: "0.2.0" } }).changelog.lastSeenVersion).toBe(
      "0.2.0",
    );
    expect(normalizeAppSettings({ changelog: { lastSeenVersion: "0.2.0; rm -rf" } }).changelog.lastSeenVersion)
      .toBe("");
    expect(normalizeAppSettings({ changelog: { lastSeenVersion: "x".repeat(40) } }).changelog.lastSeenVersion)
      .toBe("");
    expect(normalizeAppSettings({ changelog: { lastSeenVersion: 3 } }).changelog.lastSeenVersion).toBe("");
  });

  it("drops every unknown key, so no secret can survive a round trip", () => {
    const value = normalizeAppSettings({
      window: { rememberBounds: true, evil: "x" },
      sounds: { tradeIn: "C:/beep.wav" },
      notifications: { windows: true },
      currencyDisplay: "icons",
      webhooks: { discordUrl: "https://discord.example/hook", telegramBotToken: "123:abc" },
    });
    expect(Object.keys(value).sort()).toEqual(["changelog", "setup", "window"]);
    expect(Object.keys(value.window).sort()).toEqual(["alwaysOnTop", "rememberBounds", "showOnGameStart"]);
    expect(JSON.stringify(value)).not.toContain("discord");
    expect(JSON.stringify(value)).not.toContain("beep.wav");
  });

  it("is idempotent", () => {
    const once: AppSettings = normalizeAppSettings({
      window: { rememberBounds: false, bounds: { x: 1, y: 2, width: 900, height: 700 } },
      setup: { overlayTestedAt: "2026-09-12T09:58:11.000Z" },
      changelog: { lastSeenVersion: "1.2.3-beta.1" },
    });
    expect(normalizeAppSettings(once)).toEqual(once);
  });
});
