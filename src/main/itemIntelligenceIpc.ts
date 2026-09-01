import type { IpcMain } from "electron";
import type {
  ImportBuildTargetsRequest,
  IntelligenceExportRequest,
  IpcChannel,
  LegacyImportRequest,
  SaveBuildProfileRequest,
  SaveRuleSetRequest,
  SaveValueTierConfigRequest,
} from "../shared/ipc.js";
import type { PriceTable } from "../core/priceTable.js";
import type { SearchRegexRequest } from "../core/searchRegex.js";
import type { ItemIntelligenceService } from "./itemIntelligenceService.js";

const CHANNELS = [
  "catalog:list",
  "catalog:remove",
  "rules:list",
  "rules:save",
  "rules:remove",
  "rules:validate",
  "rules:generate-search",
  "builds:list",
  "builds:save",
  "builds:remove",
  "builds:activate",
  "builds:import-targets",
  "imports:legacy",
  "exports:data",
  "scans:list",
  "scans:get",
  "tiers:get",
  "tiers:save",
  "tiers:evaluate",
  "prices:get",
  "prices:save",
] as const satisfies readonly IpcChannel[];

function objectRequest<T extends object>(value: unknown, label: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}-object-required`);
  }
  return value as T;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ipc-id-required");
  }
  return value.trim();
}

export function registerItemIntelligenceIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  service: ItemIntelligenceService,
): () => void {
  for (const channel of CHANNELS) ipc.removeHandler(channel);

  ipc.handle("catalog:list", () => service.listCatalog());
  ipc.handle("catalog:remove", (_event, id: unknown) =>
    service.removeCatalogItem(requiredId(id)),
  );
  ipc.handle("rules:list", () => service.listRuleSets());
  ipc.handle("rules:save", (_event, value: unknown) =>
    service.saveRuleSet(
      objectRequest<SaveRuleSetRequest>(value, "rule-save-request"),
    ),
  );
  ipc.handle("rules:remove", (_event, id: unknown) =>
    service.removeRuleSet(requiredId(id)),
  );
  ipc.handle("rules:validate", (_event, value: unknown) =>
    service.validateRule(typeof value === "string" ? value : ""),
  );
  ipc.handle("rules:generate-search", (_event, value: unknown) =>
    service.generateSearch(
      objectRequest<SearchRegexRequest>(value, "search-regex-request"),
    ),
  );
  ipc.handle("builds:list", () => service.listBuildProfiles());
  ipc.handle("builds:save", (_event, value: unknown) => {
    const request = objectRequest<SaveBuildProfileRequest>(
      value,
      "build-save-request",
    );
    return service.saveBuildProfile(request.profile);
  });
  ipc.handle("builds:remove", (_event, id: unknown) =>
    service.removeBuildProfile(requiredId(id)),
  );
  ipc.handle("builds:activate", (_event, id: unknown) =>
    service.activateBuildProfile(
      typeof id === "string" && id.trim() ? id.trim() : undefined,
    ),
  );
  ipc.handle("builds:import-targets", (_event, value: unknown) =>
    service.importBuildTargets(
      objectRequest<ImportBuildTargetsRequest>(value, "build-import-request"),
    ),
  );
  ipc.handle("imports:legacy", (_event, value: unknown) =>
    service.importLegacy(
      objectRequest<LegacyImportRequest>(value, "legacy-import-request"),
    ),
  );
  ipc.handle("exports:data", (_event, value: unknown) =>
    service.exportData(
      objectRequest<IntelligenceExportRequest>(value, "export-request"),
    ),
  );
  ipc.handle("scans:list", () => service.listScans());
  ipc.handle("scans:get", (_event, id: unknown) =>
    service.getScan(requiredId(id)),
  );
  ipc.handle("tiers:get", () => service.getValueTierConfig());
  ipc.handle("tiers:save", (_event, value: unknown) =>
    service.saveValueTierConfig(
      objectRequest<SaveValueTierConfigRequest>(value, "tier-save-request"),
    ),
  );
  ipc.handle("tiers:evaluate", (_event, value: unknown) =>
    service.evaluateTier(typeof value === "string" ? value : ""),
  );
  ipc.handle("prices:get", () => service.getPriceTable());
  ipc.handle("prices:save", (_event, value: unknown) =>
    service.savePriceTable(
      objectRequest<PriceTable>(value, "price-table"),
    ),
  );

  return () => {
    for (const channel of CHANNELS) ipc.removeHandler(channel);
  };
}
