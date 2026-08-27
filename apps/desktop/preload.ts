import { contextBridge, ipcRenderer } from "electron";
import type {
  AutomationScenarioDto,
  FilterProfileDto,
  OperatorSettingsDto,
  Poe2tcPreloadApi,
} from "@poe2tc/core";
import { IPC_CHANNELS } from "./ipcChannels.js";

const api: Poe2tcPreloadApi = {
  getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.getCapabilities),
  getWorldState: () => ipcRenderer.invoke(IPC_CHANNELS.getWorldState),
  getTraces: () => ipcRenderer.invoke(IPC_CHANNELS.getTraces),
  armQa: () => ipcRenderer.invoke(IPC_CHANNELS.armQa),
  disarmQa: () => ipcRenderer.invoke(IPC_CHANNELS.disarmQa),
  tripStop: () => ipcRenderer.invoke(IPC_CHANNELS.tripStop),
  rearmStop: () => ipcRenderer.invoke(IPC_CHANNELS.rearmStop),
  runReplay: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.runReplay, id),
  parseClipboard: (text?: string) => ipcRenderer.invoke(IPC_CHANNELS.parseClipboard, text),
  exportFilter: (profile?: FilterProfileDto) => ipcRenderer.invoke(IPC_CHANNELS.exportFilter, profile),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings: OperatorSettingsDto) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  getCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.getCatalog),
  getScenarios: () => ipcRenderer.invoke(IPC_CHANNELS.getScenarios),
  saveScenario: (scenario: AutomationScenarioDto) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveScenario, scenario),
};

contextBridge.exposeInMainWorld("poe2tc", api);
