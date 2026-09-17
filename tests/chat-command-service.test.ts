import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WinReply } from "../src/adapters/winHost.js";
import { defaultCombatConfig } from "../src/core/combatAssist.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { CombatAssistService } from "../src/main/combatAssistService.js";
import {
  COPY_HOVERED_POLL_MS,
  COPY_HOVERED_TIMEOUT_MS,
  ChatCommandServiceImpl,
  chatTraceFile,
  chatHostBusyReason,
  type ChatCommandServiceOptions,
  type ChatHost,
  type ChatTraceEntry,
} from "../src/main/chatCommandService.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { chatCommandsModule } from "../src/main/features/chatCommands/index.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type {
  ChatCommandOutcome,
  ChatCommandSettings,
  ChatCommandStatus,
  ChatCopyOutcome,
} from "../src/shared/chatCommands.js";

interface FakeHostOptions {
  rect?: Partial<WinReply>;
  /** Per-op reply override; a function may mutate test state (e.g. trip the kill switch). */
  reply?: (payload: Record<string, unknown>, index: number) => WinReply | undefined;
  onSend?: (payload: Record<string, unknown>) => void;
}

function fakeHost(options: FakeHostOptions = {}) {
  const ops: Array<Record<string, unknown>> = [];
  const hosts: Array<{ closed: boolean }> = [];
  const factory = (): ChatHost => {
    const record = { closed: false };
    hosts.push(record);
    return {
      async send(payload) {
        if (record.closed) throw new Error("win-input-host-closed");
        ops.push(payload);
        options.onSend?.(payload);
        const override = options.reply?.(payload, ops.length - 1);
        if (override) return override;
        if (payload.op === "rect") {
          return { ok: true, process: "PathOfExileSteam", hwnd: 4242, foregroundIsPoe: true, ...options.rect };
        }
        if (payload.op === "focus") return { ok: true, focused: true, process: "PathOfExileSteam", hwnd: 4242 };
        if (payload.op === "hotkey" || payload.op === "type") return { ok: true, focused: true };
        return { ok: false, error: `unexpected-${String(payload.op)}` };
      },
      async close() {
        record.closed = true;
      },
    };
  };
  return { factory, ops, hosts, opNames: () => ops.map((op) => (op.op === "hotkey" ? `hotkey:${String(op.keys)}` : String(op.op))) };
}

const ITEM_TEXT = "Item Class: Belts\nRarity: Rare\nGhoul Lash\nLong Belt";

/**
 * A fake host that behaves like the real clipboard ops in
 * scripts/win-input-host.ps1: `clipboard` reads, `setclipboard` writes, and
 * `hotkey ctrlc` makes the "game" drop `itemText` on the clipboard after
 * `afterPolls` reads (never, when `itemText` is undefined).
 */
function clipboardHost(script: { initial?: string; itemText?: string; afterPolls?: number } = {}) {
  const state = { clipboard: script.initial ?? "a shopping list", polls: 0, copied: false };
  const host = fakeHost({
    reply: (payload) => {
      if (payload.op === "clipboard") {
        if (state.copied) {
          state.polls += 1;
          if (script.itemText !== undefined && state.polls >= (script.afterPolls ?? 1)) {
            state.clipboard = script.itemText;
          }
        }
        return { ok: true, text: state.clipboard };
      }
      if (payload.op === "setclipboard") {
        state.clipboard = String(payload.text ?? "");
        return { ok: true };
      }
      if (payload.op === "hotkey" && payload.keys === "ctrlc") {
        state.copied = true;
        return { ok: true, focused: true };
      }
      return undefined;
    },
  });
  return { ...host, state };
}

