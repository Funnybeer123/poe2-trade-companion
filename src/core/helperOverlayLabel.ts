import { formatHelperValue, type HelperRow } from "./priceHelper.js";

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Compact overlay text; the renderer supplies the row's currency icon separately. */
export function helperOverlayLabel(row: HelperRow): string {
  if (row.state === "rumour") return row.detail;
  if (row.state === "no-data") return "No data";
  if (row.state !== "priced" || !["chaos", "div"].includes(row.currency ?? "") || !positive(row.unit)) return "?";
  const suffix = row.stale ? " · stale" : "";
  if (row.quantity === undefined && row.total === undefined && row.detail.includes("quantity unreadable")) {
    return `${formatHelperValue(row.unit)} each · qty ?${suffix}`;
  }
  if (!Number.isInteger(row.quantity) || !positive(row.quantity) || row.quantity > 99999 || !positive(row.total)) return "?";
  return `${formatHelperValue(row.total)}${row.quantity > 1 ? ` (${formatHelperValue(row.unit)})` : ""}${suffix}`;
}
