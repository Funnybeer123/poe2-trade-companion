import { describe, expect, it } from "vitest";
import {
  CHAT_MAX_PER_MINUTE,
  CHAT_PLACEHOLDERS,
  ChatRateLimiter,
  DEFAULT_CHAT_COMMAND_SETTINGS,
  HOST_TYPABLE_CHARS,
  normalizeChatCommandSettings,
  resolvePlaceholders,
  sanitizeChatText,
  stashSearchHotkey,
  unresolvedPlaceholders,
  untypableChars,
} from "../src/core/chatCommands.js";

describe("resolvePlaceholders", () => {
  it("fills every documented placeholder", () => {
    const template = CHAT_PLACEHOLDERS.map((name) => `{${name}}`).join(" ");
    const text = resolvePlaceholders(template, {
      player: "Buyer",
      area: "Sun Temple",
      latestWhisper: "hi there",
      char: "Himbo",
      item: "Ghoul Lash, Long Belt",
      price: "1 exalted",
      tab: "~price 1 exalted",
      left: 10,
      top: 7,
      league: "Forbidden Rites",
    });
    expect(text).toBe(
      "Buyer Sun Temple hi there Himbo Ghoul Lash, Long Belt 1 exalted ~price 1 exalted 10 7 Forbidden Rites",
    );
  });

  it("leaves unknown names and missing values verbatim so the line can be refused", () => {
    expect(resolvePlaceholders("@{player} {nope} {area}", { player: "P" })).toBe("@P {nope} {area}");
    expect(resolvePlaceholders("{left}", { left: Number.NaN })).toBe("{left}");
    expect(resolvePlaceholders("{tab}", { tab: "   " })).toBe("{tab}");
    expect(resolvePlaceholders("", { player: "P" })).toBe("");
  });

  it("flattens a multi-line placeholder value into one line", () => {
    expect(resolvePlaceholders("re: {latestWhisper}", { latestWhisper: "hi\r\nthere\tfriend  " })).toBe(
      "re: hi there friend",
    );
  });

  it("lists unresolved placeholders once each, in order", () => {
    expect(unresolvedPlaceholders("@{player} {player} {item} x {1bad}")).toEqual(["player", "item"]);
    expect(unresolvedPlaceholders("plain")).toEqual([]);
  });
});

describe("sanitizeChatText", () => {
  it("accepts a trimmed one-line command with host-typable punctuation", () => {
    const check = sanitizeChatText('  /invite Exile_Name "quoted" (x) 50%  ');
    expect(check).toEqual({ text: '/invite Exile_Name "quoted" (x) 50%', issues: [] });
  });

  it("refuses empty, non-string and whitespace-only input as empty", () => {
    expect(sanitizeChatText("").blockedBy).toBe("empty");
    expect(sanitizeChatText("   ").issues).toEqual(["empty"]);
    expect(sanitizeChatText(undefined).blockedBy).toBe("empty");
    expect(sanitizeChatText(42).blockedBy).toBe("empty");
  });

  it("refuses more than 300 characters as too-long", () => {
    const ok = sanitizeChatText("a".repeat(300));
    expect(ok.blockedBy).toBeUndefined();
    const long = sanitizeChatText("a".repeat(301));
    expect(long.blockedBy).toBe("too-long");
    expect(long.issues).toEqual(["too-long"]);
    expect(long.error).toMatch(/301 characters/);
  });

  it("refuses multi-line text and control characters as empty", () => {
    const multi = sanitizeChatText("/kick x\n/invite y");
    expect(multi.blockedBy).toBe("empty");
    expect(multi.issues).toContain("multi-line");
    const control = sanitizeChatText("helloworld");
    expect(control.blockedBy).toBe("empty");
    expect(control.issues).toContain("control-chars");
  });

  it("refuses unresolved placeholders as empty with the names in the error", () => {
    const check = sanitizeChatText("@{player} thanks");
    expect(check.blockedBy).toBe("empty");
    expect(check.issues).toEqual(["unresolved-placeholder"]);
    expect(check.error).toContain("{player}");
  });

  it("refuses characters the input host would silently drop (non-ASCII names) and accepts a whisper's @", () => {
    expect(sanitizeChatText("@Buyer hi").blockedBy).toBeUndefined();
    const check = sanitizeChatText("@Zoë hi");
    expect(check.blockedBy).toBe("empty");
    expect(check.issues).toEqual(["untypable-chars"]);
    expect(check.error).toContain('"ë"');
    expect(untypableChars("café ^ @")).toEqual(["é"]);
    expect(HOST_TYPABLE_CHARS.has("@")).toBe(true);
    expect(HOST_TYPABLE_CHARS.has("^")).toBe(true);
    expect(HOST_TYPABLE_CHARS.has(":")).toBe(true);
  });

  it("buckets a too-long line that is also broken as empty", () => {
    const check = sanitizeChatText(`${"a".repeat(301)}\nb`);
    expect(check.blockedBy).toBe("empty");
    expect(check.issues).toEqual(["multi-line", "too-long"]);
  });
});

