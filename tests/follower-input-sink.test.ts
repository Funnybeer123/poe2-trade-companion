import { describe, expect, it } from "vitest";
import { FollowerInputSink, LOOT_CLICK, SPRINT_HOLD, type FollowerFrameGuard } from "../src/adapters/followerInputSink.js";
import { GameInputController } from "../src/core/gameInputController.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { scenario } from "../src/core/scenarios.js";
import type { InputAction } from "../src/core/types.js";

// SYNTHETIC input host: a scripted object records requests and answers them. Nothing here spawns
// PowerShell, moves the cursor, or sends mouse/keyboard input; no OS input is possible.
type Payload = Record<string, unknown>;
type Reply = Record<string, unknown> | Error;
const FRAME: FollowerFrameGuard = { hwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_123 };
const CLICK: InputAction = { kind: "click", x: 398, y: 123, button: "left" };
function fakeHost(...replies: Reply[]) {
  const sent: Payload[] = [];
  return {
    sent,
    send: async (payload: Payload) => {
      sent.push(payload);
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      if (reply instanceof Error) throw reply;
      return reply ?? { ok: true, inputMs: 21, captureToInputMs: 37 };
    },
  };
}

describe("follower input sink (synthetic input host, no OS input)", () => {
  it("turns one left click into one guarded moveclick carrying the capture it was decided from", async () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME);
    await sink.emit(CLICK);
    expect(host.sent).toEqual([{ op: "moveclick", x: 398, y: 123, expectedHwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_123, maxAgeMs: 120, area: "move" }]);
  });
  it("treats a click without a button as a left click and forwards a custom freshness limit", async () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME, 90);
    await sink.emit({ kind: "click", x: 0, y: 0 });
    expect(host.sent).toEqual([{ op: "moveclick", x: 0, y: 0, expectedHwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_123, maxAgeMs: 90, area: "move" }]);
  });
  it("asks the guard again for every click, so each request carries the newest capture", async () => {
    const host = fakeHost();
    let frame: FollowerFrameGuard | undefined = FRAME, asked = 0;
    const sink = new FollowerInputSink(host, () => { asked++; return frame; });
    await sink.emit(CLICK);
    frame = { hwnd: "777", viewWidth: 1280, viewHeight: 720, capturedAtQpcMs: 5_000_456 };
    await sink.emit({ ...CLICK, x: 700, y: 300 });
    expect(asked).toBe(2);
    expect(host.sent[1]).toMatchObject({ x: 700, y: 300, expectedHwnd: "777", viewWidth: 1280, viewHeight: 720, capturedAtQpcMs: 5_000_456 });
    frame = undefined;
    await expect(sink.emit(CLICK)).rejects.toThrow("Follow stopped or capture stale");
    expect(host.sent).toHaveLength(2);
  });
  it("rejects every click while the guard has no fresh frame, before anything reaches the host", async () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => undefined);
    await expect(sink.emit(CLICK)).rejects.toThrow("Follow stopped or capture stale");
    // The guard comes first: an invalid action is not what gets reported when following has stopped.
    await expect(sink.emit({ kind: "key", key: "w" })).rejects.toThrow("Follow stopped or capture stale");
    expect(host.sent).toEqual([]);
    expect(sink.lastInput).toBeUndefined();
  });
  const invalid: Array<[string, InputAction]> = [
    ["a right click", { ...CLICK, button: "right" }],
    ["a ctrl-click", { ...CLICK, modifier: "ctrl" }],
    ["an alt-click", { ...CLICK, modifier: "alt" }],
    ["a fractional x", { ...CLICK, x: 398.5 }],
    ["a fractional y", { ...CLICK, y: 122.25 }],
    ["a missing x", { kind: "click", y: 123, button: "left" }],
    ["a missing y", { kind: "click", x: 398, button: "left" }],
    ["a NaN coordinate", { ...CLICK, x: Number.NaN }],
    ["an infinite coordinate", { ...CLICK, y: Number.POSITIVE_INFINITY }],
    ["a key press", { kind: "key", key: "space" }],
    ["typed text", { kind: "type", text: "/invite" }],
    ["a bare cursor move", { kind: "move", x: 398, y: 123 }],
    ["a drag", { kind: "drag", x: 398, y: 123, x2: 400, y2: 130 }],
    ["a focus change", { kind: "focus" }],
    ["a wait", { kind: "wait", durationMs: 50 }],
  ];
  it.each(invalid)("rejects %s without contacting the host", async (_name, action) => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME);
    await expect(sink.emit(action)).rejects.toThrow("Invalid follow action");
    expect(host.sent).toEqual([]);
    expect(sink.lastInput).toBeUndefined();
  });
  it("throws the host's refusal text so the caller can classify it", async () => {
    for (const error of ["Stale capture", "Manual mouse movement", "Focus Path of Exile 2 to continue", "Click outside the safe movement area"]) {
      const sink = new FollowerInputSink(fakeHost({ ok: false, error }), () => FRAME);
      await expect(sink.emit(CLICK)).rejects.toThrow(error);
      expect(sink.lastInput).toBeUndefined();
    }
    await expect(new FollowerInputSink(fakeHost({ ok: false }), () => FRAME).emit(CLICK)).rejects.toThrow("Follow input failed");
    await expect(new FollowerInputSink(fakeHost({}), () => FRAME).emit(CLICK)).rejects.toThrow("Follow input failed");
    await expect(new FollowerInputSink(fakeHost(new Error("win-input-host-timeout:moveclick")), () => FRAME).emit(CLICK)).rejects.toThrow("win-input-host-timeout:moveclick");
  });
  it("records the native timings of the most recent accepted click only", async () => {
    const host = fakeHost({ ok: true, inputMs: 22, captureToInputMs: 41 }, { ok: false, error: "Stale capture" }, { ok: true, inputMs: "n/a" }), sink = new FollowerInputSink(host, () => FRAME);
    expect(sink.lastInput).toBeUndefined();
    await sink.emit(CLICK);
    expect(sink.lastInput).toEqual({ inputMs: 22, captureToInputMs: 41 });
    await expect(sink.emit(CLICK)).rejects.toThrow("Stale capture");
    expect(sink.lastInput).toEqual({ inputMs: 22, captureToInputMs: 41 });
    await sink.emit(CLICK);
    expect(sink.lastInput).toEqual({ inputMs: 0, captureToInputMs: 0 });
    expect(host.sent).toHaveLength(3);
  });
  it("sends nothing on clear(): there is no queue to flush and no key to release from here", () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME);
    sink.clear();
    expect(host.sent).toEqual([]);
  });
  it("sits behind GameInputController: dry-run, a latched kill switch and a foreign process never reach the host", async () => {
    const host = fakeHost(), killSwitch = new KillSwitch(), sink = new FollowerInputSink(host, () => FRAME);
    const controller = new GameInputController(sink, killSwitch, "authorized-qa");
    const decision = { module: "navigation" as const, rule: "follow-map-marker", reason: "Move toward Main", intended: [CLICK], confidence: .97 };
    const policy = (dryRun: boolean) => scenario({ id: "follow-map-marker", name: "Follow by overlay map", enabledModules: ["navigation"], dryRun, actionsPerMinute: 600, confidenceThreshold: .85 });
    expect((await controller.execute(decision, policy(true), "PathOfExileSteam", "evidence", true))[0]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=dry-run") });
    expect((await controller.execute(decision, policy(false), "notepad", "evidence", false))[0]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=process-not-allowlisted") });
    expect((await controller.execute({ ...decision, confidence: .5 }, policy(false), "PathOfExileSteam", "evidence", true))[0]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=confidence-too-low") });
    killSwitch.trip();
    expect((await controller.execute(decision, policy(false), "PathOfExileSteam", "evidence", true))[0]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=kill-switch-latched") });
    expect(host.sent).toEqual([]);
    killSwitch.rearm();
    expect((await controller.execute(decision, policy(false), "PathOfExileSteam", "evidence", true))[0]).toMatchObject({ result: "emitted", input: CLICK });
    expect(host.sent).toHaveLength(1);
  });
  it("surfaces a host refusal as a failed trace with the refusal text", async () => {
    const sink = new FollowerInputSink(fakeHost({ ok: false, error: "Manual mouse movement" }), () => FRAME);
    const controller = new GameInputController(sink, new KillSwitch(), "authorized-qa");
    const traces = await controller.execute({ module: "navigation", rule: "follow-map-marker", reason: "Move toward Main", intended: [CLICK], confidence: 1 },
      scenario({ id: "follow-map-marker", name: "Follow by overlay map", enabledModules: ["navigation"], dryRun: false, actionsPerMinute: 600, confidenceThreshold: .85 }), "PathOfExileSteam", "evidence", true);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ result: "failed", reason: expect.stringContaining("sink=Manual mouse movement") });
  });
});

