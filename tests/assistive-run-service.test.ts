import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyProfile, packPatch } from "../src/core/calibrationProfile.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";
import type { GrayImage } from "../src/core/grayImage.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import type { DryRunOverlayPlan } from "../src/core/dryRunOverlay.js";
import { AssistiveRunService } from "../src/main/assistiveRunService.js";
import { occupancyLabelsPath } from "../src/core/occupancyLabels.js";
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

function calibratedProfile(frame: ReturnType<typeof stashAndBagFrame>): CalibrationProfile {
  return {
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
  };
}

function liveHost(initial: ReturnType<typeof stashAndBagFrame>, emptied: ReturnType<typeof stashAndBagFrame>) {
  let focused = false;
  let transferred = false;
  const sent: Array<Record<string, unknown>> = [];
  return {
    get transferred() {
      return transferred;
    },
    get sent() {
      return sent;
    },
    hostFactory: () => ({
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
          writeFileSync(String(payload.path), grayBmp(transferred ? emptied : initial));
          return { ok: true, ...TEST_CLIENT };
        }
        if (payload.op === "ctrlburst") {
          transferred = true;
          return { ok: true, focused: true };
        }
        if (
          payload.op === "click" ||
          payload.op === "rightclick" ||
          payload.op === "move" ||
          payload.op === "drag" ||
          payload.op === "hotkey" ||
          payload.op === "type" ||
          payload.op === "setclipboard" ||
          payload.op === "clipboard"
        ) {
          return { ok: true, focused: true, text: "" };
        }
        return { ok: false, error: `unexpected-${String(payload.op)}` };
      },
      async close() {},
    }),
  };
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
    await expect(
      service.start({
        kind: "fill",
        dryRun: true,
        wantedClasses: [],
        uniqueAcrossCycles: false,
        qaAcknowledged: false,
        allowlist: ["PathOfExile.exe"],
      }),
    ).resolves.toMatchObject({ ok: true, dryRun: true, kind: "fill" });
    expect(service.status.gridsCalibrated).toBe(true);
    expect(service.status.searchCalibrated).toBe(false);
  });

  it("fills without search calibration when no class filter is requested", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-unfiltered-"));
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
    };
    let focused = false;
    let transferred = false;
    const hostFactory = () => ({
      async send(payload: Record<string, unknown>) {
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
            ? stashAndBagFrame([{ row: 0, col: 0 }, { row: 0, col: 1 }], [])
            : initial;
          writeFileSync(String(payload.path), grayBmp(frame));
          return { ok: true, ...TEST_CLIENT };
        }
        if (payload.op === "ctrlburst") {
          transferred = true;
          return { ok: true, focused: true };
        }
        if (
          payload.op === "click" ||
          payload.op === "rightclick" ||
          payload.op === "move" ||
          payload.op === "drag" ||
          payload.op === "hotkey" ||
          payload.op === "type" ||
          payload.op === "setclipboard" ||
          payload.op === "clipboard"
        ) {
          return { ok: true, focused: true, text: "" };
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
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
      actionsPerMinute: 600,
      maxItems: 2,
    });

    expect(result).toMatchObject({ ok: true, dryRun: false, kind: "fill" });
    expect(transferred).toBe(true);
    expect(service.status.searchCalibrated).toBe(false);
  });

  it("empties occupied bag cells without requiring stash search", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-empty-"));
    const initial = stashAndBagFrame([{ row: 0, col: 0 }, { row: 0, col: 1 }], []);
    const host = liveHost(initial, stashAndBagFrame([], []));
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => calibratedProfile(initial),
      hostFactory: host.hostFactory,
    });

    const result = await service.start({
      kind: "empty",
      dryRun: false,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
      actionsPerMinute: 600,
    });

    expect(result).toMatchObject({ ok: true, dryRun: false, kind: "empty", reason: "bag-empty" });
    expect(host.transferred).toBe(true);
    expect(host.sent.some((entry) => entry.op === "ctrlburst")).toBe(true);
  });

  it("runs Empty when the bag already looks empty instead of skipping the deposit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-empty-already-"));
    const initial = stashAndBagFrame([], []);
    const host = liveHost(initial, initial);
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => calibratedProfile(initial),
      hostFactory: host.hostFactory,
    });

    const result = await service.start({
      kind: "empty",
      dryRun: false,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
      actionsPerMinute: 600,
    });

    expect(result).toMatchObject({ ok: true, dryRun: false, kind: "empty", reason: "bag-empty" });
    expect(host.transferred).toBe(false);
    expect(result.traces.some((trace) => trace.decisionRule === "closed-loop-transfer")).toBe(false);
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

  it("publishes a dry-run overlay plan from traces and hides it on stop", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-overlay-"));
    const frame = stashAndBagFrame([{ row: 0, col: 1 }], [{ row: 0, col: 0 }]);
    const profile = {
      ...calibratedProfile(frame),
      stashSearch: { x: 200, y: 790, w: 300, h: 30 },
    };
    const plans: Array<DryRunOverlayPlan | null> = [];
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: false,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => profile,
      hostFactory: liveHost(frame, frame).hostFactory,
      onDryRunOverlay: (plan) => plans.push(plan),
    });

    const result = await service.start({
      kind: "fill",
      dryRun: true,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });

    expect(plans[0]).toBeNull();
    const shown = plans.at(-1);
    expect(service.status.overlayVisible).toBe(true);
    expect(shown).toMatchObject({ kind: "fill", client: TEST_CLIENT });
    expect(shown?.grids.map((grid) => grid.region)).toEqual(["stash", "bag", "search"]);
    const clickTraces = result.traces.filter((entry) => entry.input?.kind === "click");
    expect(clickTraces.length).toBeGreaterThan(0);
    expect(shown?.clicks.length).toBe(clickTraces.length);
    expect(shown?.clicks.map((click) => click.n)).toEqual(clickTraces.map((_, index) => index + 1));
    expect(shown?.clicks.map((click) => [click.x, click.y])).toEqual(
      clickTraces.map((entry) => [entry.input?.x, entry.input?.y]),
    );
    expect(shown?.occupied.some((cell) => cell.area === "stash" && cell.row === 0 && cell.col === 0)).toBe(
      true,
    );
    expect(shown?.occupied.some((cell) => cell.area === "bag" && cell.row === 0 && cell.col === 1)).toBe(
      true,
    );
    expect(shown?.detected).toEqual(shown?.occupied);
    expect(shown?.evidenceHash).toEqual(expect.any(String));
    expect(shown?.screenshotId).toMatch(/\.png$/);

    service.hideOverlay();
    expect(service.status.overlayVisible).toBe(false);
    expect(plans.at(-1)).toBeNull();
  });

  it("records overlay occupancy Right/Wrong labels for the selected cell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-overlay-label-"));
    const frame = stashAndBagFrame([{ row: 0, col: 1 }], [{ row: 0, col: 0 }]);
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: false,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => calibratedProfile(frame),
      hostFactory: liveHost(frame, frame).hostFactory,
    });

    await service.start({
      kind: "empty",
      dryRun: true,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });

    expect(service.selectOverlayCell()).toEqual({ selected: [] });
    const selected = service.selectOverlayCell({
      area: "stash",
      row: 0,
      col: 0,
      occupied: true,
    }).selected;
    expect(selected).toEqual(
      expect.arrayContaining([{ area: "stash", row: 0, col: 0, occupied: true }]),
    );
    expect(service.status.overlaySelection).toEqual(selected);

    const labeled = service.labelOverlayCell("wrong");
    expect(labeled).toMatchObject({
      ok: true,
      selected,
      labels: [
        expect.objectContaining({
          area: "stash",
          row: 0,
          col: 0,
          perceivedOccupied: true,
          label: "wrong",
          evidenceHash: expect.any(String),
          screenshotId: expect.stringMatching(/\.png$/),
        }),
      ],
    });
    const file = occupancyLabelsPath(root);
    expect(service.status.overlayLabelFile).toBe(file);
    const payload = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({
        timestamp: expect.any(String),
        area: "stash",
        row: 0,
        col: 0,
        perceivedOccupied: true,
        label: "wrong",
        evidenceHash: expect.any(String),
        screenshotId: expect.stringMatching(/\.png$/),
      }),
    );
  });

  it("shift-adds overlay items and Wrong writes one jsonl line per selected cell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-assistive-overlay-multi-"));
    const frame = stashAndBagFrame([{ row: 0, col: 1 }], [{ row: 0, col: 0 }]);
    const service = new AssistiveRunService({
      mode: "authorized-qa",
      qaOptIn: false,
      killSwitch: new KillSwitch(),
      memoryRoot: root,
      artifactDir: path.join(root, "artifacts"),
      profile: () => calibratedProfile(frame),
      hostFactory: liveHost(frame, frame).hostFactory,
    });

    await service.start({
      kind: "empty",
      dryRun: true,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
    });

    const first = service.selectOverlayCell({
      area: "stash",
      row: 0,
      col: 0,
      occupied: true,
    }).selected;
    const replaced = service.selectOverlayCell({
      area: "bag",
      row: 0,
      col: 1,
      occupied: true,
    }).selected;
    expect(replaced.some((cell) => cell.area === "stash")).toBe(false);
    expect(replaced.some((cell) => cell.area === "bag" && cell.row === 0 && cell.col === 1)).toBe(
      true,
    );

    const added = service.selectOverlayCell(
      { area: "stash", row: 0, col: 0, occupied: true },
      { additive: true },
    ).selected;
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.some((cell) => cell.area === "bag" && cell.row === 0 && cell.col === 1)).toBe(true);
    expect(added.some((cell) => cell.area === "stash" && cell.row === 0 && cell.col === 0)).toBe(
      true,
    );
    expect(first.length).toBeGreaterThan(0);

    const labeled = service.labelOverlayCell("wrong");
    expect(labeled.ok).toBe(true);
    if (!labeled.ok) return;
    expect(labeled.selected).toHaveLength(added.length);
    expect(labeled.labels).toHaveLength(added.length);

    const lines = readFileSync(occupancyLabelsPath(root), "utf8")
      .trim()
      .split(/\r?\n/);
    expect(lines).toHaveLength(added.length);
    const payloads = lines.map((line) => JSON.parse(line) as { area: string; row: number; col: number; label: string });
    expect(payloads.every((entry) => entry.label === "wrong")).toBe(true);
    expect(payloads.some((entry) => entry.area === "stash" && entry.row === 0 && entry.col === 0)).toBe(
      true,
    );
    expect(payloads.some((entry) => entry.area === "bag" && entry.row === 0 && entry.col === 1)).toBe(
      true,
    );
  });
});
