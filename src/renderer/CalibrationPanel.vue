<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  BAG_CELLS,
  activeStashGrid,
  applyMapsStashPanel,
  applyStashPanel,
  juiceCalibrationFocus,
  mapsCalibrationHidesOthers,
  mapsStashGrid,
  nudgeGridMark,
  showMapsCalibrationMark,
  emptyProfile,
  VENTOR_BAG_CELLS,
  profileReadyForDeposit,
  stashAreasDiverge,
  toPlain,
  type CalibrationProfile,
  type ClientBox,
  type GridMark,
} from "@core/calibrationProfile";
import { gridClickCenters } from "@core/gridLattice";
import type { UiFacts } from "@core/uiPerception";
import type { ScreenRect } from "@core/screenLayout";
import type {
  DiagnosticCorrection,
  DiagnosticCorrectionKind,
  DiagnosticGrid,
  TransferDiagnosticReport,
} from "@core/transferDiagnostics";
import {
  getCalibrationApi,
  type PoeTarget,
} from "./services/rendererApi";

type Tool =
  | "juice-grids"
  | "stash-grid"
  | "maps-grid"
  | "bag-grid"
  | "ventor-bag-grid"
  | "stash-search"
  | DiagnosticCorrectionKind;

const profile = ref<CalibrationProfile>(emptyProfile());
const preview = ref("");
const bmpPath = ref("");
const screen = ref({ left: 0, top: 0, width: 3840, height: 2160 });
const tool = ref<Tool>("juice-grids");
const overlayUp = ref(false);
const status = ref("Capture the Path of Exile window, then draw the stash and bag grids.");
const facts = ref<UiFacts | null>(null);
const elapsedMs = ref<number | null>(null);
const drawing = ref(false);
const mapsDragStarted = ref(false);
const draft = ref<ClientBox | null>(null);
const start = ref({ x: 0, y: 0 });
const img = ref<HTMLImageElement | null>(null);
const target = ref<PoeTarget | null>(null);
const diagnostic = ref<TransferDiagnosticReport | null>(null);
const corrections = ref<DiagnosticCorrection[]>([]);
const diagnosticTrace = ref<Array<Record<string, unknown>>>([]);
const footprintW = ref(1);
const footprintH = ref(1);

const runtime = getCalibrationApi;

const readyDeposit = computed(() => profileReadyForDeposit(profile.value));
const troubleshooting = computed(() =>
  tool.value === "missed-item" || tool.value === "false-occupied" || tool.value === "wrong-footprint",
);
const disagreementCount = computed(() => diagnostic.value?.cells.filter((cell) => cell.disagreement).length ?? 0);
const stashPanelSaved = computed(() => Boolean(profile.value.stashGrid || profile.value.quadStashGrid));
const stashMarksDiverge = computed(() => stashAreasDiverge(profile.value));
const sharedStashBox = computed(() => {
  if (stashMarksDiverge.value) return null;
  const box = profile.value.stashGrid ?? profile.value.quadStashGrid;
  if (!box) return null;
  return { x: box.x, y: box.y, w: box.w, h: box.h };
});
const mapsSolo = computed(() => mapsCalibrationHidesOthers(tool.value));
const juiceFocus = computed(() => juiceCalibrationFocus(tool.value));
const hideStashMarks = computed(() => mapsSolo.value || juiceFocus.value);
const showBagMark = computed(() => Boolean(profile.value.bagGrid) && !mapsSolo.value);
const mapsMark = computed(() => mapsStashGrid(profile.value));
const showMapsMark = computed(() =>
  showMapsCalibrationMark(tool.value, Boolean(mapsMark.value), drawing.value),
);

function selectTool(next: Tool) {
  tool.value = next;
  if (next === "maps-grid") {
    mapsDragStarted.value = false;
    drawing.value = false;
    draft.value = null;
    status.value = "Maps: other marks hidden. The pink lattice is see-through — drag a new 12×8 box around the wells.";
  } else if (next === "juice-grids") {
    status.value = "Juice lattices: pink Maps 12×8 wells and gold bag. Show on game, then redraw a box if a dot misses.";
  }
}

const needsGridResnap = computed(
  () =>
    Boolean(stashPanelSaved.value && !profile.value.stashGrid?.patch && !profile.value.quadStashGrid?.patch) ||
    Boolean(profile.value.bagGrid && !profile.value.bagGrid.patch) ||
    Boolean(profile.value.ventorBagGrid && !profile.value.ventorBagGrid.patch),
);

