import { app, desktopCapturer, ipcMain, nativeImage } from "electron";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bmpToGray, readBmpBgr } from "../adapters/bmp.js";
import { grayMean, nativeImageToGray } from "../adapters/nativeImageGray.js";
import { startWinHost } from "../adapters/winHost.js";
import { loadProfile, resetProfile, saveProfile } from "../core/calibrationStore.js";
import type { GrayImage } from "../core/grayImage.js";
import { perceiveUi } from "../core/uiPerception.js";
import {
  resolvePhysicalClient,
  suggestMonitor,
  type ScreenRect,
  type SelectedMonitor,
} from "../core/screenLayout.js";
import {
  applyStashPanel,
  clientBoxesMatch,
  packNpcPatch,
  packPatch,
  QUAD_STASH_CELLS,
  type CalibrationProfile,
  type ClientBox,
  type GridMark,
} from "../core/calibrationProfile.js";
import {
  buildTransferDiagnostic,
  type DiagnosticCorrection,
  type TransferDiagnosticReport,
} from "../core/transferDiagnostics.js";

function templateDir(): string {
  const dir = path.join(app.getPath("userData"), "perception-templates");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function repoTemplateDir(): string {
  return path.join(app.isPackaged ? app.getAppPath() : process.cwd(), "fixtures", "perception", "templates");
}

export function readMergedProfile(): CalibrationProfile {
  const user = loadProfile(templateDir());
  if (user.stashGrid || user.quadStashGrid || user.bagGrid || user.ventorBagGrid || user.npcs.length) return user;
  return loadProfile(repoTemplateDir());
}

function withGridPatch(frame: GrayImage, screen: ScreenRect, grid: GridMark): GridMark {
  return { ...grid, patch: packPatch(frame, screen, grid) };
}

export function persistProfile(profile: CalibrationProfile): { file: string; profile: CalibrationProfile } {
  const file = saveProfile(templateDir(), profile);
  if (!app.isPackaged) saveProfile(repoTemplateDir(), profile);
  return { file, profile };
}

function clientFromCapture(
  captured: { left?: unknown; top?: unknown; width?: unknown; height?: unknown },
  focused: { monitorWidth?: unknown; monitorHeight?: unknown },
  monitor?: SelectedMonitor,
): ScreenRect {
  const origin = monitor ?? { left: 0, top: 0 };
  return resolvePhysicalClient(
    {
      left: Number(captured.left),
      top: Number(captured.top),
      width: Number(captured.width),
      height: Number(captured.height),
    },
    monitor?.width || Number(focused.monitorWidth) || Number(captured.width),
    monitor?.height || Number(focused.monitorHeight) || Number(captured.height),
    origin,
  );
}

async function listHostMonitors(): Promise<SelectedMonitor[]> {
  const host = startWinHost();
  try {
    const reply = await host.send({ op: "monitors" });
    const rows = Array.isArray(reply.monitors) ? reply.monitors : [];
    return rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        id: Number(item.id),
        label: String(item.label ?? `Monitor ${Number(item.id) + 1}`),
        left: Number(item.left),
        top: Number(item.top),
        width: Number(item.width),
        height: Number(item.height),
        primary: Boolean(item.primary),
      };
    });
  } finally {
    await host.close();
  }
}

function monitorFromHost(reply: Record<string, unknown>): SelectedMonitor {
  return {
    id: 0,
    label: String(reply.monitorLabel ?? reply.process ?? "Path of Exile 2"),
    left: Number(reply.monitorLeft ?? reply.left ?? 0),
    top: Number(reply.monitorTop ?? reply.top ?? 0),
    width: Number(reply.monitorWidth ?? reply.width ?? 0),
    height: Number(reply.monitorHeight ?? reply.height ?? 0),
    primary: Number(reply.monitorLeft ?? 0) === 0 && Number(reply.monitorTop ?? 0) === 0,
  };
}

export interface PoeTarget {
  process: string;
  title: string;
  window: ScreenRect;
  monitor: SelectedMonitor;
}