function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function makeService(overrides: Partial<ChatCommandServiceOptions> & { host?: ReturnType<typeof fakeHost> } = {}) {
  const host = overrides.host ?? fakeHost();
  const traces: ChatTraceEntry[] = [];
  const outcomes: ChatCommandOutcome[] = [];
  const statuses: ChatCommandStatus[] = [];
  const state = {
    latched: false,
    dryRun: false,
    settings: { enabled: true, idleCloseMs: 60_000, maxPerMinute: 30 } as ChatCommandSettings,
    otherHost: false,
    searchKey: undefined as number | undefined,
    probeCalls: 0,
  };
  const c = clock();
  const { host: _ignored, ...rest } = overrides;
  const service = new ChatCommandServiceImpl({
    userDataDir: "C:/fake-user",
    buildMode: "authorized-qa",
    killSwitchLatched: () => state.latched,
    dryRun: () => state.dryRun,
    settings: () => state.settings,
    hostFactory: host.factory,
    otherHostRunning: async () => {
      state.probeCalls += 1;
      return state.otherHost;
    },
    searchKey: () => state.searchKey,
    now: c.now,
    // No real timers in the clipboard poll: the fake sleep moves the fake clock.
    sleep: async (ms: number) => {
      c.advance(ms);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    onStatus: (status) => statuses.push(status),
    appendTrace: (_file, line) => traces.push(JSON.parse(line) as ChatTraceEntry),
    ...rest,
  });
  return { service, host, traces, outcomes, statuses, state, clock: c };
}

const request = { text: "/invite Buyer", reason: "invite buyer", source: "trade" as const };

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatCommandService.send", () => {
  it("types exactly one line: rect, Enter, text, Enter — each foreground-checked against the pinned window", async () => {
    const { service, host, traces, outcomes, statuses } = makeService();
    const outcome = await service.send(request);
    expect(outcome).toEqual({ ok: true, dryRun: false, sent: "/invite Buyer", at: "2023-11-14T22:13:20.000Z" });
    expect(host.opNames()).toEqual(["rect", "hotkey:enter", "type", "hotkey:enter"]);
    expect(host.ops[1]).toEqual({ op: "hotkey", keys: "enter", expectedHwnd: "4242", requireForeground: true });
    expect(host.ops[2]).toEqual({ op: "type", text: "/invite Buyer", expectedHwnd: "4242", requireForeground: true });
    expect(traces).toEqual([
      {
        timestamp: "2023-11-14T22:13:20.000Z",
        type: "chat-command",
        scenarioId: "chat-commands",
        module: "chat",
        mode: "authorized-qa",
        kind: "send",
        source: "trade",
        decisionRule: "one-chat-line-per-user-gesture",
        input: "/invite Buyer",
        result: "emitted",
        reason: "invite buyer",
        hostOps: ["rect", "hotkey:enter", "type", "hotkey:enter"],
      },
    ]);
    expect(outcomes).toEqual([outcome]);
    expect(statuses.at(-1)).toEqual({
      enabled: true,
      hostRunning: true,
      lastOutcome: outcome,
      sentThisMinute: 1,
      maxPerMinute: 30,
      dryRun: false,
    });
    expect(service.status()).toEqual(statuses.at(-1));
  });

  it("refuses while the kill switch is latched without starting a host", async () => {
    const { service, host, state, traces } = makeService();
    state.latched = true;
    const outcome = await service.send(request);
    expect(outcome).toMatchObject({ ok: false, dryRun: false, blockedBy: "kill-switch", sent: "/invite Buyer" });
    expect(host.hosts).toHaveLength(0);
    expect(traces[0]).toMatchObject({ result: "blocked", blockedBy: "kill-switch", hostOps: [] });
  });

  it("refuses when disabled in settings", async () => {
    const { service, host, state } = makeService();
    state.settings = { ...state.settings, enabled: false };
    expect(await service.send(request)).toMatchObject({ ok: false, blockedBy: "disabled" });
    expect(host.hosts).toHaveLength(0);
    expect(service.status().enabled).toBe(false);
  });

  it("dry-run answers with the would-be line, starts no host, and costs no budget", async () => {
    const { service, host, state, traces } = makeService();
    state.dryRun = true;
    const outcome = await service.send({ ...request, text: "  /hideout Seller  " });
    expect(outcome).toEqual({ ok: true, dryRun: true, sent: "/hideout Seller", at: expect.any(String) });
    expect(host.hosts).toHaveLength(0);
    expect(traces[0]).toMatchObject({ result: "dry-run", input: "/hideout Seller", hostOps: [] });
    expect(service.status()).toMatchObject({ sentThisMinute: 0, hostRunning: false, dryRun: true });
  });

  it("dry-run still applies the text rules", async () => {
    const { service, state } = makeService();
    state.dryRun = true;
    expect(await service.send({ ...request, text: "" })).toMatchObject({ ok: false, blockedBy: "empty" });
  });

  it("refuses empty, too-long, unresolved and untypable text before touching the host", async () => {
    const { service, host } = makeService();
    expect(await service.send({ ...request, text: "   " })).toMatchObject({ blockedBy: "empty" });
    expect(await service.send({ ...request, text: "x".repeat(301) })).toMatchObject({
      blockedBy: "too-long",
      error: expect.stringContaining("301"),
    });
    expect(await service.send({ ...request, text: "/invite {player}" })).toMatchObject({
      blockedBy: "empty",
      error: expect.stringContaining("{player}"),
    });
    expect(await service.send({ ...request, text: "@Zoë hi" })).toMatchObject({
      blockedBy: "empty",
      error: expect.stringContaining('"ë"'),
    });
    expect(await service.send({ ...request, text: "a\nb" })).toMatchObject({ blockedBy: "empty" });
    expect(host.hosts).toHaveLength(0);
  });

  it("rate-limits a second line inside 400 ms and the per-minute budget from settings", async () => {
    const { service, host, state, clock: c } = makeService();
    state.settings = { ...state.settings, maxPerMinute: 2 };
    expect((await service.send(request)).ok).toBe(true);
    expect(await service.send(request)).toMatchObject({
      ok: false,
      blockedBy: "rate-limit",
      error: expect.stringContaining("400 ms"),
    });
    c.advance(400);
    expect((await service.send(request)).ok).toBe(true);
    c.advance(400);
    expect(await service.send(request)).toMatchObject({
      ok: false,
      blockedBy: "rate-limit",
      error: expect.stringContaining("per-minute"),
    });
    expect(service.status()).toMatchObject({ sentThisMinute: 2, maxPerMinute: 2 });
    expect(host.opNames().filter((name) => name === "type")).toHaveLength(2);
  });

  it("refuses while another input host is running and probes only when it has no host of its own", async () => {
    const { service, host, state, clock: c } = makeService();
    state.otherHost = true;
    expect(await service.send(request)).toMatchObject({ ok: false, blockedBy: "another-host" });
    expect(host.hosts).toHaveLength(0);
    expect(state.probeCalls).toBe(1);
    state.otherHost = false;
    expect((await service.send(request)).ok).toBe(true);
    // Host already running: no further probe, the line goes through.
    state.otherHost = true;
    c.advance(400);
    expect((await service.send(request)).ok).toBe(true);
    expect(state.probeCalls).toBe(2);
    expect(host.hosts).toHaveLength(1);
  });

  it("blocks combat while the chat host is warm and permits arming after its idle close", async () => {
    vi.useFakeTimers();
    const { service, state, host } = makeService();
    const config = defaultCombatConfig();
    config.unleash.enabled = config.verisium.enabled = config.sigilSequence.enabled = true;
    const combatHost = {
      send: vi.fn(async (): Promise<WinReply> => ({ ok: false, error: "Focus Path of Exile 2 to continue" })),
      close: vi.fn(async () => {}),
    };
    combatHost.send.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });
    const createHost = vi.fn(() => combatHost);
    const combat = new CombatAssistService({
      config, killSwitch: new KillSwitch(), mode: "public-companion", audit: () => {}, createHost,
      blocked: () => chatHostBusyReason(service),
    });
    try {
      expect((await service.send(request)).ok).toBe(true);
      await expect(combat.start()).rejects.toThrow("chat input host to go idle");
      expect(createHost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(state.settings.idleCloseMs - 1);
      await expect(combat.start()).rejects.toThrow("chat input host to go idle");
      await vi.advanceTimersByTimeAsync(1);
      expect(host.hosts[0].closed).toBe(true);
      await expect(combat.start()).resolves.toMatchObject({ running: true });
      expect(createHost).toHaveBeenCalledOnce();
    } finally {
      combat.stop();
      await service.dispose();
    }
  });

  it("maps host window answers to not-foreground / process-not-allowed and keeps the host for next time", async () => {
    const missing = makeService({ host: fakeHost({ reply: (p) => (p.op === "rect" ? { ok: false, error: "no-poe-window" } : undefined) }) });
    expect(await missing.service.send(request)).toMatchObject({
      blockedBy: "not-foreground",
      error: expect.stringContaining("no-poe-window"),
    });
    expect(missing.host.opNames()).toEqual(["rect"]);
    expect(missing.service.status().hostRunning).toBe(true);

    const background = makeService({ host: fakeHost({ rect: { foregroundIsPoe: false } }) });
    expect(await background.service.send(request)).toMatchObject({ blockedBy: "not-foreground" });
    expect(background.host.opNames()).toEqual(["rect"]);

    const notepad = makeService({ host: fakeHost({ rect: { process: "notepad" } }) });
    expect(await notepad.service.send(request)).toMatchObject({
      blockedBy: "process-not-allowed",
      error: expect.stringContaining("notepad"),
    });
    expect(notepad.host.opNames()).toEqual(["rect"]);
    expect(notepad.service.status().sentThisMinute).toBe(0);
  });

  it("accepts every allowlisted process name, with or without .exe and case", async () => {
    for (const process of ["PathOfExile.exe", "pathofexile_x64steam", "PATHOFEXILESTEAM"]) {
      const { service } = makeService({ host: fakeHost({ rect: { process } }) });
      expect((await service.send(request)).ok).toBe(true);
    }
  });

  it("reports a host refusal as host-error, closes the host, and says how far it got", async () => {
    const { service, host } = makeService({
      host: fakeHost({ reply: (p) => (p.op === "type" ? { ok: false, error: "unsupported-hotkey" } : undefined) }),
    });
    const outcome = await service.send(request);
    expect(outcome).toMatchObject({
      ok: false,
      blockedBy: "host-error",
      error: "unsupported-hotkey (stopped after 1 of 3 keys; the chat box may still be open)",
    });
    expect(host.opNames()).toEqual(["rect", "hotkey:enter", "type"]);
    expect(host.hosts[0]?.closed).toBe(true);
    expect(service.status().hostRunning).toBe(false);
    // Budget was spent: input was generated.
    expect(service.status().sentThisMinute).toBe(1);
  });

  it("treats a mid-sequence focus loss as not-foreground", async () => {
    const { service, host } = makeService({
      host: fakeHost({ reply: (p) => (p.op === "type" ? { ok: false, error: "focus-lost", focused: false } : undefined) }),
    });
    expect(await service.send(request)).toMatchObject({ blockedBy: "not-foreground", error: expect.stringContaining("focus-lost") });
    expect(host.hosts[0]?.closed).toBe(false);
  });

  it("stops before the next key when the kill switch latches mid-sequence", async () => {
    const state = { latched: false };
    const host = fakeHost({
      onSend: (p) => {
        if (p.op === "hotkey") state.latched = true;
      },
    });
    const { service } = makeService({ host, killSwitchLatched: () => state.latched });
    const outcome = await service.send(request);
    expect(outcome).toMatchObject({ ok: false, blockedBy: "kill-switch" });
    expect(outcome.error).toContain("stopped after 1 of 3 keys");
    expect(host.opNames()).toEqual(["rect", "hotkey:enter"]);
  });

  it("brings the game to the front first when the request asks for focus", async () => {
    const { service, host } = makeService();
    expect((await service.send({ ...request, focus: true })).ok).toBe(true);
    expect(host.opNames()).toEqual(["focus", "rect", "hotkey:enter", "type", "hotkey:enter"]);
    const refused = makeService({ host: fakeHost({ reply: (p) => (p.op === "focus" ? { ok: true, focused: false } : undefined) }) });
    expect(await refused.service.send({ ...request, focus: true })).toMatchObject({ blockedBy: "not-foreground" });
    expect(refused.host.opNames()).toEqual(["focus"]);
  });

  it("surfaces a thrown host as host-error and drops it", async () => {
    const host = fakeHost({
      reply: () => {
        throw new Error("win-input-host-exited:1");
      },
    });
    const { service } = makeService({ host });
    expect(await service.send(request)).toMatchObject({ blockedBy: "host-error", error: "win-input-host-exited:1" });
    expect(host.hosts[0]?.closed).toBe(true);
    expect(service.status().hostRunning).toBe(false);
  });

  it("serializes concurrent gestures so keystrokes never interleave", async () => {
    const { service, host, clock: c } = makeService({
      host: fakeHost({
        onSend: () => {
          c.advance(150);
        },
      }),
    });
    const [first, second] = await Promise.all([service.send(request), service.send({ ...request, text: "/kick Buyer" })]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(host.opNames()).toEqual([
      "rect",
      "hotkey:enter",
      "type",
      "hotkey:enter",
      "rect",
      "hotkey:enter",
      "type",
      "hotkey:enter",
    ]);
    expect(host.ops.map((op) => op.text).filter(Boolean)).toEqual(["/invite Buyer", "/kick Buyer"]);
  });
});

