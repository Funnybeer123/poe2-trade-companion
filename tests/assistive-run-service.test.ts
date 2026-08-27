import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyProfile, packPatch } from "../src/core/calibrationProfile.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";
import type { GrayImage } from "../src/core/grayImage.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { AssistiveRunService } from "../src/main/assistiveRunService.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function grayBmp(image: GrayImage): Buffer {
  const stride = (image.width * 3 + 3) & ~3;
  const pixels = stride * image.height;
  const out = Buffer.alloc(54 + pixels);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(image.width, 18);
  out.writeInt32LE(image.height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixels, 34);
  for (let y = 0; y < image.height; y += 1) {
    const targetY = image.height - 1 - y;
    for (let x = 0; x < image.width; x += 1) {
      const value = image.pixels[y * image.width + x]!;
      const offset = 54 + targetY * stride + x * 3;
      out[offset] = value;
      out[offset + 1] = value;
      out[offset + 2] = value;
    }
  }
  return out;
}

describe("assistive run service", () => {
  it("previews a transfer with traces and zero host input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-"));
    const artifactDir = path.join(root, "artifacts");
    const frame = stashAndBagFrame([], [{ row: 0, col: 0 }]);
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
    };
    const sent: Array<Record<string, unknown>> = [];
    const hostFactory = () => ({
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return {
            ok: true,
            process: "PathOfExile.exe",
            hwnd: 123,
            monitorLeft: 0,
            monitorTop: 0,
            monitorWidth: TEST_CLIENT.width,
            monitorHeight: TEST_CLIENT.height,
          };
        }
        if (payload.op === "capture") {
          writeFileSync(String(payload.path), grayBmp(frame));
          return { ok: true, ...TEST_CLIENT };
        }
        return { ok: false, error: "unexpected-input" };
      },
      async close() {},
    });
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: false,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir,
      profile: () => profile,
      hostFactory,
    });

    const result = await service.start({
      kind: "fill",
      dryRun: true,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("dry-run-preview");
    expect(result.traces.length).toBeGreaterThan(0);
    expect(result.traces.every((trace) => trace.result === "blocked")).toBe(true);
    expect(result.traces.every((trace) => trace.reason.includes("safety=dry-run"))).toBe(true);
    expect(sent.every((entry) => entry.op === "rect" || entry.op === "capture")).toBe(true);

    const filtered = await service.start({
      kind: "fill",
      dryRun: true,
      wantedClasses: ["belt", "body armor"],
      uniqueAcrossCycles: true,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });
    expect(
      filtered.traces
        .flatMap((trace) => trace.input?.kind === "type" ? [trace.input.text] : []),
    ).toEqual(['"class: Belts"', '"class: Body Armours"']);
    expect(filtered.memory.scenarioKey).toBe(
      'normal::"class: belts" | "class: body armours"',
    );
    expect(sent.every((entry) => entry.op === "rect" || entry.op === "capture")).toBe(true);

    const voiceFiltered = await service.start({
      kind: "fill",
      dryRun: true,
      wantedClasses: ["Currency", "Stackable Currency"],
      searchQuery: '"class: (Currency|Stackable Currency)"',
      uniqueAcrossCycles: false,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });
    expect(
      voiceFiltered.traces.flatMap((trace) =>
        trace.input?.kind === "type" ? [trace.input.text] : [],
      ),
    ).toEqual(['"class: (Currency|Stackable Currency)"']);
    await expect(
      service.start({
        kind: "fill",
        dryRun: true,
        wantedClasses: [],
        searchQuery: "unsafe\nquery",
        uniqueAcrossCycles: false,
        qaAcknowledged: false,
        allowlist: ["PathOfExile.exe"],
      }),
    ).rejects.toThrow("invalid-stash-search-query");

    profile.stashSearch = undefined;
    await expect(
      service.start({
        kind: "fill",
        dryRun: true,
        wantedClasses: ["Belts"],
        uniqueAcrossCycles: false,
        qaAcknowledged: false,
        allowlist: ["PathOfExile.exe"],
      }),
    ).rejects.toThrow("stash-search-not-calibrated");
    await expect(
      service.start({
        kind: "empty",
        dryRun: true,
        wantedClasses: ["Belts"],
        uniqueAcrossCycles: false,
        qaAcknowledged: false,
        allowlist: ["PathOfExile.exe"],
      }),
    ).resolves.toMatchObject({ dryRun: true, kind: "empty" });
  });

  it("runs a calibrated Belt search through audited live input and clears the query", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-live-"));
    const initial = stashAndBagFrame([], [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
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
        patch: packPatch(initial, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      bagGrid: {
        x: 1048,
        y: 324,
        w: 480,
        h: 450,
        cols: 12,
        rows: 5,
        patch: packPatch(initial, TEST_CLIENT, { x: 1048, y: 324, w: 480, h: 450 }),
      },
      stashSearch: { x: 200, y: 790, w: 300, h: 30 },
    };
    const sent: Array<Record<string, unknown>> = [];
    let focused = false;
    let transferred = false;
    let clipboard = "operator clipboard";
    let query = "";
    const hostFactory = () => ({
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return {
            ok: true,
            process: "PathOfExile.exe",
            hwnd: 123,
            foregroundIsPoe: focused,
            monitorLeft: 0,
            monitorTop: 0,
            monitorWidth: TEST_CLIENT.width,
            monitorHeight: TEST_CLIENT.height,
          };
        }
        if (payload.op === "focus") {
          focused = true;
          return { ok: true, focused: true };
        }
        if (payload.op === "capture") {
          const frame = transferred
            ? stashAndBagFrame(
                [
                  { row: 0, col: 0 },
                  { row: 0, col: 1 },
                ],
                [],
              )
            : initial;
          writeFileSync(String(payload.path), grayBmp(frame));
          return { ok: true, ...TEST_CLIENT };
        }
        if (payload.op === "setclipboard") {
          clipboard = String(payload.text ?? "");
          return { ok: true };
        }
        if (payload.op === "clipboard") return { ok: true, text: clipboard };
        if (payload.op === "hotkey") {
          const keys = String(payload.keys);
          if (keys === "ctrlc") {
            clipboard = ["Item Class: Belts", "Rarity: Normal", "Wide Belt"].join("\n");
          } else if (keys === "backspace") {
            query = "";
          }
          return { ok: true, focused: true };
        }
        if (payload.op === "type") {
          query = String(payload.text ?? "");
          return { ok: true, focused: true };
        }
        if (payload.op === "ctrlburst") {
          transferred = true;
          return { ok: true, focused: true };
        }
        if (
          payload.op === "click" ||
          payload.op === "rightclick" ||
          payload.op === "move" ||
          payload.op === "drag"
        ) {
          return { ok: true, focused: true };
        }
        return { ok: false, error: `unexpected-${String(payload.op)}` };
      },
      async close() {},
    });
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => profile,
      hostFactory,
    });

    const result = await service.start({
      kind: "fill",
      dryRun: false,
      wantedClasses: ["belt"],
      uniqueAcrossCycles: false,
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
      actionsPerMinute: 600,
      maxItems: 1,
    });

    expect(result).toMatchObject({ ok: true, dryRun: false, kind: "fill" });
    expect(transferred).toBe(true);
    expect(
      sent.some((entry) => entry.op === "type" && entry.text === '"class: Belts"'),
    ).toBe(true);
    expect(sent.some((entry) => entry.op === "ctrlburst")).toBe(true);
    expect(
      sent.find((entry) => entry.op === "ctrlburst")?.points,
    ).toEqual([expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })]);
    expect(query).toBe("");
    expect(clipboard).toBe("operator clipboard");
    expect(result.traces.every((trace) => trace.result === "emitted")).toBe(true);
    expect(result.elapsedMs).toBeGreaterThan(0);
    const benchmarks = readFileSync(
      path.join(root, "fixtures", "benchmarks", "assistive-runs.jsonl"),
      "utf8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { skill: string; complete: boolean; elapsedMs: number });
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0]).toEqual(
      expect.objectContaining({
        skill: "fill-bag-from-stash",
        complete: false,
        elapsedMs: expect.any(Number),
      }),
    );
  });
});