async function findPoeTarget(): Promise<PoeTarget> {
  const host = startWinHost();
  try {
    const focused = await host.send({ op: "rect" });
    if (!focused.ok) {
      throw new Error(String(focused.error ?? "Path of Exile 2 window not found"));
    }
    const window = {
      left: Number(focused.left),
      top: Number(focused.top),
      width: Number(focused.width),
      height: Number(focused.height),
    };
    const monitor = monitorFromHost(focused);
    return {
      process: String(focused.process ?? "PathOfExile"),
      title: String(focused.title ?? "Path of Exile 2"),
      window,
      monitor,
    };
  } finally {
    await host.close();
  }
}

function previewJpeg(image: ReturnType<typeof nativeImage.createEmpty>): string {
  const resized = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
  return `data:image/jpeg;base64,${resized.toJPEG(70).toString("base64")}`;
}

function grayFromCapturePath(file: string) {
  if (file.toLowerCase().endsWith(".bmp")) return bmpToGray(file);
  return nativeImageToGray(nativeImage.createFromPath(file));
}

function bgrFromCapturePath(file: string) {
  if (file.toLowerCase().endsWith(".bmp")) return readBmpBgr(file);
  const image = nativeImage.createFromPath(file);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const data = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 3] = bitmap[pixel * 4]!;
    data[pixel * 3 + 1] = bitmap[pixel * 4 + 1]!;
    data[pixel * 3 + 2] = bitmap[pixel * 4 + 2]!;
  }
  return { width, height, data };
}

function diagnosticRoot(): string {
  return app.isPackaged
    ? path.join(app.getPath("userData"), "diagnostics")
    : path.join(process.cwd(), "artifacts", "diagnostics");
}

function exportDiagnosticBundle(payload: {
  bmpPath: string;
  screen: ScreenRect;
  profile: CalibrationProfile;
  report: TransferDiagnosticReport;
  corrections: DiagnosticCorrection[];
  trace?: unknown[];
}): { dir: string; screenshot: string } {
  if (!payload.bmpPath || !existsSync(payload.bmpPath)) throw new Error("diagnostic-capture-missing");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(diagnosticRoot(), stamp);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(payload.bmpPath) || ".png";
  const screenshot = path.join(dir, `capture${ext}`);
  copyFileSync(payload.bmpPath, screenshot);
  writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(payload.profile, null, 2)}\n`);
  writeFileSync(path.join(dir, "scores.json"), `${JSON.stringify(payload.report, null, 2)}\n`);
  writeFileSync(path.join(dir, "corrections.json"), `${JSON.stringify(payload.corrections, null, 2)}\n`);
  writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        screenshot: path.basename(screenshot),
        screen: payload.screen,
        correctionCount: payload.corrections.length,
      },
      null,
      2,
    )}\n`,
  );
  const trace = payload.trace ?? [];
  writeFileSync(path.join(dir, "trace.jsonl"), trace.map((entry) => JSON.stringify(entry)).join("\n") + (trace.length ? "\n" : ""));
  return { dir, screenshot };
}

async function capturePoeImage(client: ScreenRect) {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: Math.max(client.width, 1280), height: Math.max(client.height, 720) },
  });
  const named = sources.find((source) => /path of exile/i.test(source.name) && !source.thumbnail.isEmpty());
  if (named) return named.thumbnail;
  const screenHit = sources.find((source) => {
    if (source.thumbnail.isEmpty()) return false;
    const size = source.thumbnail.getSize();
    return Math.abs(size.width - client.width) < 8 && Math.abs(size.height - client.height) < 8;
  });
  return screenHit?.thumbnail;
}

async function captureFrame(monitor?: SelectedMonitor): Promise<{
  bmpPath: string;
  gray: ReturnType<typeof bmpToGray>;
  client: ScreenRect;
  preview: string;
  target: PoeTarget;
}> {
  const host = startWinHost();
  try {
    const focused = await host.send({ op: "rect" });
    if (!focused.ok) {
      throw new Error(String(focused.error ?? "Path of Exile 2 window not found"));
    }
    const detected = monitorFromHost(focused);
    const client = clientFromCapture(focused, focused, monitor ?? detected);
    let image = await capturePoeImage(client);
    let gray = image && !image.isEmpty() ? nativeImageToGray(image) : undefined;
    const stampPath = path.join(app.getPath("temp"), `poe2-cal-${Date.now()}.png`);
    if (!image || !gray || grayMean(gray) < 8) {
      const bmpPath = stampPath.replace(/\.png$/i, ".bmp");
      const captured = await host.send({ op: "capture", path: bmpPath });
      if (!captured.ok) throw new Error("capture failed");
      image = nativeImage.createFromPath(bmpPath);
      gray = bmpToGray(bmpPath);
      if (grayMean(gray) < 8) {
        throw new Error(
          "Capture was black. Path of Exile 2 is blocking GDI screenshots in this display mode. Set the game to Windowed (not exclusive fullscreen) and try again.",
        );
      }
      return {
        bmpPath,
        gray,
        client: clientFromCapture(captured, focused, monitor ?? detected),
        preview: previewJpeg(image),
        target: {
          process: String(focused.process ?? "PathOfExile"),
          title: String(focused.title ?? "Path of Exile 2"),
          window: client,
          monitor: detected,
        },
      };
    }
    writeFileSync(stampPath, image.toPNG());
    return {
      bmpPath: stampPath,
      gray,
      client,
      preview: previewJpeg(image),
      target: {
        process: String(focused.process ?? "PathOfExile"),
        title: String(focused.title ?? "Path of Exile 2"),
        window: client,
        monitor: detected,
      },
    };
  } finally {
    await host.close();
  }
}