describe("ChatCommandService.stashSearch", () => {
  it("opens the search box with Ctrl+F, types, and confirms with Enter", async () => {
    const { service, host, traces } = makeService();
    const outcome = await service.stashSearch("class: belt", "highlight the sold item");
    expect(outcome).toMatchObject({ ok: true, sent: "class: belt" });
    expect(host.opNames()).toEqual(["rect", "hotkey:ctrlf", "type", "hotkey:enter"]);
    expect(traces[0]).toMatchObject({ kind: "stash-search", source: "stash-search", reason: "highlight the sold item" });
  });

  it("uses the game's configured search key when the client log knows it", async () => {
    const { service, host, state } = makeService();
    state.searchKey = 0x53;
    await service.stashSearch("ilvl", "x");
    expect(host.opNames()[1]).toBe("hotkey:ctrls");
  });

  it("applies the same guards", async () => {
    const { service, state, host } = makeService();
    state.latched = true;
    expect(await service.stashSearch("x", "y")).toMatchObject({ blockedBy: "kill-switch" });
    state.latched = false;
    expect(await service.stashSearch("", "y")).toMatchObject({ blockedBy: "empty" });
    expect(host.hosts).toHaveLength(0);
  });

  it("brings the game to the front first when options.focus is set, then verifies", async () => {
    const { service, host } = makeService();
    expect((await service.stashSearch("class: belt", "highlight", { focus: true })).ok).toBe(true);
    expect(host.opNames()).toEqual(["focus", "rect", "hotkey:ctrlf", "type", "hotkey:enter"]);
  });

  it("omits the focus op without the option, and when the option is false", async () => {
    const { service, host, clock: c } = makeService();
    expect((await service.stashSearch("a", "r")).ok).toBe(true);
    c.advance(400);
    expect((await service.stashSearch("b", "r", {})).ok).toBe(true);
    c.advance(400);
    expect((await service.stashSearch("c", "r", { focus: false })).ok).toBe(true);
    expect(host.opNames().filter((name) => name === "focus")).toHaveLength(0);
  });

  it("reports a refused focus as not-foreground before any key", async () => {
    const refused = makeService({
      host: fakeHost({ reply: (p) => (p.op === "focus" ? { ok: true, focused: false } : undefined) }),
    });
    expect(await refused.service.stashSearch("x", "y", { focus: true })).toMatchObject({
      blockedBy: "not-foreground",
    });
    expect(refused.host.opNames()).toEqual(["focus"]);
  });
});

