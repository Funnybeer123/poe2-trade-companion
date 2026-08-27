import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  LocalSpeechRecognizer,
  OneShotSpeechOptions,
} from "../src/adapters/windowsSpeechRecognizer.js";
import {
  DEFAULT_VOICE_TRANSFER_CONFIG,
  exactClassSearchQuery,
  normalizeVoiceTransferConfig,
  resolveVoiceCommand,
  validateVoiceHotkey,
  voiceRecognitionPhrases,
} from "../src/core/voiceTransfer.js";
import type {
  AssistiveRunRequest,
  AssistiveRunResult,
} from "../src/main/assistiveRunService.js";
import { VoiceTransferService } from "../src/main/voiceTransferService.js";
import {
  loadVoiceTransferConfig,
  saveVoiceTransferConfig,
} from "../src/main/voiceTransferSettings.js";

function transferResult(reason = "bag-full"): AssistiveRunResult {
  return {
    ok: true,
    reason,
    kind: "fill",
    dryRun: true,
    cycles: 1,
    elapsedMs: 5,
    bagCells: 60,
    stashCells: 12,
    traces: [],
    memory: {
      scenarioKey: "normal::voice",
      confirmed: 0,
      blockedReturns: 0,
      lastWithdrawn: 0,
      updatedAt: new Date(0).toISOString(),
    },
  };
}

describe("voice stash command resolution", () => {
  it("maps common currency speech to both exact supported classes", () => {
    const command = resolveVoiceCommand("currency");
    expect(command).toEqual({
      transcript: "currency",
      phrase: "currency",
      mode: "class",
      wantedClasses: ["Currency", "Stackable Currency"],
      searchQuery: '"class: (Currency|Stackable Currency)"',
    });
  });

  it("accepts singular, plural, spelling, and multi-class aliases", () => {
    expect(resolveVoiceCommand("transfer body armor").wantedClasses).toEqual([
      "Body Armours",
    ]);
    expect(resolveVoiceCommand("rings and amulets").wantedClasses).toEqual([
      "Rings",
      "Amulets",
    ]);
    expect(resolveVoiceCommand("one handed axes").wantedClasses).toEqual([
      "One Hand Axes",
      "One Handed Axes",
    ]);
    expect(resolveVoiceCommand("omens").wantedClasses).toEqual(["Omen"]);
    expect(resolveVoiceCommand("quarterstaff").wantedClasses).toEqual([
      "Quarterstaves",
    ]);
    expect(exactClassSearchQuery(["Belts"])).toBe('"class: Belts"');
  });

  it("allows only an explicit, escaped exact literal fallback", () => {
    expect(() => resolveVoiceCommand("Exalted Orb", true)).toThrow(
      "voice-command-not-supported",
    );
    expect(resolveVoiceCommand("search for Exalted Orb", true)).toMatchObject({
      mode: "literal",
      wantedClasses: [],
      searchQuery: '"^exalted orb$"',
    });
    expect(() => resolveVoiceCommand("search for .*", true)).toThrow(
      "voice-literal-search-unsafe",
    );
    expect(() => resolveVoiceCommand("search for items", true)).toThrow(
      "voice-literal-search-unsafe",
    );
  });

  it("builds a narrow local recognition vocabulary", () => {
    const phrases = voiceRecognitionPhrases();
    expect(phrases).toContain("currency");
    expect(phrases).toContain("transfer currency");
    expect(phrases).toContain("search for body armor");
  });
});

describe("voice transfer configuration", () => {
  it("defaults to live voice fill, no literal fallback, and a reserved-safe hotkey", () => {
    const config = normalizeVoiceTransferConfig(undefined);
    expect(config).toMatchObject({
      enabled: true,
      dryRun: false,
      qaAcknowledged: true,
      allowLiteralFallback: false,
      hotkey: "CommandOrControl+Alt+V",
    });
    expect(validateVoiceHotkey(config.hotkey)).toBe(config.hotkey);
    expect(() =>
      validateVoiceHotkey("CommandOrControl+Shift+Escape"),
    ).toThrow("voice-hotkey-reserved");
    expect(() => validateVoiceHotkey("CommandOrControl+D")).toThrow(
      "voice-hotkey-reserved",
    );
  });

  it("persists only local voice settings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-voice-settings-"));
    const saved = {
      ...DEFAULT_VOICE_TRANSFER_CONFIG,
      hotkey: "CommandOrControl+Alt+M",
      allowLiteralFallback: true,
      maxItems: 12,
    };
    const file = saveVoiceTransferConfig(root, saved);
    expect(loadVoiceTransferConfig(root)).toEqual(saved);
    expect(readFileSync(file, "utf8")).not.toMatch(
      /transcript|credential|token/i,
    );
  });
});

