// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_TRANSFER_CONFIG } from "../../src/core/voiceTransfer.js";

const mocks = vi.hoisted(() => ({
  game: undefined as unknown,
  runtime: undefined as unknown,
  status: vi.fn(), overview: vi.fn(), runScript: vi.fn(), stopScript: vi.fn(),
  transferStatus: vi.fn(), sortStatus: vi.fn(),
  voiceStatus: vi.fn(), configureVoice: vi.fn(), triggerVoice: vi.fn(), cancelVoice: vi.fn(),
  scriptUnsubscribe: vi.fn(), voiceUnsubscribe: vi.fn(), combatStop: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getStashTabAdminApi: () => ({
    status: mocks.status, runScript: mocks.runScript, stopScript: mocks.stopScript,
    onEvent: () => mocks.scriptUnsubscribe,
  }),
  getShopApi: () => ({ overview: mocks.overview }),
  getStashSortApi: () => ({ status: mocks.sortStatus }),
  getAssistiveApi: () => ({ status: mocks.transferStatus, voice: {
    status: mocks.voiceStatus, configure: mocks.configureVoice,
    trigger: mocks.triggerVoice, cancel: mocks.cancelVoice,
    onState: () => mocks.voiceUnsubscribe,
  } }),
}));
vi.mock("../../src/renderer/composables/useGameActions", () => ({ useGameActions: () => mocks.game }));
vi.mock("../../src/renderer/composables/useRuntimeState", () => ({ useRuntimeState: () => mocks.runtime }));

import { useDashboardActions, type DashboardScriptAction } from "../../src/renderer/composables/useDashboardActions.js";

let wrapper: VueWrapper | undefined;
let actions: ReturnType<typeof useDashboardActions>;
let game: {
  dryRun: Ref<boolean>; busy: Ref<boolean>;
  transferStatus: Ref<{ gridsCalibrated: boolean; searchCalibrated: boolean }>;
};
let runtime: { targetDetected: Ref<boolean>; killLatched: Ref<boolean> };

async function start(): Promise<void> {
  wrapper = mount(defineComponent({
    setup() { actions = useDashboardActions(); return () => h("div"); },
  }));
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.game = {
    dryRun: ref(false), killLatched: ref(false), busy: ref(false),
    transferStatus: ref({ gridsCalibrated: true, searchCalibrated: true }),
    sortStatus: ref({ running: false }),
    refreshGameActions: vi.fn(async () => undefined),
  };
  mocks.runtime = {
    isNative: ref(true), killLatched: ref(false), targetDetected: ref(true),
    error: ref(""), refreshRuntime: vi.fn(async () => undefined),
  };
  game = mocks.game as typeof game;
  runtime = mocks.runtime as typeof runtime;
  mocks.status.mockResolvedValue({ running: false, phase: "idle" });
  mocks.transferStatus.mockImplementation(async () => ({ ...game.transferStatus.value, running: false, killLatched: false }));
  mocks.sortStatus.mockResolvedValue({ running: false, killLatched: false });
  mocks.overview.mockResolvedValue({ config: { shopTab: "Shop" } });
  mocks.runScript.mockResolvedValue({ started: true });
  mocks.stopScript.mockResolvedValue(true);
  mocks.combatStop.mockResolvedValue(undefined);
  mocks.voiceStatus.mockResolvedValue({
    phase: "idle", updatedAt: "2026-09-09T00:00:00Z", hotkeyRegistered: true,
    config: { ...DEFAULT_VOICE_TRANSFER_CONFIG, allowlist: ["SavedGame.exe"], maxItems: 12 },
  });
  mocks.configureVoice.mockImplementation(async (config) => ({ phase: "idle", config }));
  mocks.triggerVoice.mockResolvedValue({ phase: "listening" });
  Object.defineProperty(window, "poe2", { configurable: true, value: { combat: { stop: mocks.combatStop } } });
});

afterEach(() => { wrapper?.unmount(); wrapper = undefined; });

describe("dashboard action controls", () => {
  it("only reads status on mount and releases its listeners", async () => {
    await start();
    expect(actions.loading.value).toBe(false);
    expect(actions.canRunScript("gear-sort")).toBe(true);
    expect(mocks.runScript).not.toHaveBeenCalled();
    expect(mocks.combatStop).not.toHaveBeenCalled();
    wrapper!.unmount(); wrapper = undefined;
    expect(mocks.scriptUnsubscribe).toHaveBeenCalledOnce();
    expect(mocks.voiceUnsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ["gear-sort", "sort-gear"], ["craft", "craft-gear"],
    ["shop-scan", "shop-scan"], ["shop-list", "shop-buckets"],
  ] as Array<[DashboardScriptAction, string]>)("maps %s to the saved preview mode", async (action, kind) => {
    await start();
    game.dryRun.value = true;
    await actions.runScript(action);
    expect(mocks.runScript).toHaveBeenLastCalledWith(`${kind}-dry`);
    expect(mocks.combatStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.runScript.mock.invocationCallOrder[0]);
    game.dryRun.value = false;
    await actions.runScript(action);
    expect(mocks.runScript).toHaveBeenLastCalledWith(kind);
  });

  it("blocks missing targets, emergency stops, running actions and unconfigured shops", async () => {
    await start();
    runtime.targetDetected.value = false;
    await actions.runScript("gear-sort");
    expect(actions.error.value).toMatch(/Start Path of Exile/);
    runtime.targetDetected.value = true;
    runtime.killLatched.value = true;
    expect(actions.canRunScript("gear-sort")).toBe(false);
    runtime.killLatched.value = false;
    game.busy.value = true;
    expect(actions.canRunScript("gear-sort")).toBe(false);
    game.busy.value = false;
    mocks.overview.mockResolvedValue({});
    await actions.refresh();
    expect(actions.canRunScript("shop-list")).toBe(false);
    expect(actions.canRunScript("shop-scan")).toBe(false);
    expect(actions.canRunScript("gear-sort")).toBe(true);
    expect(mocks.runScript).not.toHaveBeenCalled();
  });

  it("rechecks status before dispatch and fails closed when the bridge stops answering", async () => {
    await start();
    mocks.status.mockRejectedValue(new Error("Bridge disconnected"));
    await actions.runScript("gear-sort");
    expect(actions.canRunScript("gear-sort")).toBe(false);
    expect(mocks.runScript).not.toHaveBeenCalled();
    expect(mocks.combatStop).not.toHaveBeenCalled();
  });

  it("does not launch when transfer or voice readiness cannot be refreshed", async () => {
    await start();
    mocks.transferStatus.mockRejectedValueOnce(new Error("Transfer disconnected"));
    await actions.runScript("gear-sort");
    expect(actions.error.value).toMatch(/Transfer disconnected/);
    mocks.voiceStatus.mockRejectedValueOnce(new Error("Voice disconnected"));
    await actions.runScript("gear-sort");
    expect(mocks.runScript).not.toHaveBeenCalled();
    expect(mocks.combatStop).not.toHaveBeenCalled();
  });

  it("serializes a slow launch and reports backend refusal", async () => {
    await start();
    let complete!: (value: { started: boolean; reason?: string }) => void;
    mocks.runScript.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const first = actions.runScript("gear-sort");
    await flushPromises();
    expect(actions.pending.value).toBe(true);
    await actions.runScript("craft");
    expect(mocks.runScript).toHaveBeenCalledOnce();
    complete({ started: false, reason: "busy" });
    await first;
    expect(actions.error.value).toBe("busy");
    expect(actions.pending.value).toBe(false);
  });

  it("requires voice calibration and preserves saved settings while applying global dry-run", async () => {
    await start();
    game.transferStatus.value.searchCalibrated = false;
    expect(actions.canListen.value).toBe(false);
    await actions.listenOnce();
    expect(mocks.triggerVoice).not.toHaveBeenCalled();
    game.transferStatus.value.searchCalibrated = true;
    game.dryRun.value = true;
    await actions.listenOnce();
    expect(mocks.configureVoice).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true, maxItems: 12, allowlist: ["SavedGame.exe"],
      hotkey: DEFAULT_VOICE_TRANSFER_CONFIG.hotkey,
    }));
    expect(mocks.triggerVoice).toHaveBeenCalledOnce();
    expect(mocks.combatStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.triggerVoice.mock.invocationCallOrder[0]);
  });
});