describe("ChatCommandService.copyHoveredItem", () => {
  const copyRequest = { reason: "evaluate hovered item", source: "evaluate" as const };

  it("parks a sentinel, presses Ctrl+C once, polls until the item text lands, and leaves it on the clipboard", async () => {
    const host = clipboardHost({ initial: "a shopping list", itemText: ITEM_TEXT, afterPolls: 2 });
    const { service, traces, outcomes } = makeService({ host });
    const outcome = await service.copyHoveredItem(copyRequest);
    expect(outcome).toEqual({ ok: true, dryRun: false, at: "2023-11-14T22:13:20.000Z", text: ITEM_TEXT });
    expect(host.opNames()).toEqual([
      "rect",
      "clipboard",
      "setclipboard",
      "hotkey:ctrlc",
      "clipboard",
      "clipboard",
    ]);
    // Every op is pinned to the window `rect` confirmed, so the host never
    // focuses the game on its own.
    for (const op of host.ops.slice(1)) {
      expect(op).toMatchObject({ expectedHwnd: "4242", requireForeground: true });
    }
    const sentinel = String(host.ops[2]?.text ?? "");
    expect(sentinel).toMatch(/^poe2-trade-companion:copy-hovered:/);
    expect(host.state.clipboard).toBe(ITEM_TEXT);
    expect(traces).toEqual([
      {
        timestamp: "2023-11-14T22:13:20.000Z",
        type: "chat-command",
        scenarioId: "chat-commands",
        module: "chat",
        mode: "authorized-qa",
        kind: "copy-hovered",
        source: "evaluate",
        decisionRule: "one-chat-line-per-user-gesture",
        input: "ctrl+c",
        result: "emitted",
        reason: "evaluate hovered item",
        hostOps: ["rect", "clipboard", "setclipboard", "hotkey:ctrlc", "clipboard", "clipboard"],
      },
    ]);
    // The item text never reaches the trace, the status or the chat:sent event.
    expect(JSON.stringify(traces)).not.toContain("Ghoul Lash");
    expect(outcomes).toEqual([{ ok: true, dryRun: false, at: "2023-11-14T22:13:20.000Z" }]);
    expect(service.status().lastOutcome).not.toHaveProperty("text");
    expect(service.status().sentThisMinute).toBe(1);
  });

  it("stops polling at the first item text", async () => {
    const host = clipboardHost({ itemText: ITEM_TEXT, afterPolls: 1 });
    const { service } = makeService({ host });
    expect((await service.copyHoveredItem(copyRequest)).text).toBe(ITEM_TEXT);
    expect(host.opNames().filter((name) => name === "clipboard")).toHaveLength(2);
    expect(host.state.polls).toBe(1);
  });

  it("ignores a clipboard that still holds the sentinel and a non-item clipboard", async () => {
    // The game answers with something that is not item text: still a timeout.
    const host = clipboardHost({ initial: "note to self", itemText: "just some words" });
    const { service } = makeService({ host });
    expect(await service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "timeout" });
    expect(host.state.clipboard).toBe("note to self");
  });

  it("restores the clipboard and answers timeout when the game never copies anything", async () => {
    const host = clipboardHost({ initial: "a shopping list" });
    const { service, traces, clock: c } = makeService({ host });
    const outcome = await service.copyHoveredItem({ reason: "inspect", source: "inspect" });
    expect(outcome).toMatchObject({
      ok: false,
      dryRun: false,
      blockedBy: "timeout",
      error: expect.stringContaining(String(COPY_HOVERED_TIMEOUT_MS)),
    });
    expect(outcome).not.toHaveProperty("text");
    const polls = Math.ceil(COPY_HOVERED_TIMEOUT_MS / COPY_HOVERED_POLL_MS) + 1;
    expect(host.state.polls).toBe(polls);
    // One read before the sentinel plus the polls; the restore is the last op.
    expect(host.opNames().filter((name) => name === "clipboard")).toHaveLength(polls + 1);
    expect(host.opNames().at(-1)).toBe("setclipboard");
    expect(host.ops.at(-1)).toEqual({
      op: "setclipboard",
      text: "a shopping list",
      expectedHwnd: "4242",
      requireForeground: true,
    });
    expect(host.state.clipboard).toBe("a shopping list");
    // A timeout is not a host failure: the host stays for the next gesture.
    expect(host.hosts[0]?.closed).toBe(false);
    expect(traces[0]).toMatchObject({ kind: "copy-hovered", result: "blocked", blockedBy: "timeout", source: "inspect" });
    // The poll window is bounded by the clock, not by the op count.
    expect(c.now() - 1_700_000_000_000).toBeGreaterThanOrEqual(COPY_HOVERED_TIMEOUT_MS);
  });

  it("puts the clipboard back when the kill switch latches during the poll", async () => {
    const host = clipboardHost({ initial: "a shopping list" });
    const state = { latched: false };
    const { service } = makeService({
      host,
      killSwitchLatched: () => state.latched,
      sleep: async () => {
        state.latched = true;
      },
    });
    const outcome = await service.copyHoveredItem(copyRequest);
    expect(outcome).toMatchObject({ ok: false, blockedBy: "kill-switch" });
    expect(host.state.clipboard).toBe("a shopping list");
    expect(host.opNames().at(-1)).toBe("setclipboard");
  });

  it("dry-run starts no host and answers from this process's clipboard", async () => {
    const host = clipboardHost({ itemText: ITEM_TEXT });
    const { service, state, traces } = makeService({ host, readClipboard: () => ITEM_TEXT });
    state.dryRun = true;
    const outcome = await service.copyHoveredItem(copyRequest);
    expect(outcome).toEqual({ ok: true, dryRun: true, at: expect.any(String), text: ITEM_TEXT });
    expect(host.hosts).toHaveLength(0);
    expect(traces[0]).toMatchObject({ kind: "copy-hovered", result: "dry-run", input: "ctrl+c", hostOps: [] });
    expect(service.status()).toMatchObject({ sentThisMinute: 0, hostRunning: false, dryRun: true });
  });

  it("dry-run reports no text when the clipboard holds something else, or cannot be read", async () => {
    const withJunk = makeService({ readClipboard: () => "a shopping list" });
    withJunk.state.dryRun = true;
    expect(await withJunk.service.copyHoveredItem(copyRequest)).toEqual({
      ok: true,
      dryRun: true,
      at: expect.any(String),
    });
    const withoutReader = makeService();
    withoutReader.state.dryRun = true;
    const outcome: ChatCopyOutcome = await withoutReader.service.copyHoveredItem(copyRequest);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBeUndefined();
  });

  it("applies the send gates: kill switch, disabled, another host, foreground and the allowlist", async () => {
    const latched = makeService({ host: clipboardHost() });
    latched.state.latched = true;
    expect(await latched.service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "kill-switch" });
    expect(latched.host.hosts).toHaveLength(0);

    const off = makeService({ host: clipboardHost() });
    off.state.settings = { ...off.state.settings, enabled: false };
    expect(await off.service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "disabled" });
    expect(off.host.hosts).toHaveLength(0);

    const busy = makeService({ host: clipboardHost() });
    busy.state.otherHost = true;
    expect(await busy.service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "another-host" });
    expect(busy.host.hosts).toHaveLength(0);

    const background = makeService({ host: fakeHost({ rect: { foregroundIsPoe: false } }) });
    expect(await background.service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "not-foreground" });
    expect(background.host.opNames()).toEqual(["rect"]);

    const notepad = makeService({ host: fakeHost({ rect: { process: "notepad" } }) });
    expect(await notepad.service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "process-not-allowed" });
    expect(notepad.host.opNames()).toEqual(["rect"]);
    expect(notepad.service.status().sentThisMinute).toBe(0);
  });

  it("shares the rate limiter with chat lines", async () => {
    const host = clipboardHost({ itemText: ITEM_TEXT });
    const { service, clock: c } = makeService({ host });
    expect((await service.send(request)).ok).toBe(true);
    expect(await service.copyHoveredItem(copyRequest)).toMatchObject({ blockedBy: "rate-limit" });
    c.advance(400);
    expect((await service.copyHoveredItem(copyRequest)).ok).toBe(true);
  });

  it("surfaces a refused Ctrl+C as host-error and still puts the clipboard back", async () => {
    const host = clipboardHost({ initial: "a shopping list" });
    const broken = makeService({
      host: {
        ...host,
        factory: () => {
          const inner = host.factory();
          return {
            async send(payload) {
              if (payload.op === "hotkey" && payload.keys === "ctrlc") {
                host.ops.push(payload);
                return { ok: false, error: "unsupported-hotkey" };
              }
              return inner.send(payload);
            },
            close: () => inner.close(),
          };
        },
      },
    });
    expect(await broken.service.copyHoveredItem(copyRequest)).toMatchObject({
      blockedBy: "host-error",
      error: "unsupported-hotkey",
    });
    expect(host.state.clipboard).toBe("a shopping list");
  });
});

