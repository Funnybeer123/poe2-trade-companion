import type { PixelBox } from "../world-state/types.js";

export interface OcrInput {
  pixels?: Uint8Array;
  width?: number;
  height?: number;
  pngPath?: string;
  box?: PixelBox;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export interface OcrPort {
  recognize(input: OcrInput): Promise<OcrResult>;
}

export class NoopOcrPort implements OcrPort {
  async recognize(): Promise<OcrResult> {
    return { text: "", confidence: 0 };
  }
}

export class FixtureOcrPort implements OcrPort {
  readonly #labels: Map<string, string>;

  constructor(labels: Record<string, string> | Map<string, string> = new Map()) {
    this.#labels = labels instanceof Map ? labels : new Map(Object.entries(labels));
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    const boxKey =
      input.box === undefined
        ? undefined
        : `${String(input.box.x)},${String(input.box.y)},${String(input.box.w)},${String(input.box.h)}`;
    const text =
      (boxKey !== undefined ? this.#labels.get(boxKey) : undefined) ??
      this.#labels.get("*") ??
      "";
    return { text, confidence: text.length > 0 ? 0.9 : 0 };
  }
}
