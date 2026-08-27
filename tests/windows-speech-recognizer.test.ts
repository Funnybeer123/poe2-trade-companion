import { describe, expect, it } from "vitest";
import {
  parsePowershellSpeechOutput,
  powershellSpeechScript,
} from "../src/adapters/windowsSpeechRecognizer.js";

describe("Windows local speech adapter", () => {
  it("uses only the local one-shot System.Speech engine", () => {
    const script = powershellSpeechScript(
      6_000,
      ["currency", "transfer currency"],
      false,
    );
    expect(script).toContain("System.Speech");
    expect(script).toContain("SetInputToDefaultAudioDevice");
    expect(script).toContain("$engine.Recognize(");
    expect(script).toContain("Choices");
    expect(script).not.toContain("DictationGrammar");
    expect(script).not.toMatch(/https?:|Invoke-WebRequest|RestMethod|WebClient/i);
  });

  it("adds local dictation only when explicit literal fallback is enabled", () => {
    const script = powershellSpeechScript(4_000, ["currency"], true);
    expect(script).toContain("DictationGrammar");
  });

  it("parses recognition and preserves clear local engine errors", () => {
    expect(
      parsePowershellSpeechOutput(
        '\uFEFF{"ok":true,"text":"currency","confidence":0.87}\r\n',
      ),
    ).toEqual({ text: "currency", confidence: 0.87 });
    expect(() =>
      parsePowershellSpeechOutput(
        '{"ok":false,"error":"speech-audio-input-unavailable"}',
      ),
    ).toThrow("speech-audio-input-unavailable");
    expect(() => parsePowershellSpeechOutput("not-json")).toThrow(
      "speech-recognition-invalid-response",
    );
  });
});
