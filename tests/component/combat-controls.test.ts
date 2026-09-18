// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CombatConfig, type CombatStatus } from "../../src/core/combatAssist.js";
import { useCombatControls } from "../../src/renderer/composables/useCombatControls.js";
import { calibratedCombat } from "../combatFixtures.js";

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  delete window.poe2;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(running = false) {
  let saved: CombatStatus = { config: calibratedCombat(), running, reason: running ? "Watching HUD" : "Stopped", actions: 12 };
  const api = {
    status: vi.fn(async () => structuredClone(saved)),
    configure: vi.fn(async (config: CombatConfig) => {
      saved = { ...saved, config: structuredClone(config), running: false, reason: "Settings saved" };
      return structuredClone(saved);
    }),
    start: vi.fn(async () => {
      saved = { ...saved, running: true, reason: "Watching HUD" };
      return structuredClone(saved);
    }),
    stop: vi.fn(async () => {
      saved = { ...saved, running: false, reason: "Stopped" };
      return structuredClone(saved);
    }),
    preview: vi.fn(), setGlobalDryRun: vi.fn(),
  };
  window.poe2 = { combat: api } as unknown as NonNullable<typeof window.poe2>;
  return { api, get saved() { return saved; } };
}
function harness() {
  let controls!: ReturnType<typeof useCombatControls>;
  const wrapper = mount(defineComponent({ setup() { controls = useCombatControls(); return () => null; } }));
  wrappers.push(wrapper);
  return { controls, wrapper };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("dashboard combat controls", () => {
  it("stays unavailable in a browser without starting a poll timer", async () => {
    vi.useFakeTimers();
    const { controls } = harness();
    expect(controls.available).toBe(false);
    expect(controls.loading.value).toBe(false);
    expect(controls.readiness.value).toContain("desktop app");
    await controls.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls current status and cannot restart polling after a late response on unmount", async () => {
    vi.useFakeTimers();
    const { api, saved } = setup();
    const { controls, wrapper } = harness();
    expect(controls.loading.value).toBe(true);
    await flushPromises();
    expect(controls.loading.value).toBe(false);
    expect(controls.readiness.value).toBe("");
    const response = deferred<CombatStatus>();
    api.status.mockReturnValueOnce(response.promise);
    await vi.advanceTimersByTimeAsync(750);
    expect(api.status).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    response.resolve({ ...saved, running: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(controls.state.value?.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("toggles the latest saved settings, preserving calibration, bindings and other options", async () => {
    const fixture = setup(true);
    const { controls } = harness();
    await flushPromises();
    // Another page or a hotkey changes settings after this dashboard's last poll.
    fixture.saved.config.mana.key = "Q";
    fixture.saved.config.health.threshold = 23;
    fixture.saved.config.pollMs = 32;
    fixture.saved.config.dryRun = true;
    const expected = structuredClone(fixture.saved.config);
    expected.mana.enabled = false;
    await controls.toggleModule("mana", false);
    expect(fixture.api.configure).toHaveBeenCalledExactlyOnceWith(expected);
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.state.value?.running).toBe(true);
    expect(controls.state.value?.config.regions).toEqual(expected.regions);
  });

  it("keeps a stopped loop stopped when a module is enabled", async () => {
    const fixture = setup();
    fixture.saved.config.health.enabled = false;
    const { controls } = harness();
    await flushPromises();
    await controls.toggleModule("health");
    expect(fixture.api.configure).toHaveBeenCalledOnce();
    expect(fixture.api.start).not.toHaveBeenCalled();
    expect(controls.state.value?.config.health.enabled).toBe(true);
    expect(controls.state.value?.running).toBe(false);
  });

  it("stops without resuming when the last enabled module is switched off", async () => {
    const fixture = setup(true);
    fixture.saved.config.health.enabled = fixture.saved.config.mana.enabled = false;
    const { controls } = harness();
    await flushPromises();
    await controls.toggleModule("unleash", false);
    expect(fixture.api.start).not.toHaveBeenCalled();
    expect(controls.state.value?.running).toBe(false);
    expect(controls.readiness.value).toContain("Enable a flask or a skill");
  });

  it("keeps a running loop alive when Powered by Verisium is the only module left on", async () => {
    const fixture = setup(true);
    fixture.saved.config.health.enabled = fixture.saved.config.mana.enabled = false;
    fixture.saved.config.verisium.enabled = true;
    const { controls } = harness();
    await flushPromises();
    await controls.toggleModule("unleash", false);
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.state.value?.running).toBe(true);
    expect(controls.state.value?.config.verisium.enabled).toBe(true);
    await controls.toggleModule("verisium", false);
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.state.value?.running).toBe(false);
    expect(controls.readiness.value).toContain("Enable a flask or a skill");
  });

  it("disables both manual macro participants without falling back to automatic casts", async () => {
    const fixture = setup(true);
    fixture.saved.config.health.enabled = fixture.saved.config.mana.enabled = false;
    fixture.saved.config.unleash.enabled = fixture.saved.config.verisium.enabled = fixture.saved.config.sigilSequence.enabled = true;
    const { controls } = harness();
    await flushPromises();
    await controls.toggleModule("unleash", false);
    expect(fixture.api.start).not.toHaveBeenCalled();
    expect(controls.state.value?.config.sigilSequence.enabled).toBe(false);
    expect(controls.state.value?.config.unleash.enabled).toBe(false);
    expect(controls.state.value?.config.verisium.enabled).toBe(false);
  });

  it("can arm a manual macro with no skill or HUD calibration when flasks are off", async () => {
    const fixture = setup();
    fixture.saved.config.health.enabled = fixture.saved.config.mana.enabled = false;
    fixture.saved.config.unleash.enabled = fixture.saved.config.verisium.enabled = fixture.saved.config.sigilSequence.enabled = true;
    fixture.saved.config.regions = {};
    const { controls } = harness();
    await flushPromises();
    expect(controls.readiness.value).toBe("");
    await controls.start();
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.state.value?.running).toBe(true);
  });

  it("starts only a calibrated saved configuration, then stops explicitly", async () => {
    const fixture = setup();
    const { controls } = harness();
    await flushPromises();
    delete fixture.saved.config.regions.unleash!.cooldown;
    await controls.start();
    expect(fixture.api.start).not.toHaveBeenCalled();
    expect(controls.error.value).toContain("both ready and on cooldown");
    fixture.saved.config = calibratedCombat();
    await controls.start();
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.error.value).toBe("");
    await controls.stop();
    expect(fixture.api.stop).toHaveBeenCalledOnce();
    expect(controls.state.value?.running).toBe(false);
  });

  it("serializes mutations and ignores a stale status response already in flight", async () => {
    const fixture = setup();
    const { controls } = harness();
    await flushPromises();
    const stale = structuredClone(fixture.saved);
    const response = deferred<CombatStatus>();
    fixture.api.status.mockReturnValueOnce(response.promise);
    const refreshing = controls.refresh();
    const starting = controls.start();
    expect(controls.pending.value).toBe(true);
    await controls.toggleModule("health", false);
    await starting;
    response.resolve(stale);
    await refreshing;
    expect(fixture.api.configure).not.toHaveBeenCalled();
    expect(fixture.api.start).toHaveBeenCalledOnce();
    expect(controls.pending.value).toBe(false);
    expect(controls.state.value?.running).toBe(true);
  });

  it("refreshes after a failed resume and retains the error while polling recovers", async () => {
    vi.useFakeTimers();
    const fixture = setup(true);
    const { controls } = harness();
    await flushPromises();
    fixture.api.start.mockRejectedValueOnce(new Error("Emergency stop is latched."));
    await controls.toggleModule("mana", false);
    expect(controls.state.value?.running).toBe(false);
    expect(controls.state.value?.config.mana.enabled).toBe(false);
    expect(controls.error.value).toBe("Emergency stop is latched.");
    expect(controls.pending.value).toBe(false);
    await vi.advanceTimersByTimeAsync(750);
    expect(controls.error.value).toBe("Emergency stop is latched.");
  });

  it("shows status failures and clears them after a successful refresh", async () => {
    const { api } = setup();
    api.status.mockRejectedValueOnce(new Error("Connection unavailable"));
    const { controls } = harness();
    await flushPromises();
    expect(controls.error.value).toBe("Connection unavailable");
    expect(controls.loading.value).toBe(false);
    await controls.refresh();
    expect(controls.error.value).toBe("");
    expect(controls.state.value).toBeDefined();
  });
});
