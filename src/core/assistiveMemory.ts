import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StashItem } from "./bagPack.js";
import type { UiFacts } from "./uiPerception.js";

export interface ReturnTarget {
  key: string;
  x: number;
  y: number;
  row: number;
  col: number;
  w: number;
  h: number;
}

export interface BlockedStashCell {
  key: string;
  reason: string;
  samples: number;
  updatedAt: string;
}

export interface WithdrawnCell {
  key: string;
  x: number;
  y: number;
  row: number;
  col: number;
  w: number;
  h: number;
}

export interface StashClickLesson {
  dx: number;
  dy: number;
  planned: { x: number; y: number };
  actual: { x: number; y: number };
  label?: { x: number; y: number; w: number; h: number };
  updatedAt: string;
}

export interface AssistiveScenarioMemory {
  key: string;
  stashTab: "normal" | "quad";
  query: string;
  confirmedAnchors: string[];
  blockedStash: BlockedStashCell[];
  updatedAt: string;
}

export interface AssistiveMemory {
  version: 2;
  scenarios: AssistiveScenarioMemory[];
  lastWithdrawn: WithdrawnCell[];
  lastWithdrawnScenario?: string;
  stashClick?: StashClickLesson;
  updatedAt: string;
}

export function assistiveMemoryPath(root = process.cwd()): string {
  return path.join(root, "fixtures", "benchmarks", "assistive-memory.json");
}

export function emptyMemory(): AssistiveMemory {
  return { version: 2, scenarios: [], lastWithdrawn: [], updatedAt: new Date(0).toISOString() };
}

export function loadAssistiveMemory(root = process.cwd()): AssistiveMemory {
  const file = assistiveMemoryPath(root);
  if (!existsSync(file)) return emptyMemory();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      scenarios?: AssistiveScenarioMemory[];
      blockedStash?: BlockedStashCell[];
      lastWithdrawn?: WithdrawnCell[];
      lastWithdrawnScenario?: string;
      stashClick?: StashClickLesson;
      updatedAt?: string;
    };
    if (parsed.version !== 1 && parsed.version !== 2) return emptyMemory();
    return {
      version: 2,
      // Version 1 used one global exclusion list. It is intentionally not
      // migrated because it cannot be tied to a stash tab or query safely.
      scenarios:
        parsed.version === 2 && Array.isArray(parsed.scenarios)
          ? parsed.scenarios
              .filter((scenario) => scenario.key)
              .map((scenario) => ({
                ...scenario,
                confirmedAnchors: Array.isArray(scenario.confirmedAnchors)
                  ? [...new Set(scenario.confirmedAnchors.filter(Boolean))]
                  : [],
                blockedStash: Array.isArray(scenario.blockedStash)
                  ? scenario.blockedStash.filter((cell) => cell.key)
                  : [],
              }))
          : [],
      lastWithdrawn: Array.isArray(parsed.lastWithdrawn) ? parsed.lastWithdrawn.filter((cell) => cell.key) : [],
      lastWithdrawnScenario:
        parsed.version === 2 && typeof parsed.lastWithdrawnScenario === "string"
          ? parsed.lastWithdrawnScenario
          : undefined,
      stashClick: parsed.stashClick && Number.isFinite(parsed.stashClick.dx) ? parsed.stashClick : undefined,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return emptyMemory();
  }
}

export function saveAssistiveMemory(root: string, memory: AssistiveMemory): string {
  const file = assistiveMemoryPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...memory, version: 2 as const, updatedAt: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

export function stashCellKey(item: Pick<StashItem, "grab"> | { row: number; col: number }): string {
  if ("grab" in item) return `${item.grab.row},${item.grab.col}`;
  return `${item.row},${item.col}`;
}

export function scenarioMemoryKey(
  stashTab: "normal" | "quad",
  query = "",
): string {
  return `${stashTab}::${query.trim().toLowerCase() || "*"}`;
}

function scenarioFor(memory: AssistiveMemory, scenarioKey: string): AssistiveScenarioMemory | undefined {
  return memory.scenarios.find((scenario) => scenario.key === scenarioKey);
}

function scenarioIdentity(scenarioKey: string): Pick<AssistiveScenarioMemory, "stashTab" | "query"> {
  const [tab, ...query] = scenarioKey.split("::");
  return {
    stashTab: tab === "quad" ? "quad" : "normal",
    query: query.join("::") || "*",
  };
}

function replaceScenario(memory: AssistiveMemory, scenario: AssistiveScenarioMemory): AssistiveMemory {
  return {
    ...memory,
    scenarios: [...memory.scenarios.filter((entry) => entry.key !== scenario.key), scenario],
    updatedAt: scenario.updatedAt,
  };
}

export function scenarioExclusions(
  memory: AssistiveMemory,
  scenarioKey: string,
  uniqueAcrossCycles: boolean,
): Set<string> {
  if (!uniqueAcrossCycles) return new Set();
  return new Set(scenarioFor(memory, scenarioKey)?.confirmedAnchors ?? []);
}

/** @deprecated Use scenarioExclusions with an explicit scenario key. */
export function applyBlockedCells(
  memory: AssistiveMemory,
  exclude: Set<string>,
  scenarioKey?: string,
): Set<string> {
  if (!scenarioKey) return exclude;
  for (const key of scenarioFor(memory, scenarioKey)?.confirmedAnchors ?? []) exclude.add(key);
  return exclude;
}

export function clearScenarioMemory(memory: AssistiveMemory, scenarioKey?: string): AssistiveMemory {
  const now = new Date().toISOString();
  const clearWithdrawn = !scenarioKey || memory.lastWithdrawnScenario === scenarioKey;
  return {
    ...memory,
    scenarios: scenarioKey
      ? memory.scenarios.filter((scenario) => scenario.key !== scenarioKey)
      : [],
    lastWithdrawn: clearWithdrawn ? [] : memory.lastWithdrawn,
    lastWithdrawnScenario: clearWithdrawn ? undefined : memory.lastWithdrawnScenario,
    updatedAt: now,
  };
}

export function assistiveMemoryStatus(memory: AssistiveMemory, scenarioKey: string) {
  const scenario = scenarioFor(memory, scenarioKey);
  return {
    scenarioKey,
    confirmed: scenario?.confirmedAnchors.length ?? 0,
    blockedReturns: scenario?.blockedStash.length ?? 0,
    lastWithdrawn: memory.lastWithdrawnScenario === scenarioKey ? memory.lastWithdrawn.length : 0,
    updatedAt: scenario?.updatedAt ?? memory.updatedAt,
  };
}

export function withdrawnCells(items: StashItem[]): WithdrawnCell[] {
  return items.map((item) => ({
    key: stashCellKey(item),
    x: item.grab.x,
    y: item.grab.y,
    row: item.grab.row,
    col: item.grab.col,
    w: item.w,
    h: item.h,
  }));
}

export function learnFromFill(
  memory: AssistiveMemory,
  withdrawn: StashItem[],
  scenarioKey?: string,
  uniqueAcrossCycles = false,
): AssistiveMemory {
  const now = new Date().toISOString();
  let next: AssistiveMemory = {
    ...memory,
    lastWithdrawn: withdrawnCells(withdrawn),
    lastWithdrawnScenario: scenarioKey,
    updatedAt: now,
  };
  if (scenarioKey && uniqueAcrossCycles && withdrawn.length > 0) {
    const current = scenarioFor(memory, scenarioKey);
    const identity = scenarioIdentity(scenarioKey);
    next = replaceScenario(next, {
      key: scenarioKey,
      ...identity,
      confirmedAnchors: [
        ...new Set([...(current?.confirmedAnchors ?? []), ...withdrawn.map(stashCellKey)]),
      ],
      blockedStash: current?.blockedStash ?? [],
      updatedAt: now,
    });
  }
  return next;
}

export function blockStashCell(
  memory: AssistiveMemory,
  key: string,
  reason: string,
  scenarioKey: string,
): AssistiveMemory {
  const now = new Date().toISOString();
  const current = scenarioFor(memory, scenarioKey);
  const blockedStash = (current?.blockedStash ?? []).filter((cell) => cell.key !== key);
  const prev = current?.blockedStash.find((cell) => cell.key === key);
  blockedStash.push({
    key,
    reason,
    samples: (prev?.samples ?? 0) + 1,
    updatedAt: now,
  });
  return replaceScenario(memory, {
    key: scenarioKey,
    ...scenarioIdentity(scenarioKey),
    confirmedAnchors: current?.confirmedAnchors ?? [],
    blockedStash,
    updatedAt: now,
  });
}

export function newlyOccupiedKeys(before: UiFacts, after: UiFacts, targets: ReturnTarget[]): string[] {
  const beforeOcc = new Set(before.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  const afterOcc = new Set(after.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  return targets.filter((target) => !beforeOcc.has(target.key) && afterOcc.has(target.key)).map((target) => target.key);
}

export function learnFromDeposit(
  memory: AssistiveMemory,
  _before: UiFacts,
  after: UiFacts,
  _targets: ReturnTarget[],
  returnedKeys: string[] = [],
  scenarioKey?: string,
  uniqueAcrossCycles = false,
): AssistiveMemory {
  const now = new Date().toISOString();
  if (after.bagEmpty || after.occupiedBag.length === 0) {
    if (!scenarioKey) {
      return { ...memory, lastWithdrawn: [], lastWithdrawnScenario: undefined, updatedAt: now };
    }
    if (!uniqueAcrossCycles) {
      const cleared = clearScenarioMemory(memory, scenarioKey);
      return { ...cleared, lastWithdrawn: [], lastWithdrawnScenario: undefined, updatedAt: now };
    }
    const current = scenarioFor(memory, scenarioKey);
    if (!current) {
      return { ...memory, lastWithdrawn: [], lastWithdrawnScenario: undefined, updatedAt: now };
    }
    return replaceScenario(
      { ...memory, lastWithdrawn: [], lastWithdrawnScenario: undefined },
      { ...current, blockedStash: [], updatedAt: now },
    );
  }
  const afterOcc = new Set(after.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  let next = memory;
  for (const key of new Set(returnedKeys)) {
    if (!afterOcc.has(key) && scenarioKey) {
      next = blockStashCell(next, key, "deposit-rejected", scenarioKey);
    }
  }
  return next;
}

export function returnTargetFits(
  facts: UiFacts,
  target: ReturnTarget,
  item?: Pick<StashItem, "w" | "h">,
): boolean {
  if (item && (item.w !== target.w || item.h !== target.h)) return false;
  const cols = facts.stashGridSize?.cols ?? 12;
  const rows = facts.stashGridSize?.rows ?? 12;
  if (
    target.w < 1 ||
    target.h < 1 ||
    target.row < 0 ||
    target.col < 0 ||
    target.row + target.h > rows ||
    target.col + target.w > cols
  ) {
    return false;
  }
  const occ = new Set(facts.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  for (let row = target.row; row < target.row + target.h; row += 1) {
    for (let col = target.col; col < target.col + target.w; col += 1) {
      if (occ.has(`${row},${col}`)) return false;
    }
  }
  return true;
}

export function nextEmptyReturn(
  facts: UiFacts,
  targets: ReturnTarget[],
  used: Set<string>,
  item?: Pick<StashItem, "w" | "h">,
): ReturnTarget | undefined {
  return targets.find(
    (target) => !used.has(target.key) && returnTargetFits(facts, target, item),
  );
}

export function planEmptyStashPlacement(
  facts: UiFacts,
  item: Pick<StashItem, "w" | "h">,
  used: Set<string> = new Set(),
): ReturnTarget | undefined {
  const region = facts.stashRegion;
  const cols = facts.stashGridSize?.cols;
  const rows = facts.stashGridSize?.rows;
  if (!region || !cols || !rows || item.w < 1 || item.h < 1) return undefined;
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  for (let row = 0; row <= rows - item.h; row += 1) {
    for (let col = 0; col <= cols - item.w; col += 1) {
      const key = `${row},${col}`;
      if (used.has(key)) continue;
      const target: ReturnTarget = {
        key,
        row,
        col,
        w: item.w,
        h: item.h,
        x: Math.round(region.x + (col + 0.5) * cellW),
        y: Math.round(region.y + (row + 0.5) * cellH),
      };
      if (returnTargetFits(facts, target, item)) return target;
    }
  }
  return undefined;
}

export function returnTargetsFromKnown(
  facts: UiFacts,
  withdrawn: StashItem[],
  memory: AssistiveMemory,
  usedKeys: Iterable<string>,
  scenarioKey?: string,
): ReturnTarget[] {
  const blocked = new Set(
    scenarioKey
      ? scenarioFor(memory, scenarioKey)?.blockedStash.map((cell) => cell.key) ?? []
      : [],
  );
  const seen = new Set<string>();
  const out: ReturnTarget[] = [];
  function add(target: ReturnTarget) {
    if (
      seen.has(target.key) ||
      blocked.has(target.key) ||
      !returnTargetFits(facts, target)
    ) {
      return;
    }
    seen.add(target.key);
    out.push(target);
  }
  for (const item of withdrawn) {
    add({
      key: stashCellKey(item),
      x: item.grab.x,
      y: item.grab.y,
      row: item.grab.row,
      col: item.grab.col,
      w: item.w,
      h: item.h,
    });
  }
  if (!scenarioKey || memory.lastWithdrawnScenario === scenarioKey) {
    for (const cell of memory.lastWithdrawn) {
      add({
        key: cell.key,
        x: cell.x,
        y: cell.y,
        row: cell.row,
        col: cell.col,
        w: cell.w,
        h: cell.h,
      });
    }
  }
  void usedKeys;
  return out.sort((a, b) => emptyFootprintScore(facts, b) - emptyFootprintScore(facts, a));
}

export function applyStashClickOffset(
  point: { x: number; y: number },
  lesson?: StashClickLesson,
): { x: number; y: number } {
  if (!lesson) return point;
  return { x: Math.round(point.x + lesson.dx), y: Math.round(point.y + lesson.dy) };
}

export function stashClickLessonTooFar(planned: { x: number; y: number }, actual: { x: number; y: number }): boolean {
  return Math.abs(actual.x - planned.x) > 80 || Math.abs(actual.y - planned.y) > 80;
}

export function learnStashClick(
  memory: AssistiveMemory,
  planned: { x: number; y: number },
  actual: { x: number; y: number },
  label?: { x: number; y: number; w: number; h: number },
): AssistiveMemory {
  if (stashClickLessonTooFar(planned, actual)) return memory;
  const now = new Date().toISOString();
  return {
    ...memory,
    stashClick: {
      dx: actual.x - planned.x,
      dy: actual.y - planned.y,
      planned,
      actual,
      label,
      updatedAt: now,
    },
    updatedAt: now,
  };
}

export function emptyFootprintScore(facts: UiFacts, target: ReturnTarget): number {
  return returnTargetFits(facts, target) ? target.w * target.h : 0;
}
