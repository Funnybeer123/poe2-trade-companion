/**
 * Numpad hotkey actions: the catalog, the reserved control keys, and the
 * pure binding-normalization rules. Pure module (no fs) so the renderer,
 * the main process, and the action daemon all share one source of truth;
 * the file persistence lives in src/core/hotkeyBindings.ts.
 */

export interface HotkeyActionInfo {
  id: string;
  label: string;
  detail: string;
  /** Where the action makes sense; shown as a chip, not enforced here. */
  context: "hideout" | "map";
  defaultKey: number | null;
}

export const HOTKEY_ACTIONS: readonly HotkeyActionInfo[] = [
  {
    id: "stash",
    label: "Stash",
    detail: "Verify the stash + inventory are open (reopening via the world nameplate), then deposit the whole bag.",
    context: "hideout",
    defaultKey: 1,
  },
  {
    id: "sort",
    label: "Sort",
    detail: "Run the class-routed stash sorter on the bag.",
    context: "hideout",
    defaultKey: 2,
  },
  {
    id: "fill",
    label: "Fill",
    detail: "Withdraw from the selected stash tab into the bag (audited fill flow).",
    context: "hideout",
    defaultKey: 3,
  },
  {
    id: "vendor",
    label: "Vendor",
    detail: "Quick-sell the bag to ZELINA (window opens; the sell click is not wired yet).",
    context: "hideout",
    defaultKey: null,
  },
  {
    id: "identify",
    label: "Identify & drop",
    detail:
      "With the Scroll of Wisdom at bag (0,0): identify all unidentified gear, drop what fails the value-tier rules, compact the bag left.",
    context: "map",
    defaultKey: 6,
  },
  {
    id: "vendor-cycle",
    label: "Vendor cycle",
    detail: "/hideout, sell all identified junk to ZELINA, and return to the same map through its portal.",
    context: "map",
    defaultKey: 7,
  },
  {
    id: "shop",
    label: "Shop",
    detail:
      "Price every bag item for the current league (live feed + trade2 comps), then list each in its price-bucket merchant tab (1Ex, 5Ex, 10Ex, 1D …) via Ange's Manage Shop. Numpad 0 stops.",
    context: "hideout",
    defaultKey: 4,
  },
];

/** In-run control keys — never bindable to actions. */
export const RESERVED_CONTROL_KEYS: ReadonlyArray<{ key: number; label: string }> = [
  { key: 0, label: "Stop the running action instantly" },
  { key: 5, label: "Pause / resume the running action" },
  { key: 8, label: "Step mode: approve the highlighted click" },
  { key: 9, label: "Step mode: mark wrong / teach a correction" },
];

const RESERVED_KEY_SET = new Set(RESERVED_CONTROL_KEYS.map((entry) => entry.key));

/** null = the action is unbound (disabled). */
export type HotkeyBindings = Record<string, number | null>;

export function defaultHotkeyBindings(): HotkeyBindings {
  const bindings: HotkeyBindings = {};
  for (const action of HOTKEY_ACTIONS) bindings[action.id] = action.defaultKey;
  return bindings;
}

export interface BindingsValidation {
  bindings: HotkeyBindings;
  issues: string[];
}

/**
 * Normalize an untrusted bindings object: unknown actions are dropped,
 * reserved/out-of-range keys are refused (the action keeps its default),
 * and a key claimed twice goes to the earlier action in catalog order.
 */
export function normalizeHotkeyBindings(raw: unknown): BindingsValidation {
  const issues: string[] = [];
  const bindings = defaultHotkeyBindings();
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  if (raw !== undefined && !source) issues.push("bindings must be an object of action → key");
  if (source) {
    for (const key of Object.keys(source)) {
      if (!HOTKEY_ACTIONS.some((action) => action.id === key)) {
        issues.push(`unknown action "${key}" ignored`);
      }
    }
    for (const action of HOTKEY_ACTIONS) {
      if (!(action.id in source)) continue;
      const value = source[action.id];
      if (value === null) {
        bindings[action.id] = null;
        continue;
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1 || num > 9) {
        issues.push(`${action.label}: key must be Num1-Num9 or unbound — kept its default`);
        continue;
      }
      if (RESERVED_KEY_SET.has(num)) {
        issues.push(`${action.label}: Num${num} is a reserved control key — kept its default`);
        continue;
      }
      bindings[action.id] = num;
    }
  }
  const seen = new Map<number, string>();
  for (const action of HOTKEY_ACTIONS) {
    const key = bindings[action.id];
    if (key === null || key === undefined) continue;
    const holder = seen.get(key);
    if (holder) {
      issues.push(`Num${key} is bound twice — "${action.label}" was unbound (kept by "${holder}")`);
      bindings[action.id] = null;
      continue;
    }
    seen.set(key, action.label);
  }
  return { bindings, issues };
}

export function actionForKey(bindings: HotkeyBindings, key: number): string | undefined {
  for (const action of HOTKEY_ACTIONS) {
    if (bindings[action.id] === key) return action.id;
  }
  return undefined;
}

/** Keys an action may be bound to (1-9 minus the control keys). */
export const BINDABLE_KEYS: readonly number[] = [1, 2, 3, 4, 6, 7].filter(
  (key) => !RESERVED_KEY_SET.has(key),
);