describe("follower input sink loot clicks (SYNTHETIC host, no OS input)", () => {
  it("marks a loot pickup so the input worker allows the world view, and refuses any other text", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = new FollowerInputSink({ send: async payload => { sent.push(payload); return { ok: true, inputMs: 20, captureToInputMs: 70 }; } }, () => ({ hwnd: "66051", viewWidth: 2560, viewHeight: 1440, capturedAtQpcMs: 9_000 }));
    await sink.emit({ kind: "click", x: 789, y: 185, button: "left", text: LOOT_CLICK });
    expect(sent).toEqual([{ op: "moveclick", x: 789, y: 185, expectedHwnd: "66051", viewWidth: 2560, viewHeight: 1440, capturedAtQpcMs: 9_000, maxAgeMs: 120, area: "loot" }]);
    await expect(sink.emit({ kind: "click", x: 789, y: 185, button: "left", text: "anywhere" })).rejects.toThrow("Invalid follow action");
    expect(sent).toHaveLength(1);
  });
});

describe("follower input sink sprint hold (SYNTHETIC host: a 'sprint' request is an array entry, no key is pressed)", () => {
  const HOLD: InputAction = { kind: "key", key: "space", text: SPRINT_HOLD };
  it("starts the hold through emit with start:true, guarded by the capture the decision came from, and records no click timing", async () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME);
    await sink.emit(HOLD);
    expect(host.sent).toEqual([{ op: "sprint", hold: true, start: true, expectedHwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_123, maxAgeMs: 120 }]);
    expect(sink.lastInput).toBeUndefined();
  });
  it("throws the host's refusal of a start so the controller can classify it, and refuses a start without a fresh frame before contacting the host", async () => {
    await expect(new FollowerInputSink(fakeHost({ ok: false, error: "Space held - manual control" }), () => FRAME).emit(HOLD)).rejects.toThrow("Space held - manual control");
    await expect(new FollowerInputSink(fakeHost({ ok: false }), () => FRAME).emit(HOLD)).rejects.toThrow("Sprint input failed");
    const host = fakeHost();
    await expect(new FollowerInputSink(host, () => undefined).emit(HOLD)).rejects.toThrow("Follow stopped or capture stale");
    await expect(new FollowerInputSink(host, () => ({ ...FRAME, hwnd: "" })).emit(HOLD)).rejects.toThrow("Capture stale: incomplete capture guard");
    expect(host.sent).toEqual([]);
  });
  it.each<[string, InputAction]>([["another key", { kind: "key", key: "shift", text: SPRINT_HOLD }], ["space without the hold marker", { kind: "key", key: "space" }], ["space with other text", { kind: "key", key: "space", text: "tap" }]])("rejects %s without contacting the host", async (_name, action) => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => FRAME);
    await expect(sink.emit(action)).rejects.toThrow("Invalid follow action");
    expect(host.sent).toEqual([]);
  });
  it("renews with start:false under the newest frame, and throws when the worker refuses: a lapsed hold must be started again through the controller", async () => {
    const host = fakeHost({ ok: true }, { ok: false, error: "Sprint lapsed" });
    let frame = FRAME;
    const sink = new FollowerInputSink(host, () => frame, 90);
    await sink.renewSprint();
    frame = { ...FRAME, capturedAtQpcMs: 5_000_456 };
    await expect(sink.renewSprint()).rejects.toThrow("Sprint lapsed");
    expect(host.sent).toEqual([
      { op: "sprint", hold: true, start: false, expectedHwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_123, maxAgeMs: 90 },
      { op: "sprint", hold: true, start: false, expectedHwnd: "66051", viewWidth: 640, viewHeight: 360, capturedAtQpcMs: 5_000_456, maxAgeMs: 90 },
    ]);
    expect(host.sent.every(entry => entry.start === false)).toBe(true);
  });
  it("lets go instead of renewing when the frame is stale, and reports it", async () => {
    const host = fakeHost(), sink = new FollowerInputSink(host, () => undefined);
    await expect(sink.renewSprint()).rejects.toThrow("Follow stopped or capture stale");
    expect(host.sent).toEqual([{ op: "sprint", hold: false }]);
  });
  it("is never refused a release: not by the guard, not by the worker's answer, not by a dead transport", async () => {
    const refused = fakeHost({ ok: false, error: "Sprint lapsed" });
    await new FollowerInputSink(refused, () => undefined).releaseSprint();
    expect(refused.sent).toEqual([{ op: "sprint", hold: false }]);
    const dead = fakeHost(new Error("win-input-host-closed"));
    await expect(new FollowerInputSink(dead, () => FRAME).releaseSprint()).resolves.toBeUndefined();
    expect(dead.sent).toEqual([{ op: "sprint", hold: false }]);
  });
});