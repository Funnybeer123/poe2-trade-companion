import type {
  ListingUiView,
  LootTarget,
  Observation,
  TargetCue,
  TradeWindowView,
  UiModeState,
  WorldState,
  WorldStateFlags,
} from "../world-state/types.js";
import { detectGrids } from "./gridDetector.js";
import { detectLootLabels } from "./lootLabelDetector.js";
import type { OcrPort } from "./ocrPort.js";
import { analyzeFailureFrame } from "./uiMode.js";
import type { PerceptionAdapter, PerceptionFrame, PerceptionFrameInput } from "./types.js";

function isObservation(value: unknown): value is Observation<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "value" in value && "confidence" in value && "observedAtMs" in value;
}

function asObservation<T>(
  raw: unknown,
  capturedAtMs: number,
): Observation<T> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (isObservation(raw)) {
    return raw as Observation<T>;
  }
  return {
    value: raw as T,
    confidence: 1,
    observedAtMs: capturedAtMs,
    freshness: "fresh",
  };
}

export function derivedToPerceptionFrame(frame: PerceptionFrameInput): PerceptionFrame {
  const derived = frame.derived ?? {};
  const at = frame.capturedAtMs;
  return {
    tickId: frame.tickId,
    capturedAtMs: frame.capturedAtMs,
    evidenceId: `fixture:${String(frame.tickId)}`,
    target: asObservation<TargetCue | null>(derived.target, at),
    loot: asObservation<LootTarget[]>(derived.loot, at),
    inventory: asObservation<WorldState["inventory"]["value"]>(derived.inventory, at),
    stash: asObservation<WorldState["stash"]["value"]>(derived.stash, at),
    trade: asObservation<TradeWindowView | null>(derived.trade, at),
    listing: asObservation<ListingUiView | null>(derived.listing, at),
    ui: asObservation<UiModeState>(derived.ui, at),
    process: asObservation<WorldState["process"]["value"]>(derived.process, at),
    stuck: asObservation<WorldState["stuck"]["value"]>(derived.stuck, at),
    flags: derived.flags as Partial<WorldStateFlags> | undefined,
  };
}

export class FixturePerceptionAdapter implements PerceptionAdapter {
  readonly #ocr?: OcrPort;

  constructor(ocr?: OcrPort) {
    this.#ocr = ocr;
  }

  async analyze(frame: PerceptionFrameInput): Promise<PerceptionFrame> {
    try {
      const base = derivedToPerceptionFrame(frame);
      const grids = detectGrids(frame);
      const withGrids: PerceptionFrame = {
        ...base,
        inventory:
          grids.inventory === undefined
            ? base.inventory
            : {
                value: grids.inventory,
                confidence: base.inventory?.confidence ?? 0.85,
                observedAtMs: frame.capturedAtMs,
                freshness: "fresh",
                evidenceId: grids.evidenceId ?? base.inventory?.evidenceId,
              },
        stash:
          grids.stash === undefined
            ? base.stash
            : {
                value: grids.stash,
                confidence: base.stash?.confidence ?? 0.85,
                observedAtMs: frame.capturedAtMs,
                freshness: "fresh",
                evidenceId: grids.evidenceId ?? base.stash?.evidenceId,
              },
      };
      const detected = await detectLootLabels(frame, { ocr: this.#ocr });
      if (detected.source === "fixture" || detected.loot.length === 0) {
        return withGrids;
      }
      return {
        ...withGrids,
        loot: {
          value: detected.loot,
          confidence: detected.confidence,
          observedAtMs: frame.capturedAtMs,
          freshness: "fresh",
          evidenceId: detected.evidenceId,
        },
      };
    } catch (error) {
      return analyzeFailureFrame(frame, error);
    }
  }
}

export function createFixturePerceptionAdapter(ocr?: OcrPort): PerceptionAdapter {
  return new FixturePerceptionAdapter(ocr);
}
