import { describe, expect, it } from "vitest";
import { StashTabKit, pickUnique, type StripEntry } from "../src/adapters/stashTabKit.js";

const entry = (label: string, x = 100): StripEntry => ({
  label,
  row: "folder",
  point: { x, y: 275 },
  width: 180,
});

describe("pickUnique", () => {
  it("takes an exact match", () => {
    const found = pickUnique([entry("T15"), entry("Maps", 300)], "Maps");
    expect(found?.label).toBe("Maps");
  });

  it("refuses near-identical priced labels rather than guessing", () => {
    // A live dry run targeted "~price 5 exalted" twice because the loose
    // matcher conflated it with "~price 1 exalted".
    const entries = [entry("~price 1 exalted"), entry("~price 5 exalted", 400)];
    expect(pickUnique(entries, "~price 1 exalted")?.label).toBe("~price 1 exalted");
    // A clip that still carries the digit resolves to one tab...
    expect(pickUnique(entries, "rice 1 exalted")?.label).toBe("~price 1 exalted");
    // ...but a clip down to the bare currency matches both, so it is a miss.
    expect(pickUnique(entries, "exalted")).toBeUndefined();
  });

  it("refuses when the same label appears twice", () => {
    expect(pickUnique([entry("Maps"), entry("Maps", 400)], "Maps")).toBeUndefined();
  });

  it("still resolves a single clipped label loosely", () => {
    expect(pickUnique([entry("Great Gea"), entry("Runes", 400)], "Great Gear")?.label).toBe(
      "Great Gea",
    );
  });

  it("finds nothing when nothing matches", () => {
    expect(pickUnique([entry("Runes")], "Boots")).toBeUndefined();
  });
});

/** Minimal host that reports one tab and a settings dialog naming `dialogName`. */
function dialogHost(stripLabel: string, dialogName: string) {
  const sent: string[] = [];
  return {
    sent,
    host: {
      async send(payload: Record<string, unknown>) {
        const op = String(payload.op);
        sent.push(op);
        if (op === "ocr") {
          return {
            ok: true,
            lines: [
              { text: stripLabel, x: 100, y: 275, w: 180, h: 30 },
              { text: "STASH TAB SETTINGS", x: 435, y: 377, w: 442, h: 37 },
              { text: "NAME", x: 131, y: 512, w: 93, h: 28 },
              { text: "COLOUR", x: 130, y: 621, w: 127, h: 27 },
              { text: dialogName, x: 354, y: 515, w: 241, h: 37 },
              {
                text: "Multiple Stash tabs cannot share the same stash affinity.",
                x: 191,
                y: 1560,
                w: 866,
                h: 35,
              },
            ],
          };
        }
        return { ok: true };
      },
    },
  };
}

