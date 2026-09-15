/**
 * The overlay panel registry. Every panel main can show (`overlay.show(id)`)
 * is declared here so the panel host can lazy-load its component and knows
 * the title, default anchor and size. Integration appends feature panels
 * (evaluate, inspect, trade, notes, stash-search, web, campaign,
 * stash-prices, session-recap); the built-in "notice" toast ships with the
 * foundation.
 */
import type { Component } from "vue";
import type { OverlayAnchor } from "../../shared/overlay.js";

export interface OverlayPanelDefinition {
  id: string;
  title: string;
  /** Lazy, so the overlay bundle only loads what is shown. */
  component: () => Promise<{ default: Component }>;
  defaultAnchor: OverlayAnchor;
  defaultSize: { width: number; height: number };
  resizable?: boolean;
}

/** Any feature can show a short notice: `overlay.show("notice", { anchor: "top-right", payload: { title, body, tone, ttlMs } })`. */
export const NOTICE_PANEL: OverlayPanelDefinition = {
  id: "notice",
  title: "Notice",
  component: () => import("./NoticePanel.vue"),
  defaultAnchor: "top-right",
  defaultSize: { width: 340, height: 120 },
};

export const OVERLAY_PANELS: OverlayPanelDefinition[] = [
  NOTICE_PANEL,
  {
    id: "evaluate",
    title: "Evaluate",
    component: () => import("../features/evaluate/EvaluateOverlayPanel.vue"),
    defaultAnchor: "cursor",
    defaultSize: { width: 620, height: 560 },
    resizable: true,
  },
  {
    id: "inspect",
    title: "Inspect",
    component: () => import("../features/inspect/InspectPanel.vue"),
    defaultAnchor: "cursor",
    defaultSize: { width: 440, height: 560 },
    resizable: true,
  },
  {
    id: "trade",
    title: "Trade",
    component: () => import("../features/trade/panels/TradePanel.vue"),
    defaultAnchor: "top-right",
    defaultSize: { width: 380, height: 260 },
    resizable: true,
  },
  {
    id: "notes",
    title: "Notes",
    component: () => import("../features/commandsBookmarksNotes/panels/NotesPanel.vue"),
    defaultAnchor: "left",
    defaultSize: { width: 440, height: 380 },
  },
  {
    id: "stash-search",
    title: "Stash search",
    component: () => import("../features/commandsBookmarksNotes/panels/StashSearchPanel.vue"),
    defaultAnchor: "cursor",
    defaultSize: { width: 380, height: 220 },
  },
  {
    id: "stash-prices",
    title: "Stash prices",
    component: () => import("../features/stashTracker/panels/StashPricesPanel.vue"),
    defaultAnchor: "bottom-right",
    defaultSize: { width: 300, height: 168 },
  },
  {
    id: "session-recap",
    title: "Session recap",
    component: () => import("../features/session/panels/SessionRecapPanel.vue"),
    defaultAnchor: "center",
    defaultSize: { width: 380, height: 300 },
  },
  {
    id: "campaign",
    title: "Campaign guide",
    component: () => import("../features/campaignGuide/CampaignPanel.vue"),
    defaultAnchor: "right",
    defaultSize: { width: 380, height: 520 },
    resizable: false,
  },
];

export function findOverlayPanel(id: string): OverlayPanelDefinition | undefined {
  return OVERLAY_PANELS.find((panel) => panel.id === id);
}
