import { bmpToGray } from "../src/adapters/bmp.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { findNameplates, likelyStashNameplates, locateStashNameplate, stashClickFromNameplate } from "../src/core/nameplates.js";

const bmp = process.argv[2] ?? "fixtures/perception/live/deposit-1787702960068.bmp";
const gray = bmpToGray(bmp);
const profile = loadProfile("fixtures/perception/templates");
const all = findNameplates(gray);
const likely = likelyStashNameplates(gray);
const located = locateStashNameplate(gray, profile.npcs[0]);
console.log(
  JSON.stringify(
    {
      bmp,
      size: { w: gray.width, h: gray.height },
      all: all.map((p) => ({
        ...p,
        nx: Number((p.x / gray.width).toFixed(3)),
        ny: Number((p.y / gray.height).toFixed(3)),
      })),
      likely,
      located,
      clicks: likely.map((p) => stashClickFromNameplate(p)),
    },
    null,
    2,
  ),
);
