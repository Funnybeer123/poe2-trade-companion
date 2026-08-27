export const PERCEPTION_UNAVAILABLE = "perception-unavailable";

export class PerceptionUnavailableError extends Error {
  readonly code = PERCEPTION_UNAVAILABLE;

  constructor(detail: string) {
    super(`${PERCEPTION_UNAVAILABLE}: ${detail}`);
    this.name = "PerceptionUnavailableError";
  }
}