describe("applyTabIdentity guards", () => {
  it("aborts when the dialog names a different tab than the plan targeted", async () => {
    const { host, sent } = dialogHost("~price 1 exalted", "~price 5 exalted");
    const kit = new StashTabKit(host);
    const result = await kit.applyTabIdentity(
      { label: "~price 1 exalted", row: "folder", point: { x: 100, y: 275 }, width: 180 },
      "Weapons",
      "red",
      { allowPricedTabs: true, expectedLabel: "~price 1 exalted" },
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/target-mismatch/);
    // Nothing was typed into the name field.
    expect(sent).not.toContain("type");
  });

  it("refuses a priced tab without the opt-in, reading the name off the dialog", async () => {
    const { host, sent } = dialogHost("T15", "~price 5 exalted");
    const kit = new StashTabKit(host);
    const result = await kit.applyTabIdentity(
      { label: "T15", row: "folder", point: { x: 100, y: 275 }, width: 180 },
      "Weapons",
      "red",
      {},
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("refused-priced-tab");
    expect(sent).not.toContain("type");
  });

  it("refuses a Remove-only tab even with the priced opt-in on", async () => {
    const { host, sent } = dialogHost("Rit", "Rit (Remove-only)");
    const kit = new StashTabKit(host);
    const result = await kit.applyTabIdentity(
      { label: "Rit", row: "folder", point: { x: 100, y: 275 }, width: 180 },
      "Weapons",
      "red",
      { allowPricedTabs: true },
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("refused-remove-only-tab");
    expect(sent).not.toContain("type");
  });

  it("changes nothing on a dry run", async () => {
    const { host, sent } = dialogHost("T15", "T15");
    const kit = new StashTabKit(host);
    const result = await kit.applyTabIdentity(
      { label: "T15", row: "folder", point: { x: 100, y: 275 }, width: 180 },
      "Rings",
      "purple",
      { dryRun: true, expectedLabel: "T15" },
    );
    expect(result.reason).toBe("dry-run");
    expect(sent).not.toContain("type");
  });

  it("rejects an unknown colour before touching the game", async () => {
    const { host, sent } = dialogHost("T15", "T15");
    const kit = new StashTabKit(host);
    const result = await kit.applyTabIdentity(
      { label: "T15", row: "folder", point: { x: 100, y: 275 }, width: 180 },
      "Rings",
      "chartreuse",
      {},
    );
    expect(result.reason).toBe("unknown-colour:chartreuse");
    expect(sent).toHaveLength(0);
  });
});

/**
 * Anchor maths, pinned against two real dialogs captured at different screen
 * positions. The dialog is placed relative to the tab header you right-click,
 * so fixed coordinates silently miss the confirm tick and nothing saves — that
 * was a live bug.
 */
function ocrHost(lines: Array<{ text: string; x: number; y: number; w: number; h: number }>) {
  return {
    async send(payload: Record<string, unknown>) {
      if (String(payload.op) === "ocr") return { ok: true, lines };
      return { ok: true };
    },
  };
}

describe("dialog anchors follow the dialog", () => {
  const dialogA = [
    { text: "STASH TAB SETTINGS", x: 435, y: 377, w: 442, h: 37 },
    { text: "NAME", x: 131, y: 512, w: 93, h: 28 },
    { text: "Runes", x: 354, y: 515, w: 241, h: 37 },
    { text: "COLOUR", x: 130, y: 621, w: 127, h: 27 },
    {
      text: "Multiple Stash tabs cannot share the same stash affinity.",
      x: 191,
      y: 1728,
      w: 866,
      h: 35,
    },
  ];
  // Same dialog shifted right and up by the amount observed on the live client.
  const shift = { dx: 195, dy: -223 };
  const dialogB = dialogA.map((line) => ({ ...line, x: line.x + shift.dx, y: line.y + shift.dy }));

  it("locates every control in dialog A", async () => {
    const state = await new StashTabKit(ocrHost(dialogA)).readDialog();
    expect(state.open).toBe(true);
    expect(state.name).toBe("Runes");
    // Measured on the live client: tick at (1221, 1801), name field (700, 528).
    expect(state.confirmPoint).toEqual({ x: 1221, y: 1801 });
    expect(state.nameField).toEqual({ x: 700, y: 528 });
    expect(state.paletteOrigin).toEqual({ x: 356, y: 648 });
  });

  it("moves every control with the dialog", async () => {
    const state = await new StashTabKit(ocrHost(dialogB)).readDialog();
    expect(state.confirmPoint).toEqual({ x: 1221 + shift.dx, y: 1801 + shift.dy });
    expect(state.nameField).toEqual({ x: 700 + shift.dx, y: 528 + shift.dy });
    expect(state.paletteOrigin).toEqual({ x: 356 + shift.dx, y: 648 + shift.dy });
    expect(state.closePoint!.x).toBe(
      (await new StashTabKit(ocrHost(dialogA)).readDialog()).closePoint!.x + shift.dx,
    );
  });

  it("treats a folder — no affinity footer — as not renameable", async () => {
    const folder = dialogA.filter((line) => !/affinity/i.test(line.text));
    const state = await new StashTabKit(ocrHost(folder)).readDialog();
    expect(state.open).toBe(true);
    expect(state.confirmPoint).toBeUndefined();
  });
});