describe("host lifecycle", () => {
  it("closes the idle host after idleCloseMs, announces it, and restarts on the next gesture", async () => {
    vi.useFakeTimers();
    const { service, host, statuses, state, clock: c } = makeService();
    state.settings = { ...state.settings, idleCloseMs: 5_000 };
    await service.send(request);
    expect(host.hosts).toHaveLength(1);
    expect(service.status().hostRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(host.hosts[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.hosts[0]?.closed).toBe(true);
    expect(statuses.at(-1)?.hostRunning).toBe(false);
    c.advance(5_000);
    await service.send(request);
    expect(host.hosts).toHaveLength(2);
    // Each attempt re-arms the timer.
    await vi.advanceTimersByTimeAsync(3_000);
    c.advance(3_000);
    await service.send(request);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(host.hosts[1]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.hosts[1]?.closed).toBe(true);
  });

  it("dispose closes the host and refuses afterwards", async () => {
    const { service, host, clock: c } = makeService();
    await service.send(request);
    await service.dispose();
    expect(host.hosts[0]?.closed).toBe(true);
    c.advance(400);
    expect(await service.send(request)).toMatchObject({ blockedBy: "host-error", error: expect.stringContaining("disposed") });
    expect(host.hosts).toHaveLength(1);
  });

  it("appends the trace to <userData>/assistive-artifacts/qa-action-trace.jsonl", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chat-trace-"));
    try {
      const host = fakeHost();
      const service = new ChatCommandServiceImpl({
        userDataDir: dir,
        buildMode: "public-companion",
        killSwitchLatched: () => false,
        dryRun: () => true,
        settings: () => ({ enabled: true, idleCloseMs: 60_000, maxPerMinute: 30 }),
        hostFactory: host.factory,
        otherHostRunning: async () => false,
      });
      await service.send(request);
      await service.send({ ...request, text: "" });
      const file = chatTraceFile(dir);
      expect(file).toBe(path.join(dir, "assistive-artifacts", "qa-action-trace.jsonl"));
      const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ChatTraceEntry);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ module: "chat", mode: "public-companion", result: "dry-run", input: "/invite Buyer" });
      expect(lines[1]).toMatchObject({ result: "blocked", blockedBy: "empty" });
      expect(host.hosts).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps working when the trace cannot be written", async () => {
    const warnings: string[] = [];
    const { service } = makeService({
      appendTrace: () => {
        throw new Error("disk full");
      },
      log: (_level, message) => warnings.push(message),
    });
    expect((await service.send(request)).ok).toBe(true);
    expect(warnings).toEqual(["chat trace append failed"]);
  });
});

