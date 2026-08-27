export function hashSeed(scenarioId: string, tickId: number): number {
  let hash = 2166136261;
  const text = `${scenarioId}:${tickId}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TimingProfile {
  minDelayMs: number;
  maxDelayMs: number;
}

const TIMING_PROFILES: Record<string, TimingProfile> = {
  default: { minDelayMs: 0, maxDelayMs: 0 },
  instant: { minDelayMs: 0, maxDelayMs: 0 },
};

export function timingJitterMs(timingProfileId: string, rng: () => number): number {
  const profile = TIMING_PROFILES[timingProfileId] ?? TIMING_PROFILES.default;
  const span = profile.maxDelayMs - profile.minDelayMs;
  return profile.minDelayMs + Math.floor(rng() * (span + 1));
}
