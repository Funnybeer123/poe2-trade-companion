import type { Clock, FrameSource, PerceptionFrameInput } from "@poe2tc/core";

export interface DesktopCapturerSize {
  width: number;
  height: number;
}

export interface DesktopCapturerThumbnail {
  getSize(): DesktopCapturerSize;
  toBitmap?: () => Uint8Array | Buffer;
  toPNG?: () => Uint8Array | Buffer;
}

export interface DesktopCapturerSource {
  id: string;
  name: string;
  thumbnail?: DesktopCapturerThumbnail;
}

export interface DesktopCapturerLike {
  getSources(options: {
    types: Array<"window" | "screen">;
    thumbnailSize?: DesktopCapturerSize;
  }): Promise<DesktopCapturerSource[]>;
}

export interface ElectronFrameSourceOptions {
  capturer: DesktopCapturerLike;
  clock: Clock;
  sourceNameIncludes?: string[];
  thumbnailSize?: DesktopCapturerSize;
}

function toRgbaFromBitmap(bitmap: Uint8Array | Buffer, width: number, height: number): Uint8Array {
  const src = bitmap instanceof Uint8Array ? bitmap : new Uint8Array(bitmap);
  const expected = width * height * 4;
  if (src.length < expected) {
    return new Uint8Array(src);
  }
  const rgba = new Uint8Array(expected);
  for (let i = 0; i < expected; i += 4) {
    rgba[i] = src[i + 2]!;
    rgba[i + 1] = src[i + 1]!;
    rgba[i + 2] = src[i]!;
    rgba[i + 3] = src[i + 3]!;
  }
  return rgba;
}

/**
 * Electron `desktopCapturer` adapter implementing `FrameSource`.
 * Capture only — no input. Works with an injected capturer so CI can construct
 * it without a live PoE window.
 */
export class ElectronFrameSource implements FrameSource {
  readonly #capturer: DesktopCapturerLike;
  readonly #clock: Clock;
  readonly #sourceNameIncludes: string[];
  readonly #thumbnailSize: DesktopCapturerSize;
  #tickId = 0;

  constructor(options: ElectronFrameSourceOptions) {
    this.#capturer = options.capturer;
    this.#clock = options.clock;
    this.#sourceNameIncludes = options.sourceNameIncludes ?? ["Path of Exile 2"];
    this.#thumbnailSize = options.thumbnailSize ?? { width: 1920, height: 1080 };
  }

  async nextFrame(): Promise<PerceptionFrameInput | null> {
    const sources = await this.#capturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: this.#thumbnailSize,
    });
    const matched =
      sources.find((source) =>
        this.#sourceNameIncludes.some((fragment) => source.name.includes(fragment)),
      ) ?? sources[0];
    if (matched === undefined) {
      return null;
    }

    this.#tickId += 1;
    const size = matched.thumbnail?.getSize() ?? { width: 0, height: 0 };
    let pixels: Uint8Array | undefined;
    if (matched.thumbnail?.toBitmap !== undefined) {
      pixels = toRgbaFromBitmap(matched.thumbnail.toBitmap(), size.width, size.height);
    }

    return {
      tickId: this.#tickId,
      capturedAtMs: this.#clock.nowMs(),
      width: size.width,
      height: size.height,
      pixels,
    };
  }
}

export function createElectronFrameSource(options: ElectronFrameSourceOptions): ElectronFrameSource {
  return new ElectronFrameSource(options);
}
