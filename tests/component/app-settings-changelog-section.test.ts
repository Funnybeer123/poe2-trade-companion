// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../../src/shared/appSettings.js";

const SAMPLE = readFileSync(
  path.join(process.cwd(), "fixtures/app-settings/CHANGELOG.sample.md"),
  "utf8",
);

const bridge = vi.hoisted(() => ({
  available: true,
  snapshot: {} as Record<string, unknown>,
  markdown: "",
  missing: false,
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

import ChangelogSection from "../../src/renderer/features/appSettings/ChangelogSection.vue";
import { disposeAppSettings, useAppSettings } from "../../src/renderer/features/appSettings/useAppSettings";

const PACKAGED: AppInfo = {
  version: "0.2.0",
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
      return { ...bridge.snapshot };
    case "settings:set": {
      const [id, patch] = args as [string, Record<string, unknown>];
      const next = { ...(bridge.snapshot[id] as Record<string, unknown>), ...patch };
      bridge.snapshot = { ...bridge.snapshot, [id]: next };
      return next;
    }
    case "app:changelog":
      return { markdown: bridge.markdown, source: "C:/repo/CHANGELOG.md", missing: bridge.missing };
    default:
      throw new Error(`unexpected ${channel}`);
  }
}

async function mountSection(props: Record<string, unknown> = {}) {
  await useAppSettings().load();
  const wrapper = mount(ChangelogSection, { props, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  bridge.available = true;
  bridge.markdown = SAMPLE;
  bridge.missing = false;
  bridge.snapshot = { app: { changelog: { lastSeenVersion: "" } } };
  bridge.listeners.clear();
  bridge.invoke.mockImplementation(defaultInvoke);
  disposeAppSettings();
});

afterEach(() => disposeAppSettings());

describe("ChangelogSection", () => {
  it("renders releases, their sections and entries from the source prop", async () => {
    const wrapper = await mountSection({ source: SAMPLE, info: PACKAGED });
    expect(wrapper.text()).toContain("0.2.0 — 2026-09-20");
    expect(wrapper.text()).toContain("Added");
    expect(wrapper.text()).toContain("Changelog tab");
    expect(wrapper.text()).toContain("Window position survives a restart");
    expect(wrapper.text()).toContain("PoE2 Trade Companion 0.2.0 · authorized-qa · packaged");
  });

  it("hides Unreleased in a packaged build and shows it in a dev build", async () => {
    const packaged = await mountSection({ source: SAMPLE, info: PACKAGED });
    expect(packaged.text()).not.toContain("Unreleased");

    disposeAppSettings();
    const dev = await mountSection({ source: SAMPLE, info: { ...PACKAGED, packaged: false } });
    expect(dev.text()).toContain("Unreleased");
  });

  it("counts the releases newer than the bookmark", async () => {
    const wrapper = await mountSection({ source: SAMPLE, info: PACKAGED });
    expect(wrapper.find(".count-badge").text()).toBe("2 new");

    disposeAppSettings();
    bridge.snapshot = { app: { changelog: { lastSeenVersion: "0.1.0" } } };
    const seen = await mountSection({ source: SAMPLE, info: PACKAGED });
    expect(seen.find(".count-badge").text()).toBe("1 new");

    disposeAppSettings();
    bridge.snapshot = { app: { changelog: { lastSeenVersion: "0.2.0" } } };
    const current = await mountSection({ source: SAMPLE, info: PACKAGED });
    expect(current.find(".count-badge").exists()).toBe(false);
  });

  it("bookmarks the newest released version when the disclosure is opened", async () => {
    const wrapper = await mountSection({ source: SAMPLE, info: PACKAGED });
    const details = wrapper.find("details").element as HTMLDetailsElement;
    details.open = true;
    await wrapper.find("details").trigger("toggle");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("settings:set", "app", {
      changelog: { lastSeenVersion: "0.2.0" },
    });
  });

  it("reads the changelog from main when no source prop is given", async () => {
    const wrapper = await mountSection({ info: PACKAGED });
    expect(bridge.invoke).toHaveBeenCalledWith("app:changelog");
    expect(wrapper.text()).toContain("Changelog tab");
  });

  it("shows an empty state when the build ships no changelog", async () => {
    bridge.markdown = "";
    bridge.missing = true;
    const wrapper = await mountSection({ info: PACKAGED });
    expect(wrapper.text()).toContain("No changelog shipped with this build.");
    expect(wrapper.find(".count-badge").exists()).toBe(false);
  });
});