describe("ChatRateLimiter", () => {
  function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it("enforces the 400 ms gap and the per-minute budget with a sliding window", () => {
    const c = clock();
    const limiter = new ChatRateLimiter({ now: c.now, maxPerMinute: 3 });
    expect(limiter.check()).toEqual({ ok: true });
    limiter.record();
    expect(limiter.check()).toEqual({ ok: false, reason: "min-gap", retryAfterMs: 400 });
    c.advance(399);
    expect(limiter.check()).toMatchObject({ ok: false, reason: "min-gap", retryAfterMs: 1 });
    c.advance(1);
    expect(limiter.check()).toEqual({ ok: true });
    limiter.record();
    c.advance(400);
    limiter.record();
    expect(limiter.sentThisMinute()).toBe(3);
    c.advance(400);
    expect(limiter.check()).toEqual({ ok: false, reason: "per-minute", retryAfterMs: 60_000 - 1_200 });
    c.advance(60_000 - 1_200);
    expect(limiter.check()).toEqual({ ok: true });
    expect(limiter.sentThisMinute()).toBe(2);
  });

  it("caps any override at the compliance ceiling and honours a lower one", () => {
    const c = clock();
    const limiter = new ChatRateLimiter({ now: c.now, maxPerMinute: 500 });
    for (let i = 0; i < CHAT_MAX_PER_MINUTE; i += 1) {
      expect(limiter.check()).toEqual({ ok: true });
      limiter.record();
      c.advance(400);
    }
    expect(limiter.check()).toMatchObject({ ok: false, reason: "per-minute" });
    expect(limiter.check({ maxPerMinute: 1_000 })).toMatchObject({ ok: false, reason: "per-minute" });
    limiter.reset();
    limiter.record();
    c.advance(400);
    expect(limiter.check({ maxPerMinute: 1 })).toMatchObject({ ok: false, reason: "per-minute" });
    expect(limiter.check({ maxPerMinute: 2 })).toEqual({ ok: true });
  });
});

describe("normalizeChatCommandSettings", () => {
  it("returns defaults for nothing, garbage, and wrong types with issues", () => {
    expect(normalizeChatCommandSettings(undefined)).toEqual({ value: DEFAULT_CHAT_COMMAND_SETTINGS, issues: [] });
    expect(normalizeChatCommandSettings("nope").issues).toEqual(["settings must be an object; defaults used"]);
    const typed = normalizeChatCommandSettings({ enabled: "yes", idleCloseMs: "soon", maxPerMinute: null });
    expect(typed.value).toEqual(DEFAULT_CHAT_COMMAND_SETTINGS);
    expect(typed.issues).toEqual([
      "enabled must be a boolean",
      "idleCloseMs must be a number",
      "maxPerMinute must be a number",
    ]);
  });

  it("clamps the ranges and never raises the per-minute ceiling", () => {
    const out = normalizeChatCommandSettings({ enabled: false, idleCloseMs: 10, maxPerMinute: 999 });
    expect(out.value).toEqual({ enabled: false, idleCloseMs: 5_000, maxPerMinute: CHAT_MAX_PER_MINUTE });
    expect(out.issues).toEqual(["idleCloseMs clamped to 5000–600000", "maxPerMinute clamped to 1–30"]);
    expect(normalizeChatCommandSettings({ idleCloseMs: 120_000.7, maxPerMinute: 12 }).value).toEqual({
      enabled: true,
      idleCloseMs: 120_000,
      maxPerMinute: 12,
    });
    expect(normalizeChatCommandSettings({ maxPerMinute: 0 }).value.maxPerMinute).toBe(1);
  });
});

describe("stashSearchHotkey", () => {
  it("defaults to Ctrl+F and maps a letter virtual-key with Ctrl", () => {
    expect(stashSearchHotkey()).toBe("ctrlf");
    expect(stashSearchHotkey(0x53)).toBe("ctrls");
    expect(stashSearchHotkey(0x0d)).toBe("ctrlf");
    expect(stashSearchHotkey(Number.NaN)).toBe("ctrlf");
  });
});
