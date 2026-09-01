import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import {
  applyOccupancyLabels,
  loadOccupancyLabels,
  occupancyCorrectionsFromLabels,
  occupancyLabelsPath,
  recordOccupancyLabel,
} from "../src/core/occupancyLabels.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function profile() {
  return {
    ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
    stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
    bagGrid: { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 },
  };
}

describe("occupancy labels", () => {
  it("appends Right/Wrong payloads and maps Wrong to occupancy overrides", () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-occupancy-labels-"));
    const wrong = recordOccupancyLabel(root, {
      timestamp: "2026-08-27T00:00:00.000Z",
      area: "stash",
      row: 1,
      col: 2,
      perceivedOccupied: true,
      label: "wrong",
      evidenceHash: "hash-1",
      screenshotId: "assistive-1.png",
    });
    const right = recordOccupancyLabel(root, {
      timestamp: "2026-08-27T00:00:01.000Z",
      area: "bag",
      row: 0,
      col: 4,
      perceivedOccupied: false,
      label: "right",
    });

    expect(wrong).toEqual({
      timestamp: "2026-08-27T00:00:00.000Z",
      area: "stash",
      row: 1,
      col: 2,
      perceivedOccupied: true,
      label: "wrong",
      evidenceHash: "hash-1",
      screenshotId: "assistive-1.png",
    });
    const file = occupancyLabelsPath(root);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([wrong, right]);
    expect(occupancyCorrectionsFromLabels([wrong, right])).toEqual([
      expect.objectContaining({
        kind: "false-occupied",
        grid: "stash",
        row: 1,
        col: 2,
      }),
    ]);

    recordOccupancyLabel(root, {
      timestamp: "2026-08-27T00:00:02.000Z",
      area: "stash",
      row: 1,
      col: 2,
      perceivedOccupied: true,
      label: "right",
    });
    recordOccupancyLabel(root, {
      timestamp: "2026-08-27T00:00:03.000Z",
      area: "bag",
      row: 4,
      col: 0,
      perceivedOccupied: false,
      label: "wrong",
    });

    expect(
      occupancyCorrectionsFromLabels(loadOccupancyLabels(root)),
    ).toEqual([
      expect.objectContaining({
        kind: "missed-item",
        grid: "bag",
        row: 4,
        col: 0,
        w: 1,
        h: 1,
      }),
    ]);
  });

  it("applies persisted Wrong labels as local occupancy overrides", () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-occupancy-apply-"));
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT, {}, profile());
    expect(facts.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(true);

    recordOccupancyLabel(root, {
      area: "bag",
      row: 0,
      col: 1,
      perceivedOccupied: true,
      label: "wrong",
    });
    recordOccupancyLabel(root, {
      area: "stash",
      row: 11,
      col: 11,
      perceivedOccupied: false,
      label: "wrong",
    });

    const corrected = applyOccupancyLabels(facts, root, profile(), TEST_CLIENT);
    expect(facts.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(true);
    expect(corrected.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(false);
    expect(corrected.occupiedStash.some((cell) => cell.row === 11 && cell.col === 11)).toBe(true);
  });
});
