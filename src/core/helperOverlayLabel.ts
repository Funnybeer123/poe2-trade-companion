import { formatHelperValue, type HelperRow } from "./priceHelper.js";

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function range(low: number, high?: number): string {
  return `${formatHelperValue(low)}${high !== undefined && high > low ? `–${formatHelperValue(high)}` : ""}`;
}

/** Compact overlay text; the renderer supplies the row's currency icon separately. */
export function helperOverlayLabel(row: HelperRow): string {
  if (row.state === "rumour") return row.detail;
  if (row.state === "no-data") {
    if (row.lookupState === "pending") return "Checking…";
    return row.lookupState === "error" || row.lookupState === "unavailable" ? "No live price" : "No data";
  }
  if (row.state !== "priced" || !["chaos", "div"].includes(row.currency ?? "") || !positive(row.unit)) return "?";
  const suffix = row.stale ? " · stale" : "";
  const prefix = row.source === "trade" ? "≈" : "";
  const high = row.source === "trade" ? row.rangeHigh : undefined;
  if (high !== undefined && !positive(high)) return "?";
  if (row.quantity === undefined && row.total === undefined && row.detail.includes("quantity unreadable")) {
    if (high !== undefined && high < row.unit) return "?";
    return `${prefix}${range(row.unit, high)} each · qty ?${suffix}`;
  }
  if (!Number.isInteger(row.quantity) || !positive(row.quantity) || row.quantity > 99999 || !positive(row.total)) return "?";
  if (high !== undefined && high < row.total) return "?";
  return `${prefix}${range(row.total, high)}${row.quantity > 1 ? ` (${range(row.unit, high === undefined ? undefined : high / row.quantity)})` : ""}${suffix}`;
}
