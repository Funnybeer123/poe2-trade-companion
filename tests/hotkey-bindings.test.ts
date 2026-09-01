import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionForKey,
  defaultHotkeyBindings,
  HOTKEY_ACTIONS,
  normalizeHotkeyBindings,
  RESERVED_CONTROL_KEYS,
} from "../src/shared/hotkeyActions.js";
import { loadHotkeyBindings, saveHotkeyBindings } from "../src/core/hotkeyBindings.js";

describe("hotkey bindings", () => {
  it("defaults map every catalog action to its documented key", () => {
    const bindings = defaultHotkeyBindings();
    expect(bindings["stash"]).toBe(1);
    expect(bindings["identify"]).toBe(6);
    expect(bindings["vendor-cycle"]).toBe(7);
    expect(Object.keys(bindings)).toHaveLength(HOTKEY_ACTIONS.length);
  });

  it("refuses reserved control keys and out-of-range values", () => {
    for (const reserved of RESERVED_CONTROL_KEYS) {
      const { bindings, issues } = normalizeHotkeyBindings({ stash: reserved.key });
      expect(bindings["stash"]).toBe(1);
      expect(issues.length).toBeGreaterThan(0);
    }
    const bad = normalizeHotkeyBindings({ stash: 12 });
    expect(bad.bindings["stash"]).toBe(1);
    expect(bad.issues[0]).toMatch(/Num1-Num9/);
  });

  it("resolves duplicate keys to the earlier catalog action", () => {
    const { bindings, issues } = normalizeHotkeyBindings({ stash: 3, fill: 3 });
    expect(bindings["stash"]).toBe(3);
    expect(bindings["fill"]).toBeNull();
    expect(issues.some((issue) => issue.includes("bound twice"))).toBe(true);
  });

  it("allows unbinding and dispatches by key", () => {
    const { bindings } = normalizeHotkeyBindings({ sort: null, identify: 2 });
    expect(bindings["sort"]).toBeNull();
    expect(actionForKey(bindings, 2)).toBe("identify");
    expect(actionForKey(bindings, 5)).toBeUndefined();
  });

  it("round-trips through the file the daemon reads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hotkeys-"));
    try {
      expect(loadHotkeyBindings(root).source).toBe("defaults");
      const saved = saveHotkeyBindings(root, { identify: 4, vendor: null });
      expect(saved.bindings["identify"]).toBe(4);
      const loaded = loadHotkeyBindings(root);
      expect(loaded.source).toBe("file");
      expect(loaded.bindings["identify"]).toBe(4);
      expect(loaded.bindings["vendor"]).toBeNull();
      expect(loaded.bindings["stash"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
