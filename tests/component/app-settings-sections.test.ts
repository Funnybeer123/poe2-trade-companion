// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { SettingsSnapshot } from "../../src/shared/features.js";

const SNAPSHOT = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures/app-settings/settings-snapshot.json"), "utf8"),
) as SettingsSnapshot;
const CLIENT_LOG = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures/app-settings/client-log-status.json"), "utf8"),
) as Record<string, unknown>;
const CHECKLIST = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures/app-settings/checklist.json"), "utf8"),
) as Record<string, unknown>;

const bridge = vi.hoisted(() => ({
  available: true,
  snapshot: {} as Record<string, unknown>,
  settingsError: "" as string,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => {
  const api = {
    invoke: (channel: string, ...args: unknown[]) => Promise.resolve(bridge.invoke(channel, ...args)),
    on: (channel: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(channel, callback);
      return () => bridge.listeners.delete(channel);
    },
  };
  return {
    createFeatureApi: () => (bridge.available ? api : null),
    getAppFeatureApi: () => (bridge.available ? api : null),
  };
});

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getPriceFeedApi: () => ({
    status: vi.fn(async () => ({})),
    leagues: vi.fn(async () => []),
    refresh: vi.fn(async () => ({})),
  }),
}));

import AppSettingsSections from "../../src/renderer/features/appSettings/AppSettingsSections.vue";
import { disposeAppSettings } from "../../src/renderer/features/appSettings/useAppSettings";

const INFO = {
  version: "0.1.0",
  buildMode: "authorized-qa",
  packaged: true,
  electron: "34.0.0",
  node: "20.18.0",
  chrome: "130.0",
  platform: "win32",
  arch: "x64",
  userDataDir: "C:/user",
  configDir: "C:/cfg",
  appPath: "C:/repo",
  settingsFile: "C:/user/companion-settings.json",
  hotkeysFile: "C:/user/overlay-hotkeys.json",
  changelogFile: "C:/repo/CHANGELOG.md",
};

function defaultInvoke(channel: string, ...args: unknown[]): unknown {
  switch (channel) {
    case "settings:get":
      if (bridge.settingsError) throw new Error(bridge.settingsError);
      return { ...bridge.snapshot };
    case "settings:set": {
      const [id, patch] = args as [string, Record<string, unknown>];
      const next = { ...(bridge.snapshot[id] as Record<string, unknown>), ...patch };
      bridge.snapshot = { ...bridge.snapshot, [id]: next };
      return next;
    }
    case "app:info":
      return INFO;
    case "app:changelog":
      return { markdown: "", source: "C:/repo/CHANGELOG.md", missing: true };
    case "app:setup-checklist":
    case "app:dismiss-checklist":
      return CHECKLIST;
    case "app:elevation":
      return { appElevated: false, poeRunning: false, poeElevated: "unknown", processes: [], checkedAt: "" };
    case "app:test-overlay":
      return undefined;
    case "app:reset-windows":
      return { mainWindow: null, overlayPanelsHidden: 2 };
    case "app:reset-settings":
      return bridge.snapshot;
    case "app:open-folder":
      return { ok: true };
    case "overlay:state":
      return {
        windowVisible: false,
        visiblePanels: [],
        pinnedPanels: [],
        pointerOverPanel: false,
        poeDetected: true,
        display: { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 1 },
      };
    case "overlay:hide-all":
      return undefined;
    case "chat:status":
      return { enabled: false, hostRunning: false, sentThisMinute: 3, maxPerMinute: 30, dryRun: true };
    case "client-log:status":
    case "client-log:set-file":
    case "client-log:browse-file":
    case "client-log:reload-settings":
      return CLIENT_LOG;
    default:
      throw new Error(`unexpected ${channel}`);
  }
}

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:rest(.*)", component: { template: "<div />" } }],
  });
}

