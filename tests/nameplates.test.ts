import { describe, expect, it } from "vitest";
import { createGray, fillRect, type GrayImage } from "../src/core/grayImage.js";
import { emptyProfile, packPatch } from "../src/core/calibrationProfile.js";
import { findNameplates, likelyStashNameplates, locateStashNameplate, pickStashNameplate, stashClickFromNameplate } from "../src/core/nameplates.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { busyWorldFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function drawNameplate(image: GrayImage, x: number, y: number, w: number, h: number, letters: number): void {
  fillRect(image, x, y, w, h, 24);
  fillRect(image, x, y, w, 2, 190);
  fillRect(image, x, y + h - 2, w, 2, 190);
  fillRect(image, x, y, 2, h, 190);
  fillRect(image, x + w - 2, y, 2, h, 190);
  const inset = 4;
  const lw = (w - inset * 2) / letters;
  for (let i = 0; i < letters; i += 1) {
    fillRect(image, x + inset + i * lw + 2, y + 5, lw - 4, h - 10, 210);
  }
}

function hideoutWithNameplates(): GrayImage {
  const image = createGray(1600, 900, 12);
  drawNameplate(image, 420, 210, 110, 26, 5);
  drawNameplate(image, 720, 300, 170, 26, 8);
  return image;
}

describe("STASH nameplates", () => {
  it("finds dark nameplate labels in the hideout", () => {
    const plates = findNameplates(hideoutWithNameplates());
    expect(plates.length).toBeGreaterThanOrEqual(1);
    expect(plates.some((plate) => plate.x < 500 && plate.w < 160)).toBe(true);
  });

  it("locates the saved STASH nameplate instead of a longer label", () => {
    const frame = hideoutWithNameplates();
    const npc = {
      id: "stash",
      label: "STASH",
      x: 420,
      y: 210,
      w: 110,
      h: 26,
      patch: packPatch(frame, TEST_CLIENT, { x: 420, y: 210, w: 110, h: 26 }),
    };
    const found = locateStashNameplate(frame, { ...npc, x: 12, y: 12 });
    expect(found).toBeTruthy();
    expect(found!.x).toBeLessThan(560);
    expect(found!.w).toBeLessThan(160);
    const click = stashClickFromNameplate(found!);
    expect(click.x).toBeGreaterThan(found!.x);
    expect(click.x).toBeLessThan(found!.x + found!.w);
    expect(click.y).toBeGreaterThan(found!.y + found!.h * 0.7);
    expect(click.y).toBeLessThan(found!.y + found!.h);
  });

  it("does not treat hideout scenery as a STASH nameplate", () => {
    const frame = hideoutWithNameplates();
    const npc = {
      id: "stash",
      label: "STASH",
      x: 420,
      y: 210,
      w: 110,
      h: 26,
      patch: packPatch(frame, TEST_CLIENT, { x: 420, y: 210, w: 110, h: 26 }),
    };
    expect(locateStashNameplate(busyWorldFrame(), npc)).toBeUndefined();
    expect(findNameplates(busyWorldFrame()).length).toBe(0);
  });

  it("clicks the dead center of the label at the bottom of the A", () => {
    const click = stashClickFromNameplate({ x: 100, y: 40, w: 120, h: 40 });
    expect(click.x).toBe(160);
    expect(click.y).toBe(71);
    expect(click.y).toBeLessThan(80);
  });

  it("keeps only short high labels as likely STASH plates", () => {
    const frame = hideoutWithNameplates();
    const plates = likelyStashNameplates(frame);
    expect(plates.length).toBeGreaterThanOrEqual(1);
    expect(plates.every((plate) => plate.x + plate.w < frame.width * 0.5 && plate.y + plate.h < frame.height * 0.28)).toBe(true);
  });

  it("does not pick the lower WAYPOINT plate as STASH", () => {
    const frame = hideoutWithNameplates();
    const picked = pickStashNameplate(frame);
    expect(picked).toBeTruthy();
    expect(picked!.x).toBeLessThan(600);
    expect(picked!.w).toBeLessThan(160);
    expect(picked!.y + picked!.h).toBeLessThan(frame.height * 0.28);
  });

  it("marks the chest visible from the STASH nameplate when the stash window is closed", () => {
    const frame = hideoutWithNameplates();
    const profile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      npcs: [
        {
          id: "stash",
          label: "STASH",
          x: 420,
          y: 210,
          w: 110,
          h: 26,
          patch: packPatch(frame, TEST_CLIENT, { x: 420, y: 210, w: 110, h: 26 }),
        },
      ],
    };
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    expect(facts.stashPanelOpen).toBe(false);
    expect(facts.stashChestVisible).toBe(true);
    expect(facts.reason).toBe("chest-visible");
    expect(facts.chest).toBeTruthy();
  });
});