export function registerCalibrationIpc(): void {
  ipcMain.handle("cal:profile", () => readMergedProfile());
  ipcMain.handle("cal:save", (_event, profile: CalibrationProfile) => persistProfile(profile));
  ipcMain.handle("cal:reset", () => {
    const profile = resetProfile(templateDir());
    if (!app.isPackaged) resetProfile(repoTemplateDir());
    return { profile };
  });
  ipcMain.handle("cal:monitors", async () => {
    const monitors = await listHostMonitors();
    const profile = readMergedProfile();
    return { monitors, selected: profile.monitor ?? suggestMonitor(monitors) };
  });
  ipcMain.handle("cal:target", async () => findPoeTarget());
  ipcMain.handle("cal:capture", async (_event, profile?: CalibrationProfile) => {
    const shot = await captureFrame();
    return {
      preview: shot.preview,
      client: { left: 0, top: 0, width: shot.client.width, height: shot.client.height },
      screen: shot.client,
      bmpPath: shot.bmpPath,
      target: shot.target,
    };
  });
  ipcMain.handle("cal:look", async (_event, profile: CalibrationProfile) => {
    const started = Date.now();
    const shot = await captureFrame();
    const facts = perceiveUi(
      shot.gray,
      shot.client,
      {},
      profile,
      bgrFromCapturePath(shot.bmpPath),
    );
    return { facts, client: shot.client, preview: shot.preview, elapsedMs: Date.now() - started, target: shot.target };
  });
  ipcMain.handle(
    "cal:diagnose",
    async (
      _event,
      payload: {
        profile: CalibrationProfile;
        corrections?: DiagnosticCorrection[];
        bmpPath?: string;
        screen?: ScreenRect;
      },
    ) => {
      const started = Date.now();
      const reuse =
        Boolean(payload.bmpPath) &&
        existsSync(payload.bmpPath!) &&
        Boolean(payload.screen?.width && payload.screen?.height);
      const shot = reuse ? undefined : await captureFrame();
      const bmpPath = reuse ? payload.bmpPath! : shot!.bmpPath;
      const client = reuse ? payload.screen! : shot!.client;
      const gray = reuse ? grayFromCapturePath(bmpPath) : shot!.gray;
      const bgr = bgrFromCapturePath(bmpPath);
      const facts = perceiveUi(gray, client, {}, payload.profile, bgr);
      const report = buildTransferDiagnostic({
        gray,
        bgr,
        client,
        profile: payload.profile,
        facts,
        corrections: payload.corrections ?? [],
      });
      return {
        report,
        facts: report.facts,
        screen: client,
        bmpPath,
        preview: reuse
          ? previewJpeg(nativeImage.createFromPath(bmpPath))
          : shot!.preview,
        elapsedMs: Date.now() - started,
        target: shot?.target,
      };
    },
  );
  ipcMain.handle(
    "cal:export-diagnostic",
    (
      _event,
      payload: {
        bmpPath: string;
        screen: ScreenRect;
        profile: CalibrationProfile;
        report: TransferDiagnosticReport;
        corrections: DiagnosticCorrection[];
        trace?: unknown[];
      },
    ) => exportDiagnosticBundle(payload),
  );
  ipcMain.handle(
    "cal:stamp",
    (
      _event,
      payload: {
        bmpPath: string;
        screen: ScreenRect;
        profile: CalibrationProfile;
        stashPanel?: ClientBox;
        stashGrid?: GridMark;
        quadStashGrid?: GridMark;
        activeStashTab?: "normal" | "quad";
        bagGrid?: GridMark;
        ventorBagGrid?: GridMark;
        stashSearch?: ClientBox;
        npc?: { label: string; x: number; y: number; w?: number; h?: number };
      },
    ) => {
      const gray = grayFromCapturePath(payload.bmpPath);
      const next: CalibrationProfile = {
        ...payload.profile,
        client: { width: payload.screen.width, height: payload.screen.height },
        npcs: [...payload.profile.npcs],
      };
      const stashBox = payload.stashPanel ?? payload.stashGrid ?? payload.quadStashGrid;
      if (stashBox) {
        if (
          payload.stashGrid &&
          payload.quadStashGrid &&
          !clientBoxesMatch(payload.stashGrid, payload.quadStashGrid)
        ) {
          next.stashGrid = withGridPatch(gray, payload.screen, payload.stashGrid);
          next.quadStashGrid = withGridPatch(gray, payload.screen, payload.quadStashGrid);
        } else {
          const stamped = applyStashPanel(stashBox);
          const patched = withGridPatch(gray, payload.screen, stamped.stashGrid);
          next.stashGrid = patched;
          next.quadStashGrid = { ...patched, ...QUAD_STASH_CELLS };
        }
      }
      if (payload.activeStashTab) next.activeStashTab = payload.activeStashTab;
      if (payload.bagGrid) next.bagGrid = withGridPatch(gray, payload.screen, payload.bagGrid);
      if (payload.ventorBagGrid) next.ventorBagGrid = withGridPatch(gray, payload.screen, payload.ventorBagGrid);
      if (payload.stashSearch) next.stashSearch = payload.stashSearch;
      if (payload.npc) {
        const box =
          payload.npc.w && payload.npc.h
            ? { x: payload.npc.x, y: payload.npc.y, w: payload.npc.w, h: payload.npc.h }
            : undefined;
        next.npcs = [
          {
            id: payload.npc.label.toLowerCase().replace(/\s+/g, "-"),
            label: payload.npc.label,
            x: payload.npc.x,
            y: payload.npc.y,
            w: box?.w,
            h: box?.h,
            patch: box
              ? packPatch(gray, payload.screen, box)
              : packNpcPatch(gray, payload.screen, payload.npc.x, payload.npc.y),
          },
          ...next.npcs.filter((entry) => entry.label !== payload.npc!.label),
        ];
      }
      return persistProfile(next);
    },
  );
  ipcMain.handle("cal:walk-npc", async () => ({
    ok: false,
    error: "direct-calibration-input-disabled-use-audited-transfer-controls",
  }));
}
