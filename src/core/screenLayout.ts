export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GridCell {
  row: number;
  col: number;
  x: number;
  y: number;
}

export function clampToRect(x: number, y: number, rect: ScreenRect, pad = 8): { x: number; y: number } | null {
  const minX = rect.left + pad;
  const maxX = rect.left + rect.width - pad;
  const minY = rect.top + pad;
  const maxY = rect.top + rect.height - pad;
  if (maxX <= minX || maxY <= minY) return null;
  if (x < minX || x > maxX || y < minY || y > maxY) return null;
  return { x, y };
}

/** Normalized HUD boxes on the 16:9 gameplay image (not the raw window). */
export const HUD_FRACTIONS = {
  inventory: { x: 0.655, y: 0.36, w: 0.3, h: 0.5 },
  stash: { x: 0.05, y: 0.16, w: 0.46, h: 0.7 },
} as const;

export type DisplayMode = "windowed" | "fullscreen";

export function contentRect(client: ScreenRect, aspect = 16 / 9): ScreenRect {
  if (client.width <= 0 || client.height <= 0) {
    return { ...client };
  }
  const actual = client.width / client.height;
  if (actual > aspect + 0.02) {
    const width = client.height * aspect;
    return {
      left: client.left + (client.width - width) / 2,
      top: client.top,
      width,
      height: client.height,
    };
  }
  if (actual < aspect - 0.02) {
    const height = client.width / aspect;
    return {
      left: client.left,
      top: client.top + (client.height - height) / 2,
      width: client.width,
      height,
    };
  }
  return { ...client };
}

export interface MonitorOrigin {
  left: number;
  top: number;
}

export interface SelectedMonitor extends MonitorOrigin {
  id: number;
  label: string;
  width: number;
  height: number;
  primary?: boolean;
}

export function displayMode(
  client: ScreenRect,
  monitorWidth: number,
  monitorHeight: number,
  origin: MonitorOrigin = { left: 0, top: 0 },
): DisplayMode {
  const covers =
    Math.abs(client.left - origin.left) <= 2 &&
    Math.abs(client.top - origin.top) <= 2 &&
    client.width >= monitorWidth - 4 &&
    client.height >= monitorHeight - 4;
  return covers ? "fullscreen" : "windowed";
}

export function hostMonitorFields(monitor?: SelectedMonitor): Record<string, number | boolean> {
  if (!monitor) return {};
  return {
    monitorLeft: monitor.left,
    monitorTop: monitor.top,
    monitorWidth: monitor.width,
    monitorHeight: monitor.height,
    forceMonitor: true,
  };
}

export function suggestMonitor(monitors: SelectedMonitor[], window?: ScreenRect): SelectedMonitor | undefined {
  if (window) {
    const hit = monitors.find(
      (monitor) =>
        window.left >= monitor.left - 16 &&
        window.top >= monitor.top - 16 &&
        window.left < monitor.left + monitor.width &&
        window.top < monitor.top + monitor.height,
    );
    if (hit) return hit;
  }
  return monitors.find((monitor) => monitor.primary) ?? monitors[0];
}

export function fractionRegion(content: ScreenRect, frac: { x: number; y: number; w: number; h: number }) {
  return {
    x: content.left + content.width * frac.x,
    y: content.top + content.height * frac.y,
    w: content.width * frac.w,
    h: content.height * frac.h,
  };
}

export function allCellsInside(cells: GridCell[], client: ScreenRect, pad = 8): boolean {
  return cells.every((cell) => clampToRect(cell.x, cell.y, client, pad) !== null);
}

/**
 * Windowed-fullscreen + DPI-unaware hosts often report 1080p.
 * If the monitor is a matching larger 16:9 surface (e.g. 3840x2160), use the full display.
 */
export function resolvePhysicalClient(
  client: ScreenRect,
  monitorWidth: number,
  monitorHeight: number,
  origin: MonitorOrigin = { left: 0, top: 0 },
): ScreenRect {
  if (monitorWidth <= 0 || monitorHeight <= 0) return client;
  if (displayMode(client, monitorWidth, monitorHeight, origin) === "fullscreen") {
    return { left: origin.left, top: origin.top, width: monitorWidth, height: monitorHeight };
  }
  const fourK = monitorWidth >= 3800 && monitorHeight >= 2100;
  const reported1080 = client.width >= 1800 && client.width <= 2000 && Math.abs(client.width / client.height - 16 / 9) < 0.08;
  if (fourK && reported1080) {
    return { left: origin.left, top: origin.top, width: monitorWidth, height: monitorHeight };
  }
  return client;
}

export function layoutSummary(client: ScreenRect, monitorWidth?: number, monitorHeight?: number) {
  const physical =
    monitorWidth && monitorHeight ? resolvePhysicalClient(client, monitorWidth, monitorHeight) : client;
  const content = contentRect(physical);
  return {
    client: physical,
    content,
    mode: monitorWidth && monitorHeight ? displayMode(physical, monitorWidth, monitorHeight) : "windowed",
    inventoryRegion: fractionRegion(content, HUD_FRACTIONS.inventory),
    stashRegion: fractionRegion(content, HUD_FRACTIONS.stash),
  };
}