function toClient(event: MouseEvent): { x: number; y: number } | null {
  const el = img.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(((event.clientX - rect.left) / rect.width) * screen.value.width),
    y: Math.round(((event.clientY - rect.top) / rect.height) * screen.value.height),
  };
}

function boxStyle(box: ClientBox) {
  return {
    left: `${(box.x / screen.value.width) * 100}%`,
    top: `${(box.y / screen.value.height) * 100}%`,
    width: `${(box.w / screen.value.width) * 100}%`,
    height: `${(box.h / screen.value.height) * 100}%`,
  };
}

function latticeBoxStyle(mark: GridMark) {
  return {
    ...boxStyle(mark),
    "--cols": String(mark.cols),
    "--rows": String(mark.rows),
  };
}

function dotStyle(mark: GridMark, dot: { x: number; y: number }) {
  return {
    left: `${((dot.x - mark.x) / mark.w) * 100}%`,
    top: `${((dot.y - mark.y) / mark.h) * 100}%`,
  };
}

function pointStyle(point: { x: number; y: number }) {
  return {
    left: `${((point.x - screen.value.left) / screen.value.width) * 100}%`,
    top: `${((point.y - screen.value.top) / screen.value.height) * 100}%`,
  };
}

function correctionCell(point: { x: number; y: number }): { grid: DiagnosticGrid; row: number; col: number } | null {
  const stash = activeStashGrid(profile.value, facts.value?.stashGridSize);
  const candidates: Array<{ grid: DiagnosticGrid; mark: typeof stash }> = [
    { grid: "stash", mark: stash },
    { grid: "bag", mark: profile.value.bagGrid },
  ];
  for (const candidate of candidates) {
    const mark = candidate.mark;
    if (!mark) continue;
    if (point.x < mark.x || point.y < mark.y || point.x >= mark.x + mark.w || point.y >= mark.y + mark.h) {
      continue;
    }
    return {
      grid: candidate.grid,
      row: Math.min(mark.rows - 1, Math.floor(((point.y - mark.y) / mark.h) * mark.rows)),
      col: Math.min(mark.cols - 1, Math.floor(((point.x - mark.x) / mark.w) * mark.cols)),
    };
  }
  return null;
}

async function markCorrection(point: { x: number; y: number }) {
  if (!troubleshooting.value) return;
  const cell = correctionCell(point);
  if (!cell) {
    status.value = "Click inside the calibrated stash or bag grid.";
    return;
  }
  const correction: DiagnosticCorrection = {
    kind: tool.value as DiagnosticCorrectionKind,
    ...cell,
    w: tool.value === "false-occupied" ? undefined : Math.max(1, Math.min(2, footprintW.value)),
    h: tool.value === "false-occupied" ? undefined : Math.max(1, Math.min(4, footprintH.value)),
    createdAt: new Date().toISOString(),
  };
  corrections.value.push(correction);
  diagnosticTrace.value.push({ at: correction.createdAt, event: "operator-correction", correction });
  await diagnose(false);
}

onMounted(async () => {
  const api = runtime();
  if (!api) {
    status.value = "Open this tab in the Electron app (npm run dev), not a plain browser.";
    return;
  }
  profile.value = await api.profile();
  await findTarget();
  if (profile.value.mapsStashGrid || profile.value.bagGrid) {
    await showOnGame();
  }
});

async function findTarget() {
  const api = runtime();
  if (!api) return;
  try {
    const found = await api.target();
    target.value = found;
    profile.value = { ...toPlain(profile.value), monitor: toPlain(found.monitor) };
    try {
      await api.save(toPlain(profile.value));
    } catch {
      /* keep the live window even if save cannot clone */
    }
    status.value = `Using ${found.process} — ${found.window.width}×${found.window.height} at (${found.window.left}, ${found.window.top}).`;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "Path of Exile 2 window not found.";
  }
}

async function showOnGame() {
  const api = runtime();
  if (!api?.overlayGrids) {
    status.value = "Show on game needs the Electron app.";
    return;
  }
  status.value = "Drawing juice lattices over the game…";
  try {
    const shot = await api.overlayGrids();
    preview.value = shot.preview;
    bmpPath.value = shot.bmpPath;
    screen.value = shot.screen;
    target.value = shot.target;
    overlayUp.value = true;
    status.value = `On game: ${shot.grids.join(" · ")} · ${shot.clickCount} click centers. Pink Maps / gold bag. Redraw any cell whose dot misses the icon.`;
  } catch (error) {
    overlayUp.value = false;
    status.value = error instanceof Error ? error.message : "Grid overlay failed";
  }
}

