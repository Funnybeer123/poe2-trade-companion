import { describe, expect, it } from "vitest";
import { TabNavigator } from "../src/adapters/tabNavigator.js";

interface Sent {
  op: string;
  x?: number;
  y?: number;
}

/**
 * Fake win-host that renders a fixed tab list to every OCR call, so we can
 * assert which rows the navigator is willing to click.
 */
function fakeHost(labels: string[]) {
  const sent: Sent[] = [];
  const host = {
    async send(payload: Record<string, unknown>) {
      const op = String(payload.op);
      sent.push({ op, x: payload.x as number, y: payload.y as number });
      if (op === "ocr") {
        return {
          ok: true,
          lines: labels.map((text, index) => ({
            text,
            x: 1400,
            y: 200 + index * 48,
            w: 200,
            h: 30,
          })),
        };
      }
      return { ok: true };
    },
  };
  return { host, sent, clicks: () => sent.filter((entry) => entry.op === "click") };
}

const LIST = [
  "Currency",
  "~price 5 exalted",
  "Great Gear",
  "Rit (Remove-only)",
  "Maps",
  "rice 1 divine",
  "T15",
];

describe("TabNavigator protected-tab guard", () => {
  it("refuses to select a Remove-only tab by label", async () => {
    const { host } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.gotoLabel("Rit (Remove-only)")).rejects.toThrow(/refusing-protected-tab/);
  });

  it("refuses to select a priced tab by label", async () => {
    const { host } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.gotoLabel("~price 5 exalted")).rejects.toThrow(/refusing-protected-tab/);
  });

  it("refuses an index whose canonical label is protected", async () => {
    const { host } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.goto(LIST.indexOf("Rit (Remove-only)"))).rejects.toThrow(
      /refusing-protected-tab/,
    );
    await expect(navigator.goto(LIST.indexOf("~price 5 exalted"))).rejects.toThrow(
      /refusing-protected-tab/,
    );
  });

  it("refuses an index whose live row is a garbled priced label", async () => {
    const { host } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.goto(LIST.indexOf("rice 1 divine"))).rejects.toThrow(
      /refusing-protected-tab/,
    );
  });

  it("selects an ordinary tab and reports the label it landed on", async () => {
    const { host, clicks } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.gotoLabel("Great Gear")).resolves.toBe("Great Gear");
    // Row 2 of the fake list sits at y = 200 + 2 * 48, centred by snapRows.
    expect(clicks().some((click) => click.x === 1700)).toBe(true);
  });

  it("still selects an ordinary tab by index", async () => {
    const { host } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await expect(navigator.goto(LIST.indexOf("Maps"))).resolves.toBeUndefined();
  });

  it("never clicks a protected row while searching for a legitimate one", async () => {
    const { host, clicks } = fakeHost(LIST);
    const navigator = new TabNavigator(host, LIST);
    await navigator.gotoLabel("T15");
    // Rows are 48px apart from y=200; the protected rows are indices 1, 3 and 5.
    const protectedRowYs = [1, 3, 5].map((index) => 200 + index * 48 + 15);
    for (const click of clicks()) {
      if (click.x !== 1700) continue;
      expect(protectedRowYs).not.toContain(click.y);
    }
  });
});
