/**
 * The ordered list of feature modules the main process registers at start-up.
 * Order matters: a module may `ctx.require()` a service that an earlier
 * module `ctx.provide()`d, so foundations come first.
 *
 * Integration adds one line per shipped feature; features themselves never
 * edit this file (see docs/HANDOFF-overlay-port.md).
 */
import type { FeatureModule } from "./types.js";
import { clientLogModule } from "./clientLog/index.js";
import { hotkeysModule } from "./hotkeys/index.js";
import { overlayModule } from "./overlay/index.js";
import { chatCommandsModule } from "./chatCommands/index.js";
import { liveSearchModule } from "./liveSearch/index.js";
import { evaluateModule } from "./evaluate/index.js";
import { inspectModule } from "./inspect/index.js";
import { marketModule } from "./market/index.js";
import { tradeModule } from "./trade/index.js";
import { commandsBookmarksNotesModule } from "./commandsBookmarksNotes/index.js";
import { stashTrackerModule } from "./stashTracker/index.js";
import { sessionModule } from "./session/index.js";
import { campaignGuideModule } from "./campaignGuide/index.js";
import { pricingHistoryModule } from "./pricingHistory/index.js";
import { appSettingsModule } from "./appSettings/index.js";
import { priceTrainingModule } from "./priceTraining/index.js";

export const FEATURE_MODULES: readonly FeatureModule[] = [
  // Foundations (order matters):
  clientLogModule,
  hotkeysModule,
  overlayModule,
  chatCommandsModule,
  liveSearchModule,
  // Features:
  evaluateModule,
  inspectModule,
  marketModule,
  tradeModule,
  commandsBookmarksNotesModule,
  stashTrackerModule,
  sessionModule,
  campaignGuideModule,
  pricingHistoryModule,
  priceTrainingModule,
  appSettingsModule,
];
