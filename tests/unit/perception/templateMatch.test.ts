import { templateMatch, templateMatchScoreAt, type RgbaImage } from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRgba, fillRect } from "../../helpers/encodePng.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/perception");

async function loadPng(rel: string): Promise<RgbaImage> {
  const buffer = readFileSync(join(fixtures, rel));
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data) };
}

function solid(width: number, height: number, rgb: readonly [number, number, number]): RgbaImage {
  return { width, height, pixels: createRgba(width, height, [rgb[0], rgb[1], rgb[2], 255]) };
}

describe("templateMatch", () => {
  it("scores a perfect patch at 1 and finds the labeled box", async () => {
    const image = await loadPng("target-cue/frame.png");
    const template = await loadPng("target-cue/template.png");
    const hit = templateMatch(image, template);
    expect(hit.box).toEqual({ x: 20, y: 16, w: 24, h: 24 });
    expect(hit.score).toBeGreaterThan(0.99);
  });

  it("is monotonic: the true location outscores an offset location", async () => {
    const image = await loadPng("target-cue/frame.png");
    const template = await loadPng("target-cue/template.png");
    const atTruth = templateMatchScoreAt(image, template, 20, 16);
    const atOffset = templateMatchScoreAt(image, template, 4, 4);
    expect(atTruth).toBeGreaterThan(atOffset);
  });

  it("is monotonic: a matching template outscores a mismatched color template", async () => {
    const image = await loadPng("loot-label/frame.png");
    const gold = await loadPng("loot-label/template.png");
    const mismatchPixels = createRgba(gold.width, gold.height, [0, 0, 255, 255]);
    const mismatch: RgbaImage = { width: gold.width, height: gold.height, pixels: mismatchPixels };
    const matchScore = templateMatch(image, gold).score;
    const mismatchScore = templateMatch(image, mismatch).score;
    expect(matchScore).toBeGreaterThan(mismatchScore);
  });

  it("drops score when the image is noisier than the clean fixture", () => {
    const cleanPixels = createRgba(32, 32, [0, 0, 0, 255]);
    fillRect(cleanPixels, 32, 8, 8, 8, 8, [255, 255, 255, 255]);
    const templatePixels = createRgba(8, 8, [255, 255, 255, 255]);
    const clean: RgbaImage = { width: 32, height: 32, pixels: cleanPixels };
    const template: RgbaImage = { width: 8, height: 8, pixels: templatePixels };
    const noisyPixels = new Uint8Array(cleanPixels);
    for (let i = 0; i < noisyPixels.length; i += 4) {
      noisyPixels[i] = Math.min(255, (noisyPixels[i] ?? 0) + 80);
    }
    const noisy: RgbaImage = { width: 32, height: 32, pixels: noisyPixels };
    expect(templateMatchScoreAt(clean, template, 8, 8)).toBeGreaterThan(
      templateMatchScoreAt(noisy, template, 8, 8),
    );
  });

  it("returns score 0 when the template is larger than the image", () => {
    const hit = templateMatch(solid(4, 4, [1, 1, 1]), solid(8, 8, [1, 1, 1]));
    expect(hit.score).toBe(0);
  });
});
