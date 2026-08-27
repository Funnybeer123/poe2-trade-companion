import type { PerceptionFrame } from "./types.js";

export interface FrameSource {
  next(): Promise<PerceptionFrame | null>;
}

export class RecordedFrameSource implements FrameSource {
  private index = 0;
  constructor(private readonly frames: PerceptionFrame[]) {}

  async next(): Promise<PerceptionFrame | null> {
    if (this.index >= this.frames.length) return null;
    const frame = this.frames[this.index];
    this.index += 1;
    return frame;
  }
}

export interface WindowInfo {
  title: string;
  processName: string;
}

export function processAllowed(processName: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => processName.toLowerCase().includes(entry.toLowerCase()));
}

export function detectRegions(width: number, height: number) {
  return {
    inventory: { x: width * 0.65, y: height * 0.4, w: width * 0.3, h: height * 0.45 },
    stash: { x: width * 0.05, y: height * 0.15, w: width * 0.45, h: height * 0.7 },
    loot: { x: 0, y: 0, w: width, h: height },
  };
}

export function ocrLootLabels(lines: string[]): Array<{ label: string; score: number }> {
  return lines
    .map((label) => ({ label, score: /rare|unique|exalted|divine/i.test(label) ? 80 : 20 }))
    .filter((entry) => entry.label.trim().length > 0);
}

export function templateConfidence(score: number): number {
  return Math.max(0, Math.min(1, score));
}
