import { contextBridge, ipcRenderer } from "electron";
import type {
  ImportBuildTargetsRequest,
  IntelligenceExportRequest,
  IpcEventChannel,
  IpcInvoker,
  IpcSubscriber,
  ItemIntelligenceEventContract,
  LegacyImportRequest,
  SaveBuildProfileRequest,
  SaveRuleSetRequest,
  ScannerRuntimeEvent,
  ScannerStartRequest,
} from "../shared/ipc.js";
import type { SearchRegexRequest } from "../core/searchRegex.js";

const invoke = ((channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args)) as IpcInvoker;

const subscribe = (<C extends IpcEventChannel>(
  channel: C,
  callback: (payload: ItemIntelligenceEventContract[C]) => void,
) => {
  const listener = (
    _event: Electron.IpcRendererEvent,
    payload: ItemIntelligenceEventContract[C],
  ) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}) as IpcSubscriber;

contextBridge.exposeInMainWorld("poe2", {
  mode: () => invoke("runtime:mode"),
  fromClipboard: () => invoke("item:from-clipboard"),
  evaluateText: (text: string) => invoke("item:evaluate-text", text),
  windows: () => ipcRenderer.invoke("poe:windows"),
  killLatched: () => ipcRenderer.invoke("qa:kill-latched"),
  rearm: () => ipcRenderer.invoke("qa:rearm"),
  generateFilter: (options: { hideBelowScore: number; highlightUniques: boolean; name: string }) =>
    ipcRenderer.invoke("filter:generate", options),
  onItem: (callback: (payload: ItemIntelligenceEventContract["item:evaluated"]) => void) =>
    subscribe("item:evaluated", callback),
  intelligence: {
    catalog: {
      list: () => invoke("catalog:list"),
      remove: (id: string) => invoke("catalog:remove", id),
      onChanged: (callback: (items: ItemIntelligenceEventContract["catalog:changed"]) => void) =>
        subscribe("catalog:changed", callback),
    },
    rules: {
      list: () => invoke("rules:list"),
      save: (request: SaveRuleSetRequest) => invoke("rules:save", request),
      remove: (id: string) => invoke("rules:remove", id),
      validate: (ruleText: string) => invoke("rules:validate", ruleText),
      generateSearch: (request: SearchRegexRequest) =>
        invoke("rules:generate-search", request),
      onChanged: (callback: (items: ItemIntelligenceEventContract["rules:changed"]) => void) =>
        subscribe("rules:changed", callback),
    },
    builds: {
      list: () => invoke("builds:list"),
      save: (request: SaveBuildProfileRequest) => invoke("builds:save", request),
      remove: (id: string) => invoke("builds:remove", id),
      activate: (id?: string) => invoke("builds:activate", id),
      importTargets: (request: ImportBuildTargetsRequest) =>
        invoke("builds:import-targets", request),
      onChanged: (callback: (items: ItemIntelligenceEventContract["builds:changed"]) => void) =>
        subscribe("builds:changed", callback),
    },
    imports: {
      legacy: (request: LegacyImportRequest) =>
        invoke("imports:legacy", request),
    },
    exports: {
      data: (request: IntelligenceExportRequest) =>
        invoke("exports:data", request),
    },
    scans: {
      list: () => invoke("scans:list"),
      get: (id: string) => invoke("scans:get", id),
    },
  },
  scanner: {
    status: () => ipcRenderer.invoke("scanner:status"),
    start: (request: ScannerStartRequest) =>
      ipcRenderer.invoke("scanner:start", request),
    stop: () => ipcRenderer.invoke("scanner:stop"),
    onEvent: (callback: (payload: ScannerRuntimeEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ScannerRuntimeEvent,
      ) => callback(payload);
      ipcRenderer.on("scanner:event", listener);
      return () => ipcRenderer.removeListener("scanner:event", listener);
    },
  },
  stashSort: {
    status: () => ipcRenderer.invoke("stash-sort:status"),
    start: (request: unknown) => ipcRenderer.invoke("stash-sort:start", request),
    stop: () => ipcRenderer.invoke("stash-sort:stop"),
    rearm: () => ipcRenderer.invoke("qa:rearm"),
    onEvent: (cb: (payload: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
      ipcRenderer.on("stash-sort:event", listener);
      return () => ipcRenderer.removeListener("stash-sort:event", listener);
    },
  },
  assistive: {
    status: () => ipcRenderer.invoke("assistive:status"),
    start: (request: unknown) => ipcRenderer.invoke("assistive:start", request),
    stop: () => ipcRenderer.invoke("assistive:stop"),
    rearm: () => ipcRenderer.invoke("qa:rearm"),
    memoryStatus: (payload: unknown) => ipcRenderer.invoke("assistive:memory-status", payload),
    resetMemory: (payload: unknown) => ipcRenderer.invoke("assistive:memory-reset", payload),
    onEvent: (cb: (payload: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
      ipcRenderer.on("assistive:event", listener);
      return () => ipcRenderer.removeListener("assistive:event", listener);
    },
    voice: {
      status: () => ipcRenderer.invoke("voice:status"),
      configure: (config: unknown) => ipcRenderer.invoke("voice:configure", config),
      trigger: () => ipcRenderer.invoke("voice:trigger"),
      cancel: () => ipcRenderer.invoke("voice:cancel"),
      onState: (cb: (payload: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
        ipcRenderer.on("voice:state", listener);
        return () => ipcRenderer.removeListener("voice:state", listener);
      },
    },
  },
  calibration: {
    profile: () => ipcRenderer.invoke("cal:profile"),
    save: (profile: unknown) => ipcRenderer.invoke("cal:save", profile),
    reset: () => ipcRenderer.invoke("cal:reset"),
    monitors: () => ipcRenderer.invoke("cal:monitors"),
    target: () => ipcRenderer.invoke("cal:target"),
    capture: (profile?: unknown) => ipcRenderer.invoke("cal:capture", profile),
    look: (profile: unknown) => ipcRenderer.invoke("cal:look", profile),
    diagnose: (payload: unknown) => ipcRenderer.invoke("cal:diagnose", payload),
    exportDiagnostic: (payload: unknown) => ipcRenderer.invoke("cal:export-diagnostic", payload),
    stamp: (payload: unknown) => ipcRenderer.invoke("cal:stamp", payload),
    walkNpc: (npc: unknown) => ipcRenderer.invoke("cal:walk-npc", npc),
  },
});
