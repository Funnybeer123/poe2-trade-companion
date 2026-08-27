export interface ShadowItem {
  fingerprint: string;
  location: { kind: "inventory" | "stash"; tabId?: string; x: number; y: number };
  lastConfirmedMs: number;
  stale: boolean;
  mismatch: boolean;
}

export interface ReconcileResult {
  confirmed: ShadowItem[];
  missing: ShadowItem[];
  unexpected: ShadowItem[];
  stale: ShadowItem[];
}

export function locationKey(location: ShadowItem["location"]): string {
  return `${location.kind}:${location.tabId ?? ""}:${String(location.x)}:${String(location.y)}`;
}

export function hasShadowMismatch(result: ReconcileResult): boolean {
  return result.missing.some((item) => item.mismatch) || result.unexpected.some((item) => item.mismatch);
}
