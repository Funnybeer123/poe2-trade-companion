import { describe, expect, it } from "vitest";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import {
  applyDiagnosticCorrections,
  buildTransferDiagnostic,
  type DiagnosticCorrection,
} from "../src/core/transferDiagnostics.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function profile() {
  return {
    ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
    stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
    bagGrid: { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 },
    stashSearch: { x: 100, y: 90, w: 300, h: 30 },
  };
}

function correction(
  kind: DiagnosticCorrection["kind"],
  grid: DiagnosticCorrection["grid"],
  row: number,
  col: number,
  w?: number,
  h?: number,
): DiagnosticCorrection {
  return { kind, grid, row, col, w, h, createdAt: "2026-08-25T00:00:00.000Z" };
}

describe("transfer diagnostics", () => {
  it("emits every calibrated cell, item footprint, anchor, and disagreement", () => {
    const frame = stashAndBagFrame([{ row: 0, col: 1 }], [{ row: 2, col: 3 }]);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile());
    const report = buildTransferDiagnostic({
      gray: frame,
      bgr: {
        width: frame.width,
        height: frame.height,
        data: Buffer.alloc(frame.width * frame.height * 3),
      },
      client: TEST_CLIENT,
      profile: profile(),
      facts,
    });

    expect(report.cells).toHaveLength(12 * 12 + 12 * 5);
    expect(report.footprints.some((item) => item.grid === "stash")).toBe(true);
    expect(report.footprints.some((item) => item.grid === "bag")).toBe(true);
    expect(report.clickAnchors).toHaveLength(report.footprints.length);
    expect(report.cells.some((cell) => cell.disagreement)).toBe(true);
    expect(report.searchBox).toEqual(profile().stashSearch);
  });

  it("applies operator labels without mutating the original facts", () => {
    const frame = stashAndBagFrame([{ row: 0, col: 1 }]);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile());
    const corrected = applyDiagnosticCorrections(
      facts,
      [
        correction("false-occupied", "bag", 0, 1),
        correction("missed-item", "bag", 0, 11, 1, 3),
      ],
      profile(),
      TEST_CLIENT,
    );

    expect(facts.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(true);
    expect(corrected.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(false);
    expect(corrected.occupiedBag.filter((cell) => cell.col === 11)).toHaveLength(3);
    expect(corrected.bagEmpty).toBe(false);
  });

  it("records the correction kind on the selected overlay cell", () => {
    const frame = stashAndBagFrame([]);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile());
    const label = correction("wrong-footprint", "stash", 4, 5, 2, 4);
    const report = buildTransferDiagnostic({
      gray: frame,
      client: TEST_CLIENT,
      profile: profile(),
      facts,
      corrections: [label],
    });

    expect(report.cells.find((cell) => cell.grid === "stash" && cell.row === 4 && cell.col === 5)?.correction).toBe(
      "wrong-footprint",
    );
    expect(report.corrections).toEqual([label]);
  });
});
