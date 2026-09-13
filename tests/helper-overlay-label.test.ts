import { describe, expect, it } from "vitest";
import { helperOverlayLabel } from "../src/core/helperOverlayLabel.js";
import { priceHelperRow, type CategorySnapshot, type HelperRow } from "../src/core/priceHelper.js";

const now = Date.parse("2026-09-13T01:10:00Z");
const prices: CategorySnapshot[] = [{ category: "Verisium", fetchedAt: "2026-09-13T01:00:00Z", prices: [{ id: "item", name: "Test Item", chaos: 2.986666666666667, divine: 0.005 }] }];
const priced = (extra: Partial<HelperRow> = {}): HelperRow => ({ text: "Test Item", state: "priced", stale: false, detail: "2 chaos", unit: 2, total: 2, quantity: 1, currency: "chaos", ...extra });

describe("compact price overlay labels", () => {
  it("shows only the total for one item and a parenthesized unit estimate for a stack", () => {
    expect(helperOverlayLabel(priceHelperRow("1x Test Item", prices, now))).toBe("2.99");
    expect(helperOverlayLabel(priceHelperRow("3x Test Item", prices, now))).toBe("8.96 (2.99)");
    expect(helperOverlayLabel(priced({ currency: "div", unit: 12, total: 12 }))).toBe("12");
  });
  it("marks trade samples as approximate and shows their observed range", () => {
    expect(helperOverlayLabel(priced({ source: "trade", rangeHigh: 5, sampleCount: 7 }))).toBe("≈2–5");
    expect(helperOverlayLabel(priced({ source: "trade", rangeHigh: 2 }))).toBe("≈2");
    expect(helperOverlayLabel(priced({ source: "trade" }))).toBe("≈2");
    expect(helperOverlayLabel(priced({ source: "trade", rangeHigh: 5, stale: true }))).toBe("≈2–5 · stale");
  });
  it("treats a known stack rangeHigh as the upper total and derives the parenthesized unit range", () => {
    expect(helperOverlayLabel(priced({ source: "trade", quantity: 3, total: 6, rangeHigh: 15 }))).toBe("≈6–15 (2–5)");
    expect(helperOverlayLabel(priced({ source: "trade", quantity: 3, total: 6, rangeHigh: 6 }))).toBe("≈6 (2)");
  });
  it("shows only the unit listing range when the quantity is unreadable", () => {
    expect(helperOverlayLabel(priced({ source: "trade", quantity: undefined, total: undefined, rangeHigh: 5, detail: "2 chaos each · quantity unreadable" }))).toBe("≈2–5 each · qty ?");
  });
  it("distinguishes pending and unavailable live searches from absent feed data", () => {
    expect(helperOverlayLabel(priced({ state: "no-data", lookupState: "pending" }))).toBe("Checking…");
    expect(helperOverlayLabel(priced({ state: "no-data", lookupState: "error" }))).toBe("No live price");
    expect(helperOverlayLabel(priced({ state: "no-data", lookupState: "unavailable" }))).toBe("No live price");
    expect(helperOverlayLabel(priced({ state: "no-data" }))).toBe("No data");
  });
  it.each([NaN, Infinity, -1, 0, 1])("rejects a malformed trade range: %s", rangeHigh => {
    expect(helperOverlayLabel(priced({ source: "trade", rangeHigh }))).toBe("?");
    expect(helperOverlayLabel(priced({ source: "trade", quantity: undefined, total: undefined, detail: "quantity unreadable", rangeHigh }))).toBe("?");
  });
  it("rejects an upper stack total below its lower total", () => {
    expect(helperOverlayLabel(priced({ source: "trade", quantity: 3, total: 6, rangeHigh: 5 }))).toBe("?");
  });
  it("keeps unreadable quantities explicit without presenting a stack total", () => {
    const row = priceHelperRow("lx Test Item", prices, now);
    expect(row.quantity).toBeUndefined(); expect(row.total).toBeUndefined();
    expect(helperOverlayLabel(row)).toBe("2.99 each · qty ?");
    expect(helperOverlayLabel({ ...row, stale: true })).toBe("2.99 each · qty ? · stale");
  });
  it("marks stale single and stack estimates", () => {
    expect(helperOverlayLabel(priced({ stale: true }))).toBe("2 · stale");
    expect(helperOverlayLabel(priced({ stale: true, quantity: 3, total: 6 }))).toBe("6 (2) · stale");
  });
  it("does not round tiny unit values before using the supplied stack total", () => {
    expect(helperOverlayLabel(priced({ unit: 0.0023, quantity: 100, total: 0.22999999999999998 }))).toBe("0.23 (<0.01)");
    expect(helperOverlayLabel(priced({ unit: 0.0023, total: 0.0023 }))).toBe("<0.01");
  });
  it("keeps unknown and absent data concise and preserves rumour details", () => {
    expect(helperOverlayLabel(priced({ state: "unknown", detail: "No exact match" }))).toBe("?");
    expect(helperOverlayLabel(priced({ state: "no-data", detail: "No market data in the display currency" }))).toBe("No data");
    expect(helperOverlayLabel(priced({ state: "rumour", stale: true, detail: "S+ · Moor · More runestones" }))).toBe("S+ · Moor · More runestones");
  });
  it.each([NaN, Infinity, -Infinity, -1, 0, undefined])("refuses invalid unit and total values: %s", value => {
    expect(helperOverlayLabel(priced({ unit: value }))).toBe("?");
    expect(helperOverlayLabel(priced({ total: value }))).toBe("?");
    expect(helperOverlayLabel(priced({ quantity: undefined, total: undefined, detail: "quantity unreadable", unit: value }))).toBe("?");
  });
  it.each([NaN, Infinity, -1, 0, 1.5, 100000, undefined])("refuses an invalid or incomplete known quantity: %s", quantity => {
    expect(helperOverlayLabel(priced({ quantity }))).toBe("?");
  });
  it("requires a supported currency and an explicit unreadable-quantity marker for unit-only results", () => {
    expect(helperOverlayLabel(priced({ currency: undefined }))).toBe("?");
    expect(helperOverlayLabel(priced({ currency: "ex" as HelperRow["currency"] }))).toBe("?");
    expect(helperOverlayLabel(priced({ quantity: undefined, total: undefined }))).toBe("?");
    expect(helperOverlayLabel(priced({ quantity: undefined, total: 2, detail: "quantity unreadable" }))).toBe("?");
  });
});
