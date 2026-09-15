/**
 * The live-search chime: a two-tone WebAudio beep, no asset and no file
 * picker (wave-2 rule — each feature keeps its own ~30-line beep rather
 * than sharing a sound store).
 *
 * Everything is guarded: a browser preview, a suspended audio context or a
 * missing AudioContext must never throw into a live-search event handler.
 */
let context: AudioContext | undefined;

function audioContext(): AudioContext | undefined {
  if (context) return context;
  const Ctor =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return undefined;
  try {
    context = new Ctor();
    return context;
  } catch {
    return undefined;
  }
}

/** True when a chime can be played at all (the toggle is still the user's). */
export function chimeEnabled(): boolean {
  return audioContext() !== undefined;
}

function tone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** Two short notes — enough to notice, short enough not to annoy. */
export function playLiveChime(): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    tone(ctx, 880, now, 0.12);
    tone(ctx, 1318.5, now + 0.13, 0.16);
  } catch {
    // A blocked or closed audio context is not an error worth surfacing.
  }
}
