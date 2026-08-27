import { describe, expect, it } from "vitest";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import { validateTransferInput } from "../src/core/transferInputGuard.js";

const client = { left: 500, top: 100, width: 1600, height: 900 };

function profile() {
  return {
    ...emptyProfile(client.width, client.height),
    activeStashTab: "normal" as const,
    stashGrid: { x: 20, y: 100, w: 720, h: 720, cols: 12, rows: 12 },
    quadStashGrid: { x: 40, y: 120, w: 600, h: 600, cols: 24, rows: 24 },
    bagGrid: { x: 950, y: 500, w: 600, h: 250, cols: 12, rows: 5 },
    stashSearch: { x: 100, y: 840, w: 300, h: 30 },
  };
}

describe("calibrated transfer input guard", () => {
  it("allows stash, bag, search, and cross-grid drag coordinates", () => {
    expect(
      validateTransferInput(
        [
          { kind: "click", x: 530, y: 210 },
          { kind: "move", x: 1550, y: 650 },
          { kind: "click", x: 750, y: 950 },
          { kind: "drag", x: 530, y: 210, x2: 1550, y2: 650 },
        ],
        profile(),
        client,
      ),
    ).toEqual({ ok: true });
  });

  it("blocks a coordinate that is inside the client but outside calibrated transfer regions", () => {
    expect(
      validateTransferInput([{ kind: "click", x: 1400, y: 250 }], profile(), client),
    ).toEqual({ ok: false, reason: "click-outside-calibrated-transfer-regions" });
  });

  it("allows only the calibrated active stash grid", () => {
    const quad = { ...profile(), activeStashTab: "quad" as const };
    expect(
      validateTransferInput([{ kind: "click", x: 525, y: 205 }], quad, client),
    ).toEqual({ ok: false, reason: "click-outside-calibrated-transfer-regions" });
    expect(
      validateTransferInput([{ kind: "click", x: 550, y: 225 }], quad, client),
    ).toEqual({ ok: true });
  });
});
