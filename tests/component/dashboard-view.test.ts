// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, type Ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCombatConfig, type CombatStatus } from "../../src/core/combatAssist.js";

const mocks = vi.hoisted(() => ({
  game: undefined as unknown, runtime: undefined as unknown,
  combat: undefined as unknown, operations: undefined as unknown,
  startAssistive: vi.fn(), sortStash: vi.fn(), runScript: vi.fn(), listen: vi.fn(),
  toggleModule: vi.fn(), startCombat: vi.fn(), stopCombat: vi.fn(), canRunScript: vi.fn(),
}));
vi.mock("../../src/renderer/composables/useGameActions", () => ({ useGameActions: () => mocks.game }));
vi.mock("../../src/renderer/composables/useRuntimeState", () => ({ useRuntimeState: () => mocks.runtime }));
vi.mock("../../src/renderer/composables/useCombatControls", () => ({ useCombatControls: () => mocks.combat }));
vi.mock("../../src/renderer/composables/useDashboardActions", () => ({ useDashboardActions: () => mocks.operations }));

import DashboardView from "../../src/renderer/views/DashboardView.vue";

let wrapper: VueWrapper;
let combat: { state: Ref<CombatStatus | undefined>; available: boolean };
let operations: { pending: Ref<boolean>; scriptStatus: Ref<{ running: boolean; phase: string }> };
let runtime: { isNative: Ref<boolean> };

async function render(): Promise<void> {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/:pathMatch(.*)*", component: defineComponent(() => () => h("div")) },
  ] });
  await router.push("/");
  wrapper = mount(DashboardView, { global: { plugins: [router] } });
  await flushPromises();
}

function button(text: string) {
  const found = wrapper.findAll("button").find((entry) => entry.text() === text);
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  const config = defaultCombatConfig();
  for (const name of ["health", "mana", "unleash", "verisium"] as const) config[name].enabled = true;
  for (const name of ["health", "mana", "unleash", "verisium", "anchor"] as const) {
    config.regions[name] = { x: 10, y: 10, width: 10, height: 10, reference: [1], cooldown: [0] };
  }
  mocks.combat = {
    state: ref<CombatStatus>({ running: false, reason: "Paused", config, actions: 0 }),
    available: true, loading: ref(false), pending: ref(false), error: ref(""), readiness: ref(""),
    toggleModule: mocks.toggleModule, start: mocks.startCombat, stop: mocks.stopCombat,
  };
  mocks.runtime = { isNative: ref(true), killLatched: ref(false), targetDetected: ref(true) };
  mocks.game = {
    dryRun: ref(false), busy: ref(false), canStartEmpty: ref(true), canStartFill: ref(true),
    canStartSort: ref(true), actionError: ref(""), railStatus: ref("Ready"),
    canStop: ref(false), gridsReady: ref(true), transferBlockReason: () => "", sortBlockReason: () => "",
    startAssistive: mocks.startAssistive, sortStash: mocks.sortStash,
  };
  mocks.canRunScript.mockReturnValue(true);
  mocks.operations = {
    scriptStatus: ref({ running: false, phase: "idle" }), pending: ref(false), loading: ref(false),
    error: ref(""), voiceActive: ref(false), canListen: ref(true), shopConfigured: ref(true),
    canRunScript: mocks.canRunScript, scriptBlockReason: () => "", voiceBlockReason: () => "",
    runScript: mocks.runScript, listenOnce: mocks.listen,
  };
  combat = mocks.combat as typeof combat;
  operations = mocks.operations as typeof operations;
  runtime = mocks.runtime as typeof runtime;
});

afterEach(() => wrapper?.unmount());

