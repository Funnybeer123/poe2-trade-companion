import { execFile, type ChildProcess } from "node:child_process";

export interface OneShotSpeechOptions {
  signal: AbortSignal;
  timeoutMs: number;
  phrases: string[];
  allowDictation: boolean;
}

export interface SpeechRecognitionResult {
  text: string;
  confidence: number;
}

export interface LocalSpeechRecognizer {
  recognize(options: OneShotSpeechOptions): Promise<SpeechRecognitionResult>;
}

interface SpeechWireResult {
  ok?: boolean;
  text?: unknown;
  confidence?: unknown;
  error?: unknown;
}

function encodedPhrases(phrases: string[]): string {
  return Buffer.from(JSON.stringify(phrases), "utf8").toString("base64");
}

export function powershellSpeechScript(
  timeoutMs: number,
  phrases: string[],
  allowDictation: boolean,
): string {
  const seconds = Math.max(1.5, Math.min(15, timeoutMs / 1_000));
  const phrasePayload = encodedPhrases(phrases);
  const dictation = allowDictation
    ? "$engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())"
    : "";
  return `
$ErrorActionPreference = "Stop"
$engine = $null
$output = [ordered]@{ ok = $false; error = "speech-recognition-failed" }
try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($installed.Count -eq 0) { throw "no-local-speech-recognizer-installed" }
  $current = [System.Globalization.CultureInfo]::CurrentUICulture
  $recognizer = $installed | Where-Object { $_.Culture.Name -eq $current.Name } | Select-Object -First 1
  if ($null -eq $recognizer) { $recognizer = $installed[0] }
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizer.Culture)
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${phrasePayload}"))
  $phrases = @(ConvertFrom-Json -InputObject $json)
  if ($phrases.Count -gt 0) {
    $choices = [System.Speech.Recognition.Choices]::new()
    $choices.Add([string[]]$phrases)
    $builder = [System.Speech.Recognition.GrammarBuilder]::new()
    $builder.Append($choices)
    $engine.LoadGrammar([System.Speech.Recognition.Grammar]::new($builder))
  }
  ${dictation}
  $engine.SetInputToDefaultAudioDevice()
  $heard = $engine.Recognize([TimeSpan]::FromSeconds(${seconds.toFixed(3)}))
  if ($null -eq $heard) {
    $output = [ordered]@{ ok = $false; error = "speech-timeout" }
  } else {
    $output = [ordered]@{
      ok = $true
      text = [string]$heard.Text
      confidence = [double]$heard.Confidence
      culture = [string]$recognizer.Culture.Name
    }
  }
} catch {
  $message = [string]$_.Exception.Message
  $code = if ($message -match "no-local-speech-recognizer") {
    "speech-engine-unavailable"
  } elseif ($message -match "audio|microphone|input device") {
    "speech-audio-input-unavailable"
  } else {
    "speech-recognition-failed"
  }
  $output = [ordered]@{ ok = $false; error = ($code + ": " + $message) }
} finally {
  if ($null -ne $engine) { $engine.Dispose() }
}
$output | ConvertTo-Json -Compress
`.trim();
}

export function parsePowershellSpeechOutput(stdout: string): SpeechRecognitionResult {
  const lines = stdout
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const json = [...lines].reverse().find((line) => line.startsWith("{"));
  if (!json) throw new Error("speech-recognition-invalid-response");
  let parsed: SpeechWireResult;
  try {
    parsed = JSON.parse(json) as SpeechWireResult;
  } catch {
    throw new Error("speech-recognition-invalid-response");
  }
  if (!parsed.ok) {
    const reason = String(parsed.error ?? "speech-recognition-failed").trim();
    throw new Error(reason || "speech-recognition-failed");
  }
  const text = String(parsed.text ?? "").trim();
  if (!text) throw new Error("voice-no-speech");
  const confidence = Number(parsed.confidence);
  return {
    text,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
  };
}

export class WindowsSpeechRecognizer implements LocalSpeechRecognizer {
  recognize(options: OneShotSpeechOptions): Promise<SpeechRecognitionResult> {
    if (process.platform !== "win32") {
      return Promise.reject(new Error("windows-local-speech-required"));
    }
    if (options.signal.aborted) {
      return Promise.reject(new Error("speech-recognition-cancelled"));
    }
    const script = powershellSpeechScript(
      options.timeoutMs,
      options.phrases,
      options.allowDictation,
    );
    return new Promise<SpeechRecognitionResult>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let settled = false;
      const finish = (
        error?: Error | null,
        stdout = "",
      ): void => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener("abort", abort);
        if (options.signal.aborted) {
          reject(new Error("speech-recognition-cancelled"));
          return;
        }
        if (error) {
          const timedOut = (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
          reject(new Error(timedOut ? "speech-process-timeout" : "speech-process-failed"));
          return;
        }
        try {
          resolve(parsePowershellSpeechOutput(stdout));
        } catch (reason) {
          reject(reason);
        }
      };
      const abort = (): void => {
        child?.kill();
        finish(new Error("speech-recognition-cancelled"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      child = execFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          timeout: options.timeoutMs + 4_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => finish(error, stdout),
      );
    });
  }
}
