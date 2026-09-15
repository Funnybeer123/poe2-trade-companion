/**
 * A two-tone beep for a new offer — a WebAudio oscillator, no asset files and
 * no uploads. Main decides WHICH window plays it (`playSoundIn`), so the user
 * never hears the same offer twice.
 */
let context: AudioContext | undefined;

function audioContext(): AudioContext | undefined {
  if (context) return context;
  const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  try {
    context = new Ctor();
    return context;
  } catch {
    return undefined;
  }
}

function tone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

export function playOfferSound(): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    void ctx.resume?.();
    const now = ctx.currentTime;
    tone(ctx, 784, now, 0.12);
    tone(ctx, 1046, now + 0.14, 0.16);
  } catch {
    // Audio is a nicety: a blocked or missing device must never break the view.
  }
}

/** The overlay window loads the same bundle at `#/overlay`. */
export function isOverlayWindow(): boolean {
  return Boolean(globalThis.location?.hash?.startsWith("#/overlay"));
}
