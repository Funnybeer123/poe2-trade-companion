import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  locateSortFootprint,
  StashSortService,
  trustedSortFootprint,
} from "../src/main/stashSortService.js";
import {
  emptySizeDatabase,
  withClassDefaults,
  type ItemSizeDatabase,
} from "../src/core/itemSizeStore.js";
import { emptyProfile, packPatch, type CalibrationProfile } from "../src/core/calibrationProfile.js";
import type { GrayImage } from "../src/core/grayImage.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function grayBmp(image: GrayImage): Buffer {
  const stride = (image.width * 3 + 3) & ~3;
  const pixels = stride * image.height;
  const output = Buffer.alloc(54 + pixels);
  output.write("BM", 0, "ascii");
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(image.width, 18);
  output.writeInt32LE(image.height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(24, 28);
  output.writeUInt32LE(pixels, 34);
  for (let y = 0; y < image.height; y += 1) {
    const targetY = image.height - 1 - y;
    for (let x = 0; x < image.width; x += 1) {
      const value = image.pixels[y * image.width + x]!;
      const offset = 54 + targetY * stride + x * 3;
      output[offset] = value;
      output[offset + 1] = value;
      output[offset + 2] = value;
    }
  }
  return output;
}

describe("stash sort scan trust policy", () => {
  it("uses an exact measured base record and never a display-name record", () => {
    const db: ItemSizeDatabase = {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      records: [
        {
          key: "actual base",
          kind: "baseType",
          baseType: "Actual Base",
          itemClass: "Mystery Items",
          w: 2,
          h: 3,
          samples: 2,
          source: "measured",
          updatedAt: new Date(0).toISOString(),
        },
        {
          key: "display name",
          kind: "baseType",
          baseType: "Display Name",
          itemClass: "Mystery Items",
          w: 1,
          h: 1,
          samples: 4,
          source: "measured",
          updatedAt: new Date(0).toISOString(),
        },
      ],
    };
    expect(
      trustedSortFootprint(db, { baseType: "Actual Base", itemClass: "Mystery Items" }),
    ).toEqual({ w: 2, h: 3, source: "measured-base" });
    expect(
      trustedSortFootprint(db, { baseType: "Missing Base", itemClass: "Mystery Items" }),
    ).toBeUndefined();
  });

  it("allows fixed-class footprints but rejects speculative class inference", () => {
    const db = withClassDefaults(emptySizeDatabase());
    expect(trustedSortFootprint(db, { baseType: "Ruby Ring", itemClass: "Rings" })).toEqual({
      w: 1,
      h: 1,
      source: "fixed-class",
    });
    expect(
      trustedSortFootprint(db, { baseType: "Unknown Device", itemClass: "Mystery Items" }),
    ).toBeUndefined();
  });

  it("requires one unique, fully occupied footprint origin", () => {
    const occupied = new Set([
      "0,0", "0,1", "1,0", "1,1", "2,0", "2,1",
      "0,2", "1,2", "2,2",
    ]);
    expect(
      locateSortFootprint({ row: 0, col: 0 }, { w: 2, h: 3 }, occupied, new Set(), 12, 12),
    ).toEqual({ row: 0, col: 0 });
    expect(
      locateSortFootprint({ row: 1, col: 1 }, { w: 2, h: 2 }, occupied, new Set(), 12, 12),
    ).toBeUndefined();
    expect(
      locateSortFootprint(
        { row: 0, col: 0 },
        { w: 2, h: 3 },
        occupied,
        new Set(["1,1"]),
        12,
        12,
      ),
    ).toBeUndefined();
  });
});

describe("stash sort IPC and UI boundary", () => {
  it("exposes preview and explicit execute without bypassing audited input", () => {
    const main = readFileSync("src/main/index.ts", "utf8");
    const preload = readFileSync("src/main/preload.ts", "utf8");
    const panel = readFileSync("src/renderer/SortStashPanel.vue", "utf8");
    const service = readFileSync("src/main/stashSortService.ts", "utf8");

    expect(main).toContain('"stash-sort:start"');
    expect(main).toContain("stashSortService?.stop(\"emergency-stop\")");
    expect(preload).toContain("stashSort:");
    expect(panel).toContain("Scan &amp; preview");
    expect(panel).toContain("Execute this preview");
    expect(panel).toContain("status.value.calibrated");
    expect(panel).toContain("Ctrl+Shift+Esc");
    expect(service).toContain("GameInputController");
    expect(service).toContain("executeStashSort");
    expect(service).not.toMatch(
      /host\.send\(\{\s*op:\s*"(?:click|ctrlburst|rightclick|drag|hotkey|type|move|focus)"/,
    );
  });
});

describe("stash sort service preview", () => {
  it("scans exact bases through audited clipboard input and never moves an item", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-stash-sort-"));
    const frame = stashAndBagFrame([], [
      { row: 0, col: 0 },
      { row: 0, col: 2 },
    ]);
    const profile: CalibrationProfile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      stashGrid: {
        x: 80,
        y: 144,
        w: 736,
        h: 630,
        cols: 12,
        rows: 12,
        patch: packPatch(frame, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      bagGrid: {
        x: 1048,
        y: 324,
        w: 480,
        h: 450,
        cols: 12,
        rows: 5,
        patch: packPatch(frame, TEST_CLIENT, { x: 1048, y: 324, w: 480, h: 450 }),
      },
      stashSearch: { x: 200, y: 790, w: 300, h: 30 },
      activeStashTab: "normal",
    };
    const sent: Array<Record<string, unknown>> = [];
    let clipboard = "operator clipboard";
    const hostFactory = () => ({
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return {
            ok: true,
            process: "PathOfExile.exe",
            hwnd: 321,
            foregroundIsPoe: true,
            monitorLeft: 0,
            monitorTop: 0,
            monitorWidth: TEST_CLIENT.width,
            monitorHeight: TEST_CLIENT.height,
          };
        }
        if (payload.op === "focus") return { ok: true, focused: true };
        if (payload.op === "capture") {
          writeFileSync(String(payload.path), grayBmp(frame));
          return { ok: true, ...TEST_CLIENT, focused: true };
        }
        if (payload.op === "clipboard") return { ok: true, text: clipboard };
        if (payload.op === "setclipboard") {
          clipboard = String(payload.text ?? "");
          return { ok: true };
        }
        if (payload.op === "hotkey" && payload.keys === "ctrlc") {
          clipboard = ["Item Class: Currency", "Rarity: Normal", "Chaos Orb"].join("\n");
          return { ok: true, focused: true };
        }
        if (payload.op === "move") return { ok: true, focused: true };
        return { ok: false, error: `unexpected-${String(payload.op)}` };
      },
      async close() {},
    });
    const service = new StashSortService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      artifactDir: path.join(root, "artifacts"),
      profile: () => profile,
      hostFactory,
      sizeDatabase: () => withClassDefaults(emptySizeDatabase()),
    });

    const result = await service.start({
      action: "preview",
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
      actionsPerMinute: 100,
      tabSafety: "writable-grid",
    });

    expect(result).toMatchObject({ ok: true, action: "preview", dryRun: true });
    expect(result.plan.placements).toHaveLength(2);
    expect(result.plan.groups).toHaveLength(1);
    expect(result.plan.groups[0]?.baseType).toBe("Chaos Orb");
    expect(sent.some((entry) => entry.op === "hotkey" && entry.keys === "ctrlc")).toBe(true);
    expect(sent.some((entry) => entry.op === "drag" || entry.op === "click")).toBe(false);
    expect(clipboard).toBe("operator clipboard");
  });
});
