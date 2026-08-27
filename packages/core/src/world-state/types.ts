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
  clipboardText?: string;
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

export interface ObservedTradeOffer {
  currency: string;
  amount: number;
  stackSize?: number;
}

export interface TradeWindowView {
  open: boolean;
  ourSlots: GridCell[];
  theirSlots: GridCell[];
  acceptEnabled?: boolean;
  counterOfferText?: string;
  observedOffer?: ObservedTradeOffer;
  ourItemFingerprint?: string;
  completed?: boolean;
  desynced?: boolean;
}

export type TradeState =
  | "Idle"
  | "TradeRequestReceived"
  | "ValidateRequestedItem"
  | "InviteOrJoinParty"
  | "PrepareItem"
  | "NavigateToTradeContext"
  | "OpenTrade"
  | "PlaceItem"
  | "ObserveCounterOffer"
  | "ValidateCurrencyOrItems"
  | "AcceptOrReject"
  | "ConfirmCompletion"
  | "CleanupPartySession"
  | "FailedOrTimedOut";

export type TradeEventSource = "fixture" | "client-log" | "ggg-test-interface";

export type TradeEventKind =
  | "whisper-trade-request"
  | "party-invite-accepted"
  | "party-joined"
  | "cancelled"
  | "disconnected"
  | "ui-desync"
  | "fixture";

export type TradePartyState = "none" | "invited" | "joined";

export interface ExpectedTrade {
  itemFingerprint: string;
  itemLabel?: string;
  currency: string;
  amount: number;
  amountTolerance?: number;
  stackSize?: number;
}

export interface TradeEvent {
  kind: TradeEventKind;
  source: TradeEventSource;
  atMs: number;
  requestedItemFingerprint?: string;
  requestedItemLabel?: string;
  expected?: ExpectedTrade;
  partyState?: TradePartyState;
  buyerAlias?: string;
}

export interface TradeSession {
  id: string;
  state: TradeState;
  enteredAtMs: number;
  expected?: ExpectedTrade;
  lastEvent?: string;
  lastReason?: string;
  partyState?: TradePartyState;
  requestedItemFingerprint?: string;
  failAfterCleanup?: boolean;
}

export interface TradeSessionRecord {
  id: string;
  scenarioId: string;
  state: TradeState;
  payloadJson: string;
  updatedAtMs: number;
}

export interface ListingUiView {
  open: boolean;
  itemFingerprint?: string;
  priceText?: string;
  currency?: string;
}

export type ListingState =
  | "Idle"
  | "SelectItem"
  | "OpenListingUi"
  | "ReadCurrentPrice"
  | "ApplyPrice"
  | "VerifyPrice"
  | "StaleReprice"
  | "FailedOrTimedOut"
  | "Done";

export interface ListingQuoteSnapshot {
  providerId: string;
  quotedAtMs: number;
  currency: string;
  low?: number;
  fair?: number;
  high?: number;
  candidateCount: number;
  comparableCount: number;
  confidence: ConfidenceBucket;
  lowConfidenceReason?: string;
}

export interface ListingCatalogItem {
  fingerprint: string;
  screenPoint?: PixelPoint;
  quote: ListingQuoteSnapshot;
  listedAtMs?: number;
}

export interface ListingSession {
  state: ListingState;
  fingerprint?: string;
  verifyAttempts: number;
  recommendedPrice?: number;
  currency?: string;
  lastEvent?: string;
  repricing?: boolean;
  openAttempts?: number;
}

export interface ListingHistoryRecord {
  id: string;
  fingerprint: string;
  price?: number;
  currency?: string;
  createdAtMs: number;
  result: string;
}

export interface PendingLootPickup {
  id: string;
  occupancy: number;
  clickedAtMs: number;
}

export interface StashItemMeta {
  class?: string;
  rarity?: string;
  category?: string;
  score?: number;
}

export interface PendingStashTransfer {
  fingerprint: string;
  from: { kind: "inventory" | "stash"; tabId?: string; x: number; y: number };
  to: { kind: "inventory" | "stash"; tabId?: string; x: number; y: number };
  kind: "tab-click" | "move";
  attempts: number;
  lastAttemptMs: number;
  destTabId: string;
  reason: string;
}

export interface WorldStateFlags {
  emergencyStopLatched: boolean;
  tradeRequested: boolean;
  tradeSession?: TradeSession | null;
  tradeExpected?: ExpectedTrade;
  tradeEvent?: TradeEvent | null;
  consumedTradeEventAtMs?: number;
  tradePartyState?: TradePartyState;
  tradeInContext?: boolean;
  tradeCancelled?: boolean;
  tradeDisconnected?: boolean;
  pendingTradeSessionWrite?: TradeSessionRecord | null;
  stashSessionActive: boolean;
  listingSessionActive: boolean;
  listingSession?: ListingSession | null;
  listingCatalog?: ListingCatalogItem[];
  pendingListingHistory?: ListingHistoryRecord | null;
  highValueInterruptScore: number;
  pendingLootPickup?: PendingLootPickup | null;
  lootSuppressedUntilMs?: Record<string, number>;
  lootAttemptCounts?: Record<string, number>;
  lootLastAttemptMs?: Record<string, number>;
  shadowMismatch?: boolean;
  stashItemCatalog?: Record<string, StashItemMeta>;
  pendingStashTransfer?: PendingStashTransfer | null;
  stashSafetyHold?: boolean;
  actionBudgetHold?: boolean;
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