async function nudgeMaps(dx: number, dy: number) {
  const mark = mapsMark.value;
  if (!mark) {
    status.value = "Draw Maps first, then nudge.";
    return;
  }
  const next = applyMapsStashPanel(nudgeGridMark(mark, dx, dy), mark.patch);
  profile.value = { ...toPlain(profile.value), mapsStashGrid: next };
  const api = runtime();
  if (api) await api.save(toPlain(profile.value));
  status.value = `Maps slid to ${next.x},${next.y}. Show on game to check the dots.`;
}

async function hideOnGame() {
  const api = runtime();
  if (!api?.hideGrids) return;
  await api.hideGrids();
  overlayUp.value = false;
  status.value = "Game overlay hidden. Screenshot stays so you can redraw Maps or Bag.";
}

async function capture(after?: string) {
  const api = runtime();
  if (!api) return;
  overlayUp.value = false;
  status.value = "Capturing…";
  try {
    const shot = await api.capture(toPlain(profile.value));
    preview.value = shot.preview;
    bmpPath.value = shot.bmpPath;
    screen.value = shot.screen;
    target.value = shot.target;
    profile.value = { ...profile.value, monitor: shot.target.monitor };
    diagnostic.value = null;
    corrections.value = [];
    diagnosticTrace.value = [];
    status.value =
      after ??
      `Captured ${shot.target.process} ${shot.screen.width}×${shot.screen.height} at (${shot.screen.left}, ${shot.screen.top}). Saved marks stay; draw on this new snapshot.`;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "Capture failed";
  }
}

async function stamp(partial: Record<string, unknown>) {
  const api = runtime();
  if (!api || !bmpPath.value) {
    status.value = "Capture first, then mark the screen.";
    return;
  }
  const saved = await api.stamp({
    bmpPath: bmpPath.value,
    screen: toPlain(screen.value),
    profile: toPlain(profile.value),
    ...partial,
  });
  profile.value = saved.profile;
}

function onDown(event: MouseEvent) {
  const point = toClient(event);
  if (!point || !preview.value) return;
  if (troubleshooting.value) {
    void markCorrection(point);
    return;
  }
  drawing.value = true;
  if (tool.value === "maps-grid") mapsDragStarted.value = true;
  start.value = point;
  draft.value = { x: point.x, y: point.y, w: 1, h: 1 };
}

function onMove(event: MouseEvent) {
  if (!drawing.value) return;
  const point = toClient(event);
  if (!point) return;
  draft.value = {
    x: Math.min(start.value.x, point.x),
    y: Math.min(start.value.y, point.y),
    w: Math.max(1, Math.abs(point.x - start.value.x)),
    h: Math.max(1, Math.abs(point.y - start.value.y)),
  };
}

async function onUp() {
  if (!drawing.value || !draft.value) return;
  drawing.value = false;
  const box = draft.value;
  draft.value = null;
  if (box.w < 8 || box.h < 8) {
    status.value = "Box is too small — drag a visible region.";
    return;
  }
  if (tool.value === "stash-grid") {
    await stamp({ stashPanel: box, ...applyStashPanel(box) });
    status.value = "Saved stash panel. Normal 12×12 and quad 24×24 use this same area; Look reports which tab is open.";
  } else if (tool.value === "maps-grid") {
    await stamp({ mapsStashGrid: applyMapsStashPanel(box) });
    status.value = "Saved Maps 12×8 unique-tab grid (below the T1–T16 strip). Juice T15 uses this rectangle, not the regular stash panel.";
  } else if (tool.value === "bag-grid") {
    await stamp({ bagGrid: { ...box, ...BAG_CELLS } });
    status.value = "Saved player bag grid. Screenshot a vendor window and draw Vendor separately.";
  } else if (tool.value === "ventor-bag-grid") {
    await stamp({ ventorBagGrid: { ...box, ...VENTOR_BAG_CELLS } });
    status.value = "Saved vendor inventory grid (12×5). Look reports this separately from the player bag.";
  } else if (tool.value === "stash-search") {
    await stamp({ stashSearch: box });
    status.value = "Saved stash search box. Class fills will click the center of this mark only.";
  }
}

