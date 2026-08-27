import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./ipcChannels.js";

contextBridge.exposeInMainWorld("poe2tcBanner", {
  getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.getCapabilities),
  tripStop: () => ipcRenderer.invoke(IPC_CHANNELS.tripStop),
});
