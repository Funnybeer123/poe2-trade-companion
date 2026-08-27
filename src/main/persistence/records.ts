import type { BuildProfile, GearTarget } from "../../core/buildProfiles.js";

export interface PersistedTimestamps {
  createdAt: string;
  updatedAt: string;
}

export interface CatalogItemInput {
  id?: string;
  fingerprint: string;
  name: string;
  baseType: string;
  itemClass: string;
  currentLocation: string;
  recommendation?: string;
  fairValue?: number;
  payload?: unknown;
}

export interface CatalogItemRecord
  extends Omit<CatalogItemInput, "id" | "payload">,
    PersistedTimestamps {
  id: string;
  payload: unknown;
}

export interface ItemObservationInput {
  id?: string;
  catalogItemId: string;
  observedAt: string;
  source: string;
  location: string;
  confidence?: number;
  payload?: unknown;
}

export interface ItemObservationRecord
  extends Omit<ItemObservationInput, "id" | "payload">,
    PersistedTimestamps {
  id: string;
  payload: unknown;
}

export interface ValuationInput {
  id?: string;
  catalogItemId: string;
  providerName: string;
  marketTimestamp: string;
  currency: string;
  low: number;
  fair: number;
  high: number;
  confidence: string;
  sampleSize: number;
  payload?: unknown;
}

export interface ValuationRecord
  extends Omit<ValuationInput, "id" | "payload">,
    PersistedTimestamps {
  id: string;
  payload: unknown;
}

export interface RuleSetInput {
  id?: string;
  kind: string;
  name: string;
  schemaVersion?: number;
  rules: unknown;
  active?: boolean;
}

export interface RuleSetRecord
  extends Omit<RuleSetInput, "id" | "schemaVersion" | "active">,
    PersistedTimestamps {
  id: string;
  schemaVersion: number;
  active: boolean;
}

export interface PresetInput {
  id?: string;
  kind: string;
  name: string;
  schemaVersion?: number;
  payload: unknown;
}

export interface PresetRecord
  extends Omit<PresetInput, "id" | "schemaVersion">,
    PersistedTimestamps {
  id: string;
  schemaVersion: number;
}

export type BuildProfileRecord = BuildProfile;
export type GearTargetRecord = GearTarget & { profileId: string };

export interface ScanSessionInput {
  id?: string;
  profileId?: string;
  source: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  summary?: unknown;
}

export interface ScanSessionRecord
  extends Omit<ScanSessionInput, "id" | "summary">,
    PersistedTimestamps {
  id: string;
  summary: unknown;
}

export interface ScanSlotInput {
  id?: string;
  sessionId: string;
  slotKey: string;
  ordinal: number;
  status: string;
  itemFingerprint?: string;
  scannedAt?: string;
  payload?: unknown;
}

export interface ScanSlotRecord
  extends Omit<ScanSlotInput, "id" | "payload">,
    PersistedTimestamps {
  id: string;
  payload: unknown;
}

export interface SettingInput {
  key: string;
  schemaVersion?: number;
  value: unknown;
}

export interface SettingRecord extends PersistedTimestamps {
  key: string;
  schemaVersion: number;
  value: unknown;
}

export interface ProvenanceInput {
  id?: string;
  entityType: string;
  entityId: string;
  sourceType: string;
  sourceKey: string;
  sourceUri?: string;
  sourceDigest?: string;
  importedAt?: string;
  payload?: unknown;
}

export interface ProvenanceRecord
  extends Omit<ProvenanceInput, "id" | "importedAt" | "payload">,
    PersistedTimestamps {
  id: string;
  importedAt: string;
  payload: unknown;
}