describe("action dashboard", () => {
  it("shows saved bindings and distinguishes enabled features from running combat", async () => {
    await render();
    expect(wrapper.get(".combat-quick-card.health kbd").text()).toBe("1");
    expect(wrapper.get(".combat-quick-card.mana kbd").text()).toBe("Mouse 5");
    expect(wrapper.get(".combat-quick-card.unleash kbd").text()).toBe("R");
    expect(wrapper.get(".combat-quick-card.verisium kbd").text()).toBe("T");
    expect(wrapper.get(".combat-quick-card.verisium h3").text()).toContain("Powered by Verisium");
    expect(wrapper.findAll('[role="switch"]').every((toggle) => toggle.attributes("aria-checked") === "true")).toBe(true);
    expect(wrapper.findAll(".combat-card-status").map((status) => status.text())).toEqual([
      "Enabled · paused", "Enabled · paused", "Enabled · paused", "Enabled · paused",
    ]);
    expect(button("Start combat").attributes("disabled")).toBeUndefined();
    combat.state.value!.config.health.key = "3";
    combat.state.value!.config.health.threshold = 18;
    await nextTick();
    expect(wrapper.get(".combat-quick-card.health kbd").text()).toBe("3");
    expect(wrapper.get(".combat-quick-card.health p").text()).toBe("Use below 18% life");
  });

  it("hides old resource and cooldown readings when the HUD is invalid", async () => {
    combat.state.value!.running = true;
    combat.state.value!.reading = { valid: true, reason: "Watching HUD", health: 17, mana: 12, unleash: "cooldown", verisium: "ready" };
    await render();
    expect(wrapper.text()).toContain("17% life");
    expect(wrapper.text()).toContain("12% mana");
    expect(wrapper.get(".combat-quick-card.unleash .combat-card-status").text()).toBe("On cooldown");
    expect(wrapper.get(".combat-quick-card.verisium .combat-card-status").text()).toBe("Ready to cast");
    combat.state.value!.reading.valid = false;
    await nextTick();
    expect(wrapper.text()).not.toContain("17% life");
    expect(wrapper.text()).not.toContain("12% mana");
    expect(wrapper.text()).not.toContain("On cooldown");
    expect(wrapper.findAll(".combat-card-status").every((status) => status.text() === "Waiting for game HUD")).toBe(true);
  });

  it("shows the manual macro as armed without asking for skill calibration", async () => {
    combat.state.value!.config.sigilSequence.enabled = true;
    combat.state.value!.config.health.enabled = combat.state.value!.config.mana.enabled = false;
    combat.state.value!.config.regions = {};
    await render();
    expect(wrapper.get(".combat-quick-card.unleash .combat-card-status").text()).toBe("Macro enabled · paused");
    expect(wrapper.text()).not.toContain("Needs calibration");
    expect(button("Arm macro").attributes("disabled")).toBeUndefined();
    expect(wrapper.get('.combat-quick-card.unleash [role="switch"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('.combat-quick-card.verisium [role="switch"]').attributes("disabled")).toBeDefined();
    combat.state.value!.running = true;
    await nextTick();
    expect(wrapper.get(".dashboard-badge").text()).toBe("Armed");
    expect(wrapper.get(".combat-quick-card.unleash .combat-card-status").text()).toBe("Armed · press R");
    expect(wrapper.get(".combat-quick-card.verisium .combat-card-status").text()).toBe("Part of manual macro");
    expect(wrapper.text()).toContain("Press R → X → T · one cycle");
    expect(wrapper.text()).not.toContain("Cast as soon as it is ready");
  });

  it("keeps stash and combat starts disabled while a workflow is starting or running", async () => {
    operations.pending.value = true;
    await render();
    expect(wrapper.findAll(".stash-quick-action").every((entry) => entry.attributes("disabled") !== undefined)).toBe(true);
    expect(button("Start combat").attributes("disabled")).toBeDefined();
    operations.pending.value = false;
    operations.scriptStatus.value = { running: true, phase: "applying" };
    await nextTick();
    expect(wrapper.findAll(".stash-quick-action").every((entry) => entry.attributes("disabled") !== undefined)).toBe(true);
    operations.scriptStatus.value.running = false;
    await nextTick();
    expect(wrapper.findAll(".stash-quick-action").every((entry) => entry.attributes("disabled") === undefined)).toBe(true);
  });

  it("forwards quick controls to the existing action hooks", async () => {
    await render();
    const stashButtons = wrapper.findAll(".stash-quick-action");
    for (const entry of stashButtons) await entry.trigger("click");
    expect(mocks.startAssistive.mock.calls).toEqual([[{ kind: "empty" }], [{ kind: "fill" }], [{ kind: "two-cycle" }]]);
    expect(mocks.sortStash).toHaveBeenCalledOnce();
    await wrapper.get('.combat-quick-card.health [role="switch"]').trigger("click");
    expect(mocks.toggleModule).toHaveBeenCalledWith("health");
    await wrapper.get('.combat-quick-card.verisium [role="switch"]').trigger("click");
    expect(mocks.toggleModule).toHaveBeenCalledWith("verisium");
    await button("Start combat").trigger("click");
    expect(mocks.startCombat).toHaveBeenCalledOnce();
    for (const card of wrapper.findAll(".dashboard-workflow-card")) await card.get("button").trigger("click");
    expect(mocks.runScript.mock.calls).toEqual([["gear-sort"], ["craft"], ["shop-scan"], ["shop-list"]]);
    await button("Listen").trigger("click");
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it("disables native action controls when there is no desktop bridge", async () => {
    runtime.isNative.value = false;
    combat.available = false;
    combat.state.value = undefined;
    mocks.canRunScript.mockReturnValue(false);
    (mocks.operations as { canListen: Ref<boolean> }).canListen.value = false;
    await render();
    expect(wrapper.findAll("button").every((entry) => entry.attributes("disabled") !== undefined)).toBe(true);
    expect(mocks.startAssistive).not.toHaveBeenCalled();
    expect(mocks.startCombat).not.toHaveBeenCalled();
  });

  it("links directly to calibration, transfer, scanner and hotkey tools", async () => {
    await render();
    const links = wrapper.findAll("a").map((link) => link.attributes("href"));
    expect(links).toEqual(expect.arrayContaining([
      "/tools/combat", "/tools/transfers", "/items#scans", "/tools/stash-tabs", "/tools/hotkeys",
    ]));
  });
});
