import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("poe2tc", {
  appName: "PoE2 QA Trade Companion",
});