async function resetCalibration() {
  const api = runtime();
  if (!api) {
    profile.value = emptyProfile();
    preview.value = "";
    bmpPath.value = "";
    facts.value = null;
    elapsedMs.value = null;
    diagnostic.value = null;
    corrections.value = [];
    diagnosticTrace.value = [];
    draft.value = null;
    mapsDragStarted.value = false;
    status.value = "Calibration cleared. Capture the Path of Exile window and draw the HUD again.";
    return;
  }
  const saved = await api.reset();
  profile.value = saved.profile;
  preview.value = "";
  bmpPath.value = "";
  facts.value = null;
  elapsedMs.value = null;
  diagnostic.value = null;
  corrections.value = [];
  diagnosticTrace.value = [];
  draft.value = null;
  mapsDragStarted.value = false;
  status.value = "Calibration cleared. Capture the Path of Exile window and draw the HUD again.";
  await findTarget();
}

async function look() {
  const api = runtime();
  if (!api) return;
  status.value = "Looking…";
  try {
    const result = await api.look(toPlain(profile.value));
    facts.value = result.facts;
    elapsedMs.value = result.elapsedMs;
    preview.value = result.preview;
    if (result.target) target.value = result.target;
    status.value = `${result.facts.reason} in ${result.elapsedMs} ms`;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "Look failed";
  }
}

async function diagnose(recapture = true) {
  const api = runtime();
  if (!api) return;
  status.value = "Running grid diagnostics…";
  try {
    const result = await api.diagnose({
      profile: toPlain(profile.value),
      corrections: toPlain(corrections.value),
      ...(recapture || !bmpPath.value
        ? {}
        : { bmpPath: bmpPath.value, screen: toPlain(screen.value) }),
    });
    diagnostic.value = result.report;
    facts.value = result.facts;
    elapsedMs.value = result.elapsedMs;
    preview.value = result.preview;
    bmpPath.value = result.bmpPath;
    screen.value = result.screen;
    if (result.target) target.value = result.target;
    diagnosticTrace.value.push({
      at: new Date().toISOString(),
      event: "diagnose",
      reason: result.facts.reason,
      disagreementCount: result.report.cells.filter((cell) => cell.disagreement).length,
    });
    status.value = `Troubleshoot: ${result.report.footprints.length} footprints, ${
      result.report.cells.filter((cell) => cell.disagreement).length
    } gray/RGB disagreements in ${result.elapsedMs} ms.`;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "Diagnostics failed";
  }
}

async function startTroubleshoot() {
  tool.value = "missed-item";
  corrections.value = [];
  diagnosticTrace.value = [];
  await diagnose(true);
}

async function recaptureDiagnostic() {
  corrections.value = [];
  diagnosticTrace.value = [{ at: new Date().toISOString(), event: "new-diagnostic-evidence" }];
  await diagnose(true);
}

async function exportBundle() {
  const api = runtime();
  if (!api || !diagnostic.value || !bmpPath.value) {
    status.value = "Run Troubleshoot before exporting.";
    return;
  }
  try {
    const saved = await api.exportDiagnostic({
      bmpPath: bmpPath.value,
      screen: toPlain(screen.value),
      profile: toPlain(profile.value),
      report: toPlain(diagnostic.value),
      corrections: toPlain(corrections.value),
      trace: toPlain(diagnosticTrace.value),
    });
    status.value = `Diagnostic bundle exported to ${saved.dir}`;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "Diagnostic export failed";
  }
}

function clearCorrections() {
  corrections.value = [];
  diagnosticTrace.value.push({ at: new Date().toISOString(), event: "corrections-cleared" });
  void diagnose(false);
}
</script>

