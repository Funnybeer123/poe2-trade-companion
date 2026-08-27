import type { WindowInfo } from "../core/perception.js";

export function listAllowedWindows(allowlist: string[], windows: WindowInfo[]): WindowInfo[] {
  return windows.filter((window) =>
    allowlist.some((entry) => window.processName.toLowerCase().includes(entry.toLowerCase())),
  );
}

export function captureStubFrame(window: WindowInfo) {
  return {
    processName: window.processName,
    windowTitle: window.title,
    width: 1920,
    height: 1080,
  };
}
