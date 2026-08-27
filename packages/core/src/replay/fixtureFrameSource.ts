import type { FrameSource, PerceptionFrameInput } from "../perception/types.js";
import type { ReplayManifest, ReplayManifestFrame } from "./types.js";

export const DEFAULT_REPLAY_FRAME_WIDTH = 1920;
export const DEFAULT_REPLAY_FRAME_HEIGHT = 1080;

export function manifestFrameToInput(frame: ReplayManifestFrame): PerceptionFrameInput {
  return {
    tickId: frame.tickId,
    capturedAtMs: frame.atMs,
    width: DEFAULT_REPLAY_FRAME_WIDTH,
    height: DEFAULT_REPLAY_FRAME_HEIGHT,
    pngPath: frame.pngPath,
    derived: frame.derived,
  };
}

export class FixtureFrameSource implements FrameSource {
  readonly #frames: PerceptionFrameInput[];
  #index = 0;

  constructor(frames: PerceptionFrameInput[]) {
    this.#frames = frames;
  }

  static fromManifest(manifest: ReplayManifest): FixtureFrameSource {
    return new FixtureFrameSource(manifest.frames.map(manifestFrameToInput));
  }

  async nextFrame(): Promise<PerceptionFrameInput | null> {
    if (this.#index >= this.#frames.length) {
      return null;
    }
    const frame = this.#frames[this.#index];
    this.#index += 1;
    return frame ?? null;
  }
}