<template>
  <section class="cal">
    <div class="card">
      <h2>Calibration</h2>
      <p class="lede">
        Draw the stash panel once (same area for 12×12 and 24×24), then bag and search.
        Unique tabs (Maps, gems) sit lower — draw <strong>Maps</strong> around the 12×8 waystone wells only.
        <strong>Juice</strong> shows every Maps and bag cell (dots = click centers) so a miss is visible before the next live run.
        <kbd>Ctrl+Alt+G</kbd> toggles that overlay on the game.
      </p>
      <p class="status">{{ status }}</p>
      <p class="target">
        <template v-if="target">{{ target.process }} · {{ target.window.width }}×{{ target.window.height }}</template>
        <template v-else>Path of Exile 2 window not found</template>
      </p>
      <div class="cal-group">
        <span class="cal-label">Window</span>
        <div class="btn-row">
          <button type="button" @click="findTarget">Find</button>
          <button type="button" class="primary" @click="capture()">Screenshot</button>
          <button type="button" class="primary" @click="showOnGame">Show on game</button>
          <button type="button" :disabled="!overlayUp" @click="hideOnGame">Hide grids</button>
          <button type="button" class="primary" @click="look">Look</button>
          <button type="button" class="primary" @click="startTroubleshoot">Troubleshoot</button>
          <button type="button" class="danger" @click="resetCalibration">Reset</button>
        </div>
      </div>
      <div class="cal-group">
        <span class="cal-label">Draw</span>
        <div class="btn-row">
          <button type="button" :class="{ active: tool === 'juice-grids', saved: Boolean(profile.mapsStashGrid && profile.bagGrid) }" @click="selectTool('juice-grids')">Juice</button>
          <button type="button" :class="{ active: tool === 'stash-grid', saved: stashPanelSaved }" @click="selectTool('stash-grid')">Stash</button>
          <button type="button" :class="{ active: tool === 'maps-grid', saved: profile.mapsStashGrid }" @click="selectTool('maps-grid')">Maps</button>
          <button type="button" :class="{ active: tool === 'bag-grid', saved: profile.bagGrid }" @click="selectTool('bag-grid')">Bag</button>
          <button type="button" :class="{ active: tool === 'ventor-bag-grid', saved: profile.ventorBagGrid }" @click="selectTool('ventor-bag-grid')">Vendor</button>
          <button type="button" :class="{ active: tool === 'stash-search', saved: profile.stashSearch }" @click="selectTool('stash-search')">Search</button>
        </div>
      </div>
      <div class="cal-group">
        <span class="cal-label">Nudge Maps 8px</span>
        <div class="btn-row">
          <button type="button" :disabled="!mapsMark" @click="nudgeMaps(-8, 0)">Left</button>
          <button type="button" :disabled="!mapsMark" @click="nudgeMaps(8, 0)">Right</button>
          <button type="button" :disabled="!mapsMark" @click="nudgeMaps(0, -8)">Up</button>
          <button type="button" :disabled="!mapsMark" @click="nudgeMaps(0, 8)">Down</button>
        </div>
      </div>
      <div class="cal-group">
        <span class="cal-label">Label a captured grid</span>
        <div class="btn-row">
          <button type="button" :class="{ active: tool === 'missed-item' }" @click="tool = 'missed-item'">Missed item</button>
          <button type="button" :class="{ active: tool === 'false-occupied' }" @click="tool = 'false-occupied'">False cell</button>
          <button type="button" :class="{ active: tool === 'wrong-footprint' }" @click="tool = 'wrong-footprint'">Wrong size</button>
        </div>
        <div class="footprint-size">
          <label>Width <input v-model.number="footprintW" type="number" min="1" max="2" /></label>
          <label>Height <input v-model.number="footprintH" type="number" min="1" max="4" /></label>
        </div>
        <div class="btn-row">
          <button type="button" @click="recaptureDiagnostic">New capture</button>
          <button type="button" :disabled="!corrections.length" @click="clearCorrections">Clear labels</button>
          <button type="button" :disabled="!diagnostic" @click="exportBundle">Export bundle</button>
        </div>
      </div>
      <ul class="marks">
        <li><span :class="stashPanelSaved ? 'ok' : 'no'">Stash</span></li>
        <li><span :class="profile.mapsStashGrid ? 'ok' : 'no'">Maps</span></li>
        <li><span :class="profile.bagGrid ? 'ok' : 'no'">Bag</span></li>
        <li><span :class="profile.ventorBagGrid ? 'ok' : 'no'">Vendor</span></li>
        <li><span :class="profile.stashSearch ? 'ok' : 'no'">Search</span></li>
        <li v-if="facts?.stashGridSize">
          Detected {{ facts.stashGridSize.cols === 24 ? "quad 24×24" : "stash 12×12" }}
        </li>
        <li :class="readyDeposit ? 'ok' : 'no'">{{ readyDeposit ? "Ready" : "Not ready" }}</li>
      </ul>
      <p v-if="stashMarksDiverge" class="hint">
        Stash and quad marks differ. Draw the stash panel once — normal and quad tabs share that rectangle.
      </p>
      <p v-if="needsGridResnap" class="hint">Redraw a grid on a new screenshot if Look cannot tell it from the hideout.</p>
      <p v-if="!profile.stashSearch" class="hint">Class-filtered fills are blocked until Search is marked.</p>
      <p v-if="!profile.mapsStashGrid" class="hint">Juice T15 needs a Maps 12×8 mark around the waystone wells, not the T1–T16 strip.</p>
      <p class="hint">Lattices are outlines only so the screenshot shows through. Click Maps, then drag a new box around the 12×8 wells if the size is still off.</p>
      <p v-if="diagnostic" class="look">
        {{ diagnostic.footprints.length }} footprints · {{ disagreementCount }} disagreements ·
        {{ corrections.length }} operator labels
      </p>
      <p v-if="facts" class="look">
        {{ facts.reason }} · stash {{ facts.stashPanelOpen }} · bag {{ facts.inventoryPanelOpen }} ·
        vendor {{ facts.vendorPanelOpen }} · {{ facts.occupiedBag.length }} items
        <span v-if="elapsedMs !== null"> · {{ elapsedMs }} ms</span>
      </p>
    </div>
    <div class="card stage-card">
      <div
        class="stage"
        @mousedown.prevent="onDown"
        @mousemove="onMove"
        @mouseup="onUp"
        @mouseleave="onUp"
      >
        <img v-if="preview" ref="img" :src="preview" alt="Last Path of Exile capture" draggable="false" />
        <p v-else class="placeholder">Capture to mark stash and bag grids on the real screen.</p>
        <template v-if="!hideStashMarks">
          <div v-if="sharedStashBox" class="box grid lattice" :style="latticeBoxStyle({ ...sharedStashBox, cols: 12, rows: 12 })">stash panel</div>
          <template v-else>
            <div v-if="profile.stashGrid" class="box grid lattice" :style="latticeBoxStyle(profile.stashGrid)">stash 12×12</div>
            <div v-if="profile.quadStashGrid" class="box grid lattice" :style="latticeBoxStyle(profile.quadStashGrid)">quad 24×24</div>
          </template>
          <div v-if="profile.ventorBagGrid" class="box grid lattice" :style="latticeBoxStyle(profile.ventorBagGrid)">vendor</div>
          <div v-if="profile.stashSearch" class="box search" :style="boxStyle(profile.stashSearch)">search</div>
        </template>
        <div v-if="showBagMark && profile.bagGrid" class="box grid lattice bag" :style="latticeBoxStyle(profile.bagGrid)">
          bag {{ profile.bagGrid.cols }}×{{ profile.bagGrid.rows }}
          <span
            v-for="dot in gridClickCenters(profile.bagGrid)"
            :key="`bag-${dot.row}-${dot.col}`"
            class="grid-dot bag"
            :style="dotStyle(profile.bagGrid, dot)"
            :title="`bag r${dot.row}c${dot.col}`"
          />
        </div>
        <div v-if="showMapsMark && mapsMark" class="box grid lattice maps" :style="latticeBoxStyle(mapsMark)">
          maps {{ mapsMark.cols }}×{{ mapsMark.rows }}
          <span
            v-for="dot in gridClickCenters(mapsMark)"
            :key="`maps-${dot.row}-${dot.col}`"
            class="grid-dot maps"
            :style="dotStyle(mapsMark, dot)"
            :title="`maps r${dot.row}c${dot.col}`"
          />
        </div>
        <template v-if="diagnostic && !mapsSolo">
          <div
            v-for="cell in diagnostic.cells"
            :key="`${cell.grid}-${cell.row}-${cell.col}`"
            class="diag-cell"
            :class="{
              occupied: cell.grayOccupied,
              disagreement: cell.disagreement,
              corrected: cell.correction,
            }"
            :style="boxStyle(cell.box)"
            :title="`${cell.grid} ${cell.row},${cell.col} gray=${cell.grayOccupied} rgb=${cell.rgbOccupied ?? 'n/a'}`"
          />
          <div
            v-for="item in diagnostic.footprints"
            :key="`item-${item.grid}-${item.id}`"
            class="diag-footprint"
            :class="item.grid"
            :style="boxStyle(item.box)"
          >
            {{ item.w }}×{{ item.h }}
          </div>
          <div
            v-for="anchor in diagnostic.clickAnchors"
            :key="`anchor-${anchor.grid}-${anchor.itemId}`"
            class="click-anchor"
            :style="pointStyle(anchor)"
            :title="`click ${anchor.grid} ${anchor.itemId}`"
          />
        </template>
        <div v-if="draft" class="box draft" :style="boxStyle(draft)" />
      </div>
    </div>
  </section>
</template>
