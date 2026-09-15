/**
 * Renderer ↔ main contract for the campaign guide (feature "campaignGuide",
 * channels `campaign:*`). The data types live in src/core so the merge and
 * the sanitizers stay pure; they are re-exported here so renderer code has
 * one import. Types plus one runtime const: the panel id both halves name.
 */
import type { FeatureCall } from "./features.js";

export type {
  AreaResolution,
  CampaignAct,
  CampaignArea,
  CampaignCustomisations,
  CampaignCustomisePatch,
  CampaignGuideProgress,
  CampaignGuideSettings,
  CampaignObjective,
  CampaignOverlayAnchor,
  CampaignRouteFile,
  ExperienceEstimate,
  MergedAct,
  MergedArea,
  MergedObjective,
  MergedRoute,
  NextStep,
  ObjectiveKind,
  RewardTag,
} from "../core/campaignGuide.js";
export type { MapEdge, MapLayout, MapNode } from "../core/campaignGuideMap.js";

import type {
  AreaResolution,
  CampaignCustomisePatch,
  CampaignGuideSettings,
  ExperienceEstimate,
  MergedRoute,
  NextStep,
} from "../core/campaignGuide.js";

export interface CampaignBundledInfo {
  source: "file" | "missing";
  path: string;
  issues: string[];
  areaCount: number;
  updatedAt: string;
}

export interface CampaignRouteView {
  merged: MergedRoute;
  bundled: CampaignBundledInfo;
  settings: CampaignGuideSettings;
  progressRevision: number;
  importIssues?: string[];
  generatedAt: string;
}

export interface CampaignStateView {
  /** From the latest area event (the 2 MB backfill included). */
  current?: AreaResolution & { observedLevel: number; at: string; seed: number };
  character?: { name?: string; className?: string; level: number; seenAt?: string; source: "log" | "override" };
  /** Only when both the observed area level and the character level are known. */
  experience?: ExperienceEstimate;
  next?: NextStep;
  /** `visible` is `overlay.isVisible("campaign")` at view time, never a cached flag. */
  overlay: { visible: boolean; autoShown: boolean; dismissedForAreaId?: string };
  /**
   * Bumped on every progress write (visit / tick / reset); a consumer whose
   * route view carries a lower number pulls `campaign:route` again.
   */
  progressRevision: number;
  clientLog: { watching: boolean; error?: string };
  generatedAt: string;
}

export interface CampaignContract {
  "campaign:route": FeatureCall<[], CampaignRouteView>;
  "campaign:state": FeatureCall<[], CampaignStateView>;
  /** Throws "campaign-patch-object-required" / "campaign-patch-rejected:<issue>". */
  "campaign:customise": FeatureCall<[patch: CampaignCustomisePatch], CampaignRouteView>;
  "campaign:set-character-level": FeatureCall<[level: number | null], CampaignStateView>;
  /** Re-reads the last 16 MiB of Client.txt for a level-up line. */
  "campaign:rescan-level": FeatureCall<[], CampaignStateView>;
  "campaign:show-overlay": FeatureCall<[areaId?: string], CampaignStateView>;
  "campaign:hide-overlay": FeatureCall<[], CampaignStateView>;
  "campaign:toggle-overlay": FeatureCall<[], CampaignStateView>;
  "campaign:export": FeatureCall<[], { json: string; copied: boolean }>;
  /**
   * Refuses JSON over 2 MiB with "campaign-import-too-large" before parsing,
   * and a missing or unknown `mode` with "campaign-import-bad-mode" — there is
   * no default, because the wrong one erases every customisation.
   */
  "campaign:import": FeatureCall<
    [json: string, mode: "replace-customisations" | "merge"],
    CampaignRouteView
  >;
  "campaign:open-wiki": FeatureCall<[areaId: string], { opened: boolean; url?: string }>;
}

export interface CampaignEvents {
  "campaign:state": CampaignStateView;
  "campaign:route-changed": CampaignRouteView;
}

/** Payload main attaches to overlay.show/update("campaign", …). */
export interface CampaignPanelPayload {
  areaId?: string;
  compact: boolean;
  reason: "auto" | "hotkey" | "desktop";
}

/** The overlay panel id, used by main and named in panels.ts by the integrator. */
export const CAMPAIGN_PANEL_ID = "campaign";
