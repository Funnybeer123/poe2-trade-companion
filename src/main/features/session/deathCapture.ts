/**
 * Replay-lite: one screenshot shortly after a death line (or on the capture
 * hotkey). This is deliberately NOT a video recorder — there is no frame
 * pipeline in this app, and `desktopCapturer` only hands out one-shot
 * thumbnails, so a pre-death buffer is not possible.
 *
 * Privacy rule (compliance review, P7 item 1): the DEFAULT source is the
 * Path of Exile WINDOW. A whole-screen grab can contain Discord, a browser
 * and other people's chat, so it only happens when the user turned the
 * expert `allowScreenFallback` switch on.
 *
 * Black-frame rule: Path of Exile in exclusive fullscreen hands out a black
 * thumbnail (the calibration path already guards this). One retry, then the
 * capture is skipped with `black-frame` and the UI explains borderless
 * windowed.
 *
 * Electron is imported lazily through `electronDeathCapturerDeps` so the
 * tests drive this class with plain fakes.
 */
import { BLACK_FRAME_MEAN, JPEG_QUALITY, THUMB_WIDTH, type CaptureSkipReason } from "../../../core/sessionDeaths.js";

export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number }): NativeImageLike;
  toJPEG(quality: number): Buffer;
}

export interface CaptureSourceLike {
  name: string;
  thumbnail: NativeImageLike;
}

export interface DeathCapturerDeps {
  getSources(options: {
    types: Array<"window" | "screen">;
    thumbnailSize: { width: number; height: number };
  }): Promise<CaptureSourceLike[]>;
  /** The display holding PoE (overlay state) else the primary display. */
  displaySize(): { width: number; height: number } | undefined;
  /** grayMean(nativeImageToGray(image)) in production. */
  brightness(image: NativeImageLike): number;
  sleep(ms: number): Promise<void>;
  /** Expert switch: allow a whole-screen grab when no game window is offered. */
  allowScreenFallback(): boolean;
}

export const CAPTURE_DELAY_MS = 800;
export const CAPTURE_RETRY_DELAY_MS = 1_500;
export const MAX_CAPTURE_WIDTH = 1920;

export type CaptureResult =
  | {
      ok: true;
      image: NativeImageLike;
      thumb: NativeImageLike;
      sourceName: string;
      width: number;
      height: number;
      jpeg: Buffer;
      thumbJpeg: Buffer;
    }
  | { ok: false; reason: CaptureSkipReason };

const POE_SOURCE = /path of exile/i;

export class DeathCapturer {
  private running = false;

  constructor(private readonly deps: DeathCapturerDeps) {}

  get busy(): boolean {
    return this.running;
  }

  async capture(): Promise<CaptureResult> {
    if (this.running) return { ok: false, reason: "busy" };
    this.running = true;
    try {
      const display = this.deps.displaySize();
      if (!display || display.width <= 0 || display.height <= 0) {
        return { ok: false, reason: "no-display" };
      }
      const scale = Math.min(1, MAX_CAPTURE_WIDTH / display.width);
      const thumbnailSize = {
        width: Math.max(320, Math.round(display.width * scale)),
        height: Math.max(180, Math.round(display.height * scale)),
      };
      let attempt = await this.grab(thumbnailSize, display);
      if (!attempt.ok && attempt.reason === "black-frame") {
        await this.deps.sleep(CAPTURE_RETRY_DELAY_MS);
        attempt = await this.grab(thumbnailSize, display);
      }
      return attempt;
    } catch {
      return { ok: false, reason: "no-source" };
    } finally {
      this.running = false;
    }
  }

  private async grab(
    thumbnailSize: { width: number; height: number },
    display: { width: number; height: number },
  ): Promise<CaptureResult> {
    const wantScreen = this.deps.allowScreenFallback();
    const sources = await this.deps.getSources({
      types: wantScreen ? ["window", "screen"] : ["window"],
      thumbnailSize,
    });
    const named = sources.find(
      (source) => POE_SOURCE.test(source.name) && !source.thumbnail.isEmpty(),
    );
    const screenHit = wantScreen
      ? sources.find((source) => {
          if (source.thumbnail.isEmpty()) return false;
          const size = source.thumbnail.getSize();
          return (
            Math.abs(size.width - thumbnailSize.width) < 8 ||
            Math.abs(size.width - display.width) < 8
          );
        })
      : undefined;
    const chosen = named ?? screenHit;
    if (!chosen) return { ok: false, reason: "no-source" };
    const image = chosen.thumbnail;
    if (image.isEmpty()) return { ok: false, reason: "no-source" };
    if (this.deps.brightness(image) < BLACK_FRAME_MEAN) return { ok: false, reason: "black-frame" };
    const size = image.getSize();
    const thumb = image.resize({ width: THUMB_WIDTH });
    return {
      ok: true,
      image,
      thumb,
      sourceName: chosen.name,
      width: size.width,
      height: size.height,
      jpeg: image.toJPEG(JPEG_QUALITY),
      thumbJpeg: thumb.toJPEG(JPEG_QUALITY),
    };
  }
}

/**
 * The production wiring. Imported lazily so `import("electron")` never runs
 * in a unit test (and never at module load in the main process either).
 */
export async function electronDeathCapturerDeps(options: {
  displayBounds: () => { width: number; height: number } | undefined;
  allowScreenFallback: () => boolean;
}): Promise<DeathCapturerDeps> {
  const electron = await import("electron");
  const { grayMean, nativeImageToGray } = await import("../../../adapters/nativeImageGray.js");
  return {
    getSources: (opts) =>
      electron.desktopCapturer.getSources(opts) as unknown as Promise<CaptureSourceLike[]>,
    displaySize: () => {
      const fromOverlay = options.displayBounds();
      if (fromOverlay && fromOverlay.width > 0) return fromOverlay;
      try {
        const primary = electron.screen.getPrimaryDisplay();
        return { width: primary.bounds.width, height: primary.bounds.height };
      } catch {
        return undefined;
      }
    },
    brightness: (image) => {
      try {
        return grayMean(nativeImageToGray(image as never));
      } catch {
        // A thumbnail we cannot read is not evidence of a black frame.
        return 255;
      }
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer: { unref?: () => void } = setTimeout(() => resolve(), ms);
        timer.unref?.();
      }),
    allowScreenFallback: options.allowScreenFallback,
  };
}
