export const IPC_CHANNELS = {
  getCapabilities: "poe2tc:getCapabilities",
  getWorldState: "poe2tc:getWorldState",
  getTraces: "poe2tc:getTraces",
  armQa: "poe2tc:armQa",
  disarmQa: "poe2tc:disarmQa",
  tripStop: "poe2tc:tripStop",
  rearmStop: "poe2tc:rearmStop",
  runReplay: "poe2tc:runReplay",
  parseClipboard: "poe2tc:parseClipboard",
  exportFilter: "poe2tc:exportFilter",
  getSettings: "poe2tc:getSettings",
  saveSettings: "poe2tc:saveSettings",
  getCatalog: "poe2tc:getCatalog",
  getScenarios: "poe2tc:getScenarios",
  saveScenario: "poe2tc:saveScenario",
  getBuildFlags: "poe2tc:getBuildFlags",
  completeFirstRun: "poe2tc:completeFirstRun",
  priceCheckResult: "poe2tc:priceCheckResult",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