describe("voice transfer orchestration", () => {
  it("starts the existing audited fill path with the exact recognized query", async () => {
    const recognize = vi.fn(async () => ({
      text: "currencies",
      confidence: 0.91,
    }));
    const recognizer: LocalSpeechRecognizer = { recognize };
    const requests: AssistiveRunRequest[] = [];
    const states: string[] = [];
    const service = new VoiceTransferService({
      mode: "authorized-qa",
      recognizer,
      config: () => ({
        ...DEFAULT_VOICE_TRANSFER_CONFIG,
        dryRun: true,
      }),
      assistiveStatus: () => ({
        running: false,
        killLatched: false,
        qaOptIn: false,
        searchCalibrated: true,
      }),
      startTransfer: async (request) => {
        requests.push(request);
        return transferResult();
      },
      stopTransfer: vi.fn(),
      onState: (state) => states.push(state.phase),
    });

    const result = await service.trigger("hotkey");

    expect(result).toMatchObject({
      phase: "complete",
      transcript: "currencies",
      confidence: 0.91,
      searchQuery: '"class: (Currency|Stackable Currency)"',
      transferReason: "bag-full",
    });
    expect(requests).toEqual([
      expect.objectContaining({
        kind: "fill",
        dryRun: true,
        wantedClasses: ["Currency", "Stackable Currency"],
        searchQuery: '"class: (Currency|Stackable Currency)"',
        uniqueAcrossCycles: false,
      }),
    ]);
    expect(states).toEqual([
      "listening",
      "recognized",
      "transferring",
      "complete",
    ]);
    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDictation: false,
        timeoutMs: 6_000,
      }),
    );
  });

  it("refuses low-confidence speech before transfer", async () => {
    const startTransfer = vi.fn(async () => transferResult());
    const recognizer: LocalSpeechRecognizer = {
      recognize: vi.fn(async () => ({ text: "currency", confidence: 0.2 })),
    };
    const service = new VoiceTransferService({
      mode: "public-companion",
      recognizer,
      config: () => DEFAULT_VOICE_TRANSFER_CONFIG,
      assistiveStatus: () => ({
        running: false,
        killLatched: false,
        qaOptIn: true,
        searchCalibrated: true,
      }),
      startTransfer,
      stopTransfer: vi.fn(),
    });
    await expect(service.trigger("ui")).resolves.toMatchObject({
      phase: "error",
      error: "voice-confidence-too-low:0.20",
    });
    expect(startTransfer).not.toHaveBeenCalled();
  });

  it("cancels one-shot recognition without starting or latching transfer", async () => {
    const recognizer: LocalSpeechRecognizer = {
      recognize: ({ signal }: OneShotSpeechOptions) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("speech-recognition-cancelled")),
            { once: true },
          );
        }),
    };
    const startTransfer = vi.fn(async () => transferResult());
    const stopTransfer = vi.fn();
    const service = new VoiceTransferService({
      mode: "authorized-qa",
      recognizer,
      config: () => DEFAULT_VOICE_TRANSFER_CONFIG,
      assistiveStatus: () => ({
        running: false,
        killLatched: false,
        qaOptIn: false,
        searchCalibrated: true,
      }),
      startTransfer,
      stopTransfer,
    });

    const pending = service.trigger("ui");
    await vi.waitFor(() => expect(service.status.phase).toBe("listening"));
    await expect(service.cancel()).resolves.toMatchObject({
      phase: "cancelled",
      transferReason: "voice-operator-cancel",
    });
    await pending;
    expect(startTransfer).not.toHaveBeenCalled();
    expect(stopTransfer).not.toHaveBeenCalled();
  });
});
