export type RuntimeMode = "public-companion" | "authorized-qa" | "assistive-access";

export type AutomationModule =
  | "navigation"
  | "loot"
  | "stash"
  | "listing"
  | "trading";

export type RecommendationCategory =
  | "keep"
  | "sell"
  | "vendor"
  | "craft"
  | "dump"
  | "bulk";

export type ConfidenceBucket = "high" | "medium" | "low" | "none";

export interface ItemSnapshot {
  rawText: string;
  capturedAt: string;
  source: "clipboard" | "ocr" | "fixture";
}

export type ItemModKind =
  | "implicit"
  | "explicit"
  | "crafted"
  | "fractured"
  | "enchant"
  | "unknown";

export interface ItemNumericRoll {
  /** Zero-based position of this number within its source line. */
  index: number;
  value: number;
  raw: string;
  unit?: string;
  start: number;
  end: number;
}

export interface ItemProperty {
  name: string;
  value: string;
  text: string;
  rawText: string;
  block: number;
  order: number;
  line: number;
  values: number[];
  rolls: ItemNumericRoll[];
  augmented?: boolean;
}

export type ItemSectionKind =
  | "header"
  | "properties"
  | "requirements"
  | "sockets"
  | "item-level"
  | "modifiers"
  | "status"
  | "description"
  | "unknown";

export interface ItemSection {
  /** Separator-delimited, zero-based block index. */
  block: number;
  order: number;
  kind: ItemSectionKind;
  /** Original non-separator lines, in source order. */
  lines: string[];
  rawLines: string[];
  rawText: string;
  startLine: number;
  endLine: number;
  properties: ItemProperty[];
  mods: ItemMod[];
}

export interface ItemMod {
  text: string;
  value?: number;
  value2?: number;
  unit?: string;
  implicit?: boolean;
  kind?: ItemModKind;
  block?: number;
  order?: number;
  line?: number;
  rawText?: string;
  tags?: string[];
  values?: number[];
  rolls?: ItemNumericRoll[];
}

export interface ItemModifierBlock {
  block: number;
  order: number;
  rawLines: string[];
  mods: ItemMod[];
}

export interface NormalizedItem {
  itemClass: string;
  rarity: string;
  name: string;
  baseType: string;
  itemLevel?: number;
  quality?: number;
  sockets?: string;
  requirements: Record<string, number>;
  mods: ItemMod[];
  identified: boolean;
  fingerprint: string;
  gridW?: number;
  gridH?: number;
  /** Rich parser fields are optional to preserve old hand-built NormalizedItem values. */
  rawText?: string;
  rawSections?: string[][];
  sections?: ItemSection[];
  properties?: ItemProperty[];
  defenses?: ItemProperty[];
  modifierBlocks?: ItemModifierBlock[];
  corrupted?: boolean;
}

export interface ParsedItem extends NormalizedItem {
  rawText: string;
  rawSections: string[][];
  sections: ItemSection[];
  properties: ItemProperty[];
  defenses: ItemProperty[];
  modifierBlocks: ItemModifierBlock[];
  corrupted: boolean;
}

export interface MarketComparable {
  listingId: string;
  priceAmount: number;
  priceCurrency: string;
  listedAt?: string;
}

export interface MarketQuote {
  providerId: string;
  fetchedAt: string;
  comparables: MarketComparable[];
}

export interface QuoteContext {
  league: string;
  currency: string;
}

export interface ProviderHealth {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface MarketProvider {
  id: string;
  supports(item: NormalizedItem): boolean;
  quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote>;
  health(): Promise<ProviderHealth>;
}

export interface ValuationResult {
  itemIdentifier: string;
  itemType: string;
  normalizedKeyStats: Record<string, number | string>;
  providerName: string;
  marketTimestamp: string;
  candidateCount: number;
  comparablesUsed: number;
  low: number;
  fair: number;
  high: number;
  recommendedListing: number;
  currency: string;
  confidence: ConfidenceBucket;
  lowConfidenceReason?: string;
}

export interface DesirabilityResult {
  score: number;
  category: RecommendationCategory;
  reasons: string[];
}

export interface ObservedInventoryState {
  cells: Array<{ row: number; col: number; occupied: boolean; fingerprint?: string }>;
  freeCells: number;
  capturedAt: string;
  stale: boolean;
}

export interface ObservedStashState {
  activeTab: string;
  tabs: string[];
  cells: Array<{ row: number; col: number; occupied: boolean; fingerprint?: string }>;
  capturedAt: string;
  stale: boolean;
}

export interface CatalogItem {
  fingerprint: string;
  name: string;
  baseType: string;
  itemClass: string;
  location: string;
  recommendation?: RecommendationCategory;
  fairValue?: number;
}

export interface SortRecommendation {
  fingerprint: string;
  destinationTab: string;
  category: RecommendationCategory;
  reason: string;
}

export interface SaleRecommendation {
  fingerprint: string;
  recommendedListing: number;
  currency: string;
  reason: string;
}

export interface LootTarget {
  id: string;
  label: string;
  screenX: number;
  screenY: number;
  desirability?: number;
}

export interface NavigationTarget {
  id: string;
  screenX: number;
  screenY: number;
  confidence: number;
}

export interface PerceptionFrame {
  timestamp: string;
  windowTitle: string;
  processName: string;
  navigationTarget?: NavigationTarget;
  loot: LootTarget[];
  inventory?: ObservedInventoryState;
  stash?: ObservedStashState;
  tradeWindowOpen?: boolean;
  offeredCurrencyAmount?: number;
  offeredCurrencyType?: string;
  placedItemFingerprint?: string;
  uiMode?: string;
  evidenceHash: string;
  confidence: number;
}

export type InputKind = "key" | "click" | "move" | "type" | "wait" | "drag" | "focus";

export interface InputAction {
  kind: InputKind;
  key?: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  button?: "left" | "right";
  text?: string;
  durationMs?: number;
}

export interface BotDecision {
  module: AutomationModule | "orchestrator";
  rule: string;
  reason: string;
  intended: InputAction[];
  confidence: number;
}

export interface AutomationScenario {
  id: string;
  name: string;
  enabledModules: AutomationModule[];
  dryRun: boolean;
  actionsPerMinute: number;
  confidenceThreshold: number;
  retryLimit: number;
  timingProfile: "tight" | "humanized";
  followTargetId?: string;
  lootScoreThreshold: number;
  stashRules: Record<RecommendationCategory, string>;
  expectedTradePrice?: number;
  expectedCurrency?: string;
}

export interface QaActionTrace {
  timestamp: string;
  scenarioId: string;
  module: string;
  mode: RuntimeMode;
  processName: string;
  evidenceHash: string;
  confidence: number;
  decisionRule: string;
  reason: string;
  input: InputAction | null;
  result?: string;
}

export interface SafetyContext {
  mode: RuntimeMode;
  killSwitchLatched: boolean;
  dryRun: boolean;
  processAllowed: boolean;
  moduleEnabled: boolean;
  confidence: number;
  confidenceThreshold: number;
  actionsThisMinute: number;
  actionsPerMinute: number;
}
