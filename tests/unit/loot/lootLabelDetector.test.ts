import { FixtureOcrPort, detectLootLabels } from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRgba, fillRect } from "../../helpers/encodePng.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/perception");

describe("lootLabelDetector", () => {
  it("returns fixture-derived labels without requiring pixels", async () => {
    const detected = await detectLootLabels({
      tickId: 1,
      capturedAtMs: 10_000,
      width: 64,
      height: 64,
      derived: {
        loot: {
          value: [
            {
              id: "loot-1",
              labelText: "Exalted Orb",
              screenPoint: { x: 28, y: 50 },
            },
          ],
          confidence: 1,
          observedAtMs: 10_000,
          freshness: "fresh",
        },
      },
    });
    expect(detected.source).toBe("fixture");
    expect(detected.loot).toHaveLength(1);
    expect(detected.loot[0]?.labelText).toBe("Exalted Orb");
  });

  it("detects the gold currency blob on the loot-label PNG and can attach OCR text", async () => {
    const buffer = readFileSync(join(fixtures, "loot-label/frame.png"));
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const detected = await detectLootLabels(
      {
        tickId: 2,
        capturedAtMs: 10_000,
        width: info.width,
        height: info.height,
        pixels: new Uint8Array(data),
        pngPath: "fixtures/perception/loot-label/frame.png",
      },
      {
        ocr: new FixtureOcrPort({ "*": "Exalted Orb" }),
      },
    );
    expect(detected.source).toBe("color");
    expect(detected.loot.length).toBeGreaterThanOrEqual(1);
    expect(detected.loot[0]?.rarityCue).toBe("currency");
    expect(detected.loot[0]?.labelText).toBe("Exalted Orb");
    expect(detected.loot[0]?.boundingBox).toMatchObject({ x: 10, y: 44, w: 36, h: 12 });
  });

  it("clusters synthetic rarity colors into distinct labels", async () => {
    const pixels = createRgba(64, 64, [16, 16, 20, 255]);
    fillRect(pixels, 64, 4, 4, 20, 8, [255, 255, 119, 255]);
    fillRect(pixels, 64, 36, 40, 20, 8, [136, 136, 255, 255]);
    const detected = await detectLootLabels({
      tickId: 3,
      capturedAtMs: 10_000,
      width: 64,
      height: 64,
      pixels,
    });
    expect(detected.loot).toHaveLength(2);
    expect(detected.loot.map((item) => item.rarityCue).sort()).toEqual(["magic", "rare"]);
  });
});
