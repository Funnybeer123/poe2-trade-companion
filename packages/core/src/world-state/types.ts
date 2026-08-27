export type IsoTimestamp = string;
export type HexSha256 = string;
export type ScenarioId = string;
export type ModuleId =
  | "follow"
  | "loot"
  | "inventory"
  | "stash"
  | "listing"
  | "trade"
  | "recovery"
  | "orchestrator"
  | "perception"
  | "input";

export type Confidence = number; // 0..1 inclusive
export type ConfidenceBucket = "high" | "medium" | "low" | "none";
export type Freshness = "fresh" | "aging" | "stale" | "missing";

export type LowConfidencePolicy = "skip" | "confirm" | "adversarial-execute";

export type RuntimeMode = "public-companion" | "authorized-qa";

export type AutomationStateId =
  | "EmergencyStop"
  | "SafetyHold"
  | "TradeSession"
  | "InventoryFull"
  | "HighValueLoot"
  | "Listing"
  | "StashSort"
  | "LootPickup"
  | "Follow"
  | "RecoverTarget"
  | "Idle";

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Observation<T> {
  value: T;
  confidence: Confidence;
  observedAtMs: number;
  freshness: Freshness;
  evidenceId?: string;
}

export interface TargetCue {
  identity: string;
  boundingBox?: PixelBox;
  screenPoint?: PixelPoint;
  estimatedDistance?: "near" | "mid" | "far" | "unknown";
}

export interface LootTarget {
  id: string;
  labelText?: string;
  screenPoint: PixelPoint;
  boundingBox?: PixelBox;
  rarityCue?: string;
  score?: number;
  skipReason?: string;
}

export interface GridCell {
  tabId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  occupied: boolean;
  itemFingerprint?: string;
}

export interface UiModeState {
  kind:
    | "unknown"
    | "gameplay"
    | "inventory"
    | "stash"
    | "trade"
    | "listing"
    | "dialog"
    | "loading";
  details?: string;
}

export interface TradeWindowView {
  open: boolean;
  ourSlots: GridCell[];
  theirSlots: GridCell[];
  acceptEnabled?: boolean;
  counterOfferText?: string;
}

export interface ListingUiView {
  open: boolean;
  itemFingerprint?: string;
  priceText?: string;
  currency?: string;
}

export interface WorldStateFlags {
  emergencyStopLatched: boolean;
  tradeRequested: boolean;
  stashSessionActive: boolean;
  listingSessionActive: boolean;
  highValueInterruptScore: number;
}

export interface WorldState {
  tickId: number;
  capturedAtMs: number;
  clockMs: number;
  runtimeMode: RuntimeMode;
  selectedState: AutomationStateId;
  previousState: AutomationStateId;
  activeScenarioId: ScenarioId;
  process: Observation<{
    pid?: number;
    name?: string;
    title?: string;
    allowlisted: boolean;
  }>;
  target: Observation<TargetCue | null>;
  loot: Observation<LootTarget[]>;
  inventory: Observation<{
    occupied: number;
    capacity: number;
    cells: GridCell[];
    full: boolean;
  }>;
  stash: Observation<{
    tabId?: string;
    tabName?: string;
    cells: GridCell[];
    tabFull: boolean;
  }>;
  trade: Observation<TradeWindowView | null>;
  listing: Observation<ListingUiView | null>;
  ui: Observation<UiModeState>;
  stuck: Observation<StuckObservationValue>;
  flags: WorldStateFlags;
}

export interface StuckObservationValue {
  isStuck: boolean;
  reason?: string;
  ticks?: number;
  lostTargetTicks?: number;
}
