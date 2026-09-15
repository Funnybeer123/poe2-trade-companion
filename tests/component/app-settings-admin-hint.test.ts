// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElevationReport } from "../../src/shared/appSettings.js";

const bridge = vi.hoisted(() => ({
  available: true,
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

import AdminRightsHint from "../../src/renderer/features/appSettings/AdminRightsHint.vue";

const ACTIONABLE: ElevationReport = {
  appElevated: false,
  poeRunning: true,
  poeElevated: "likely",
  processes: [{ name: "PathOfExileSteam", pid: 7, access: "denied" }],
  hint: "Path of Exile 2 appears to run as administrator while the companion does not. Windows (UIPI) drops input…",
  checkedAt: "2026-09-12T10:00:00.000Z",
};

const CLEAN: ElevationReport = {
  appElevated: false,
  poeRunning: true,
  poeElevated: "no",
  processes: [{ name: "PathOfExileSteam", pid: 7, access: "ok" }],
  checkedAt: "2026-09-12T10:00:00.000Z",
};

const UNCLEAR: ElevationReport = {
  appElevated: false,
  poeRunning: true,
  poeElevated: "unknown",
  processes: [{ name: "PathOfExileSteam", pid: 7, access: "error" }],
  checkedAt: "2026-09-12T10:00:00.000Z",
};

function mountHint(props: Record<string, unknown>) {
  return mount(AdminRightsHint, {
    props: { report: null, buildMode: "authorized-qa", ...props },
    attachTo: document.body,
  });
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockImplementation((channel) => {
    if (channel === "app:relaunch-elevated") return { ok: true };
    throw new Error(`unexpected ${channel}`);
  });
});

describe("AdminRightsHint", () => {
  it("renders nothing without a report", () => {
    const wrapper = mountHint({ report: null });
    expect(wrapper.find(".admin-hint").exists()).toBe(false);
  });

  it("shows the alert only for the actionable case", () => {
    const warned = mountHint({ report: ACTIONABLE });
    expect(warned.find("[role=alert]").text()).toContain("UIPI");

    const clean = mountHint({ report: CLEAN });
    expect(clean.find("[role=alert]").exists()).toBe(false);
    expect(clean.text()).toContain("same privilege");
  });

  it("explains the heuristic when the verdict is unknown", () => {
    const wrapper = mountHint({ report: UNCLEAR });
    expect(wrapper.text()).toContain("heuristic");
    expect(wrapper.text()).toContain("never blocks anything");
  });

  it("says nothing to warn about when the companion is elevated and offers no relaunch", () => {
    const wrapper = mountHint({ report: { ...ACTIONABLE, appElevated: true, hint: undefined } });
    expect(wrapper.text()).toContain("companion runs as administrator");
    expect(wrapper.find("details").exists()).toBe(false);
  });

  it("hides the relaunch entirely in the public build", () => {
    const wrapper = mountHint({ report: ACTIONABLE, buildMode: "public-companion" });
    expect(wrapper.find("details").exists()).toBe(false);
    expect(wrapper.find("[role=alert]").exists()).toBe(true);
  });

  it("keeps the relaunch behind a disclosure and a confirming second click", async () => {
    const wrapper = mountHint({ report: ACTIONABLE });
    const details = wrapper.find("details");
    expect(details.exists()).toBe(true);
    expect(details.attributes("open")).toBeUndefined();

    const button = () => wrapper.findAll("button")[0]!;
    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(button().text()).toBe("Click again to confirm");

    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:relaunch-elevated");
    expect(wrapper.text()).toContain("Approve the Windows prompt");
  });

  it("explains a refusal instead of pretending it worked", async () => {
    bridge.invoke.mockImplementation(() => ({ ok: false, error: "already-elevated" }));
    const wrapper = mountHint({ report: ACTIONABLE });
    const button = () => wrapper.findAll("button")[0]!;
    await button().trigger("click");
    await button().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("already runs as administrator");
  });

  it("hides the relaunch when the build mode is not known yet", () => {
    // `app:info` failed or has not answered — fail closed, never offer it.
    expect(mountHint({ report: ACTIONABLE, buildMode: "" }).find("details").exists()).toBe(false);
    expect(mountHint({ report: ACTIONABLE, buildMode: "something-new" }).find("details").exists()).toBe(
      false,
    );
    expect(mountHint({ report: ACTIONABLE, buildMode: "assistive-access" }).find("details").exists()).toBe(
      true,
    );
  });

  it("hides the relaunch in compact mode", () => {
    const wrapper = mountHint({ report: ACTIONABLE, compact: true });
    expect(wrapper.find("details").exists()).toBe(false);
  });
});