describe("chatCommands feature module", () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    };
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    };
    return { ipc, invoke };
  }

  function fakeWindow() {
    const sent: Array<[string, unknown]> = [];
    return {
      sent,
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    };
  }

  it("registers the service, channels, settings namespace and events", async () => {
    const { ipc, invoke } = fakeIpc();
    const files = new Map<string, string>();
    const settings = new SettingsStore({
      file: "s.json",
      fs: { read: (f) => files.get(f), write: (f, t) => void files.set(f, t) },
    });
    const main = fakeWindow();
    let latched = false;
    const rt = createFeatureRuntime({
      ipcMain: ipc,
      configDir: "C:/cfg",
      userDataDir: "C:/user",
      repoRoot: "C:/repo",
      buildMode: "authorized-qa",
      core: {} as never,
      settings,
      mainWindow: () => main as never,
      poeWindows: async () => [],
      killSwitchLatched: () => latched,
      notify: vi.fn(),
      clipboard: { readText: () => "", writeText: vi.fn() },
      openExternal: async () => undefined,
      log: vi.fn(),
    });
    const result = await rt.register([chatCommandsModule]);
    expect(result).toEqual({ registered: ["chatCommands"], failed: [] });
    expect(rt.ctx.require("chatCommands")).toBeDefined();
    expect(await invoke("app:feature-channels")).toEqual(expect.arrayContaining(["chat:send", "chat:stash-search", "chat:status", "chat:resolve"]));
    expect(await invoke("settings:get")).toEqual({ "chat-commands": { enabled: true, idleCloseMs: 60_000, maxPerMinute: 30 } });
    expect(await invoke("chat:resolve", "/invite {player}", { player: "Buyer" })).toBe("/invite Buyer");
    expect(await invoke("chat:status")).toEqual({ enabled: true, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false });

    // No host may ever start in tests: only host-free paths are exercised here.
    latched = true;
    const blocked = (await invoke("chat:send", request)) as ChatCommandOutcome;
    expect(blocked).toMatchObject({ blockedBy: "kill-switch" });
    latched = false;
    await invoke("app:set-dry-run", true);
    const dry = (await invoke("chat:send", request)) as ChatCommandOutcome;
    expect(dry).toMatchObject({ ok: true, dryRun: true, sent: "/invite Buyer" });
    expect(await invoke("chat:stash-search", "class: belt", "why")).toMatchObject({ ok: true, dryRun: true });
    expect(main.sent.filter(([channel]) => channel === "chat:sent")).toHaveLength(3);
    expect(main.sent.filter(([channel]) => channel === "chat:status")).toHaveLength(3);

    await invoke("settings:set", "chat-commands", { enabled: false, maxPerMinute: 500 });
    expect(await invoke("chat:status")).toMatchObject({ enabled: false, maxPerMinute: 30 });
    expect(main.sent.filter(([channel]) => channel === "chat:status")).toHaveLength(4);
    expect(await invoke("chat:send", request)).toMatchObject({ blockedBy: "disabled" });
    await rt.dispose();
  });

  it("forwards the stash-search options and copy-hovered, reading the clipboard for the dry-run answer", async () => {
    const { ipc, invoke } = fakeIpc();
    const files = new Map<string, string>();
    const settings = new SettingsStore({
      file: "s.json",
      fs: { read: (f) => files.get(f), write: (f, t) => void files.set(f, t) },
    });
    const main = fakeWindow();
    const rt = createFeatureRuntime({
      ipcMain: ipc,
      configDir: "C:/cfg",
      userDataDir: "C:/user",
      repoRoot: "C:/repo",
      buildMode: "authorized-qa",
      core: {} as never,
      settings,
      mainWindow: () => main as never,
      poeWindows: async () => [],
      killSwitchLatched: () => false,
      notify: vi.fn(),
      clipboard: { readText: () => ITEM_TEXT, writeText: vi.fn() },
      openExternal: async () => undefined,
      log: vi.fn(),
    });
    await rt.register([chatCommandsModule]);
    expect(await invoke("app:feature-channels")).toEqual(expect.arrayContaining(["chat:copy-hovered"]));
    // Dry-run only: no input host may ever start in tests.
    await invoke("app:set-dry-run", true);
    expect(await invoke("chat:copy-hovered", { reason: "evaluate hovered item", source: "evaluate" })).toEqual({
      ok: true,
      dryRun: true,
      at: expect.any(String),
      text: ITEM_TEXT,
    });
    expect(await invoke("chat:stash-search", "class: belt", "why", { focus: true })).toMatchObject({
      ok: true,
      dryRun: true,
      sent: "class: belt",
    });
    await rt.dispose();
  });
});