async function mountSections() {
  const wrapper = mount(AppSettingsSections, {
    attachTo: document.body,
    global: { plugins: [testRouter()] },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  bridge.available = true;
  bridge.settingsError = "";
  bridge.snapshot = JSON.parse(JSON.stringify(SNAPSHOT)) as Record<string, unknown>;
  bridge.listeners.clear();
  bridge.invoke.mockImplementation(defaultInvoke);
  disposeAppSettings();
});

afterEach(() => {
  disposeAppSettings();
});

describe("AppSettingsSections", () => {
  it("renders one desktop-only notice and no controls in the browser preview", async () => {
    bridge.available = false;
    const wrapper = await mountSections();
    expect(wrapper.text()).toContain("App settings need the desktop app");
    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("loads the settings snapshot once and renders every section", async () => {
    const wrapper = await mountSections();
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "settings:get")).toHaveLength(1);
    const summaries = wrapper.findAll("summary").map((node) => node.text());
    expect(summaries.some((text) => text.startsWith("Overlay"))).toBe(true);
    expect(summaries.some((text) => text.includes("Notifications"))).toBe(true);
    expect(summaries.some((text) => text.includes("Game client"))).toBe(true);
    expect(summaries.some((text) => text === "Window")).toBe(true);
    expect(summaries.some((text) => text.startsWith("Changelog"))).toBe(true);
    expect(summaries.some((text) => text.includes("About"))).toBe(true);
  });

  it("shows a retry panel INSTEAD of the sections when the settings read fails", async () => {
    bridge.settingsError = "settings file is locked";
    const wrapper = await mountSections();
    const alert = wrapper.find("[role=alert]");
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("settings file is locked");
    // Rendering the editors on top of DEFAULT settings would show the wrong
    // state and let the first toggle persist those defaults over the real file.
    expect(wrapper.findAll("input")).toHaveLength(0);
    expect(wrapper.findAll("details")).toHaveLength(0);
    expect(wrapper.findAll("button").map((button) => button.text())).toEqual(["Retry"]);
    expect(bridge.invoke).not.toHaveBeenCalledWith("settings:set", expect.anything(), expect.anything());
  });

  it("probes nothing on mount and runs the admin check only when asked", async () => {
    const wrapper = await mountSections();
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "app:elevation")).toHaveLength(0);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Check administrator rights")!
      .trigger("click");
    await flushPromises();
    // `true` = force, so a second press after restarting the game really re-checks.
    expect(bridge.invoke).toHaveBeenCalledWith("app:elevation", true);
  });

  it("keeps the saved bounds when a window toggle is written", async () => {
    bridge.snapshot = {
      ...bridge.snapshot,
      app: {
        ...(bridge.snapshot.app as Record<string, unknown>),
        window: { rememberBounds: true, alwaysOnTop: false, showOnGameStart: false, bounds: { x: 7, y: 9, width: 900, height: 700 } },
      },
    };
    const wrapper = await mountSections();
    const toggle = wrapper
      .findAll("label.toggle-field")
      .find((label) => label.text().includes("above the game"))!
      .find("input");
    await toggle.setValue(true);
    await flushPromises();
    // The patch carries the WHOLE window object (SettingsStore merges shallowly
    // at the namespace root), so a dropped spread would silently wipe siblings.
    expect(bridge.invoke).toHaveBeenCalledWith("settings:set", "app", {
      window: {
        rememberBounds: true,
        alwaysOnTop: true,
        showOnGameStart: false,
        bounds: { x: 7, y: 9, width: 900, height: 700 },
      },
    });
  });

  it("writes overlay toggles straight through settings:set and reflects the result", async () => {
    const wrapper = await mountSections();
    const checkbox = wrapper
      .findAll("label.toggle-field")
      .find((label) => label.text().includes("Close panels when you click outside"))!
      .find("input");
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    await checkbox.setValue(false);
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("settings:set", "overlay", { closeOnClickOutside: false });
    expect((bridge.snapshot.overlay as { closeOnClickOutside: boolean }).closeOnClickOutside).toBe(false);
  });

  it("labels the range inputs for screen readers", async () => {
    const wrapper = await mountSections();
    const ranges = wrapper.findAll('input[type="range"]');
    expect(ranges).toHaveLength(2);
    expect(ranges[0]?.attributes("aria-valuetext")).toBe("scale 1.00×");
    expect(ranges[1]?.attributes("aria-valuetext")).toBe("opacity 96 %");
  });

  it("surfaces a failed write and leaves the control usable", async () => {
    const wrapper = await mountSections();
    bridge.invoke.mockImplementationOnce(() => {
      throw new Error("disk is read-only");
    });
    const checkbox = wrapper
      .findAll("label.toggle-field")
      .find((label) => label.text().includes("primary monitor"))!
      .find("input");
    await checkbox.setValue(true);
    await flushPromises();
    expect(wrapper.text()).toContain("disk is read-only");
    expect((checkbox.element as HTMLInputElement).disabled).toBe(false);
  });

  it("runs the overlay test and hide-all buttons", async () => {
    const wrapper = await mountSections();
    const buttons = wrapper.findAll("button");
    await buttons.find((button) => button.text() === "Test overlay")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:test-overlay");
    await buttons.find((button) => button.text() === "Hide all panels")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("overlay:hide-all");
  });

  it("toggles chat commands, shows the dry-run status line and holds no password field", async () => {
    const wrapper = await mountSections();
    const chat = wrapper
      .findAll("label.toggle-field")
      .find((label) => label.text().includes("Allow chat commands"))!;
    await chat.find("input").setValue(true);
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("settings:set", "chat-commands", { enabled: true });
    expect(wrapper.text()).toContain("3/30 this minute");
    expect(wrapper.text()).toContain("dry-run: lines are logged, not typed");
    expect(wrapper.text()).toContain("Trade offers, quick whispers and Discord/Telegram webhooks");
    expect(wrapper.text()).toContain("Live-search chime and toasts");
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0);
  });

  it("drives the Client.txt override and renders the game config read-outs", async () => {
    const wrapper = await mountSections();
    expect(wrapper.text()).toContain("3840×2160");
    expect(wrapper.text()).toContain("borderless windowed");
    expect(wrapper.text()).toContain("Enter");

    const buttons = () => wrapper.findAll("button");
    await buttons().find((button) => button.text() === "Browse…")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("client-log:browse-file");

    await buttons().find((button) => button.text() === "Use this file")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("client-log:set-file", CLIENT_LOG.file);

    await buttons().find((button) => button.text() === "Auto-detect")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("client-log:set-file", null);

    await buttons().find((button) => button.text() === "Re-read game config")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("client-log:reload-settings");
  });

  it("resets the window positions and reports what happened", async () => {
    const wrapper = await mountSections();
    await wrapper.findAll("button").find((button) => button.text() === "Reset window positions")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:reset-windows");
    expect(wrapper.text()).toContain("Window re-centred · 2 overlay panels hidden");
  });

  it("needs two clicks to reset the app and overlay settings", async () => {
    const wrapper = await mountSections();
    const button = () =>
      wrapper.findAll("button").find((entry) => /Reset app & overlay settings|Click again to confirm/.test(entry.text()))!;
    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke).not.toHaveBeenCalledWith("app:reset-settings", ["app", "overlay"]);
    expect(button().text()).toBe("Click again to confirm");
    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:reset-settings", ["app", "overlay"]);
  });

  it("opens the data folder", async () => {
    const wrapper = await mountSections();
    await wrapper.findAll("button").find((button) => button.text() === "Open data folder")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:open-folder", "userData");
  });
});
