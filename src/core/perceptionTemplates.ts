import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { crop, grayFromJson, type GrayImage } from "./grayImage.js";
import type { PerceptionTemplates } from "./uiPerception.js";

interface GrayJson {
  width: number;
  height: number;
  pixels: number[];
}

export function loadPerceptionTemplates(templateDir: string): {
  templates: PerceptionTemplates;
  loaded: string[];
  missing: string[];
} {
  const loaded: string[] = [];
  const templates: PerceptionTemplates = {};

  const sceneOpen = readGray(templateDir, ["scene-open.json", "stash-open.json"]);
  if (sceneOpen) {
    templates.sceneOpen = sceneOpen.image;
    loaded.push(sceneOpen.name);
    if (!readGray(templateDir, ["stash-panel.json"])) {
      templates.stashPanel = crop(sceneOpen.image, 6, 14, 46, 64);
    }
    if (!readGray(templateDir, ["inventory-panel.json"])) {
      templates.inventoryPanel = crop(sceneOpen.image, 102, 30, 50, 50);
    }
  }

  const stashPanel = readGray(templateDir, ["stash-panel.json"]);
  if (stashPanel) {
    templates.stashPanel = stashPanel.image;
    loaded.push(stashPanel.name);
  }
  const inventoryPanel = readGray(templateDir, ["inventory-panel.json"]);
  if (inventoryPanel) {
    templates.inventoryPanel = inventoryPanel.image;
    loaded.push(inventoryPanel.name);
  }
  const sceneClosed = readGray(templateDir, ["scene-closed.json", "stash-closed.json"]);
  if (sceneClosed) {
    templates.sceneClosed = sceneClosed.image;
    loaded.push(sceneClosed.name);
  }
  const chest = readGray(templateDir, ["chest.json"]);
  if (chest) {
    templates.chest = chest.image;
    loaded.push(chest.name);
  } else if (templates.sceneClosed) {
    templates.chest = crop(templates.sceneClosed, 70, 45, 24, 18);
  }
  const empty = readGray(templateDir, ["empty-cell.json", "empty-bag.json"]);
  if (empty) {
    templates.emptyCell = asEmptyCell(empty.image);
    loaded.push(empty.name);
  }
  const options = readGray(templateDir, ["options.json"]);
  if (options) {
    templates.options = options.image;
    loaded.push(options.name);
  }

  const wanted = ["stash-open.json or scene-open.json", "stash-closed.json", "empty-cell.json"];
  const missing = wanted.filter((name) => {
    if (name.startsWith("stash-open")) return !templates.sceneOpen && !templates.stashPanel;
    if (name.startsWith("stash-closed")) return !templates.sceneClosed && !templates.chest;
    return !templates.emptyCell;
  });

  return { templates, loaded, missing };
}

export function hasHudCalibration(templates: PerceptionTemplates): boolean {
  return Boolean(templates.sceneOpen || (templates.stashPanel && templates.inventoryPanel));
}

function asEmptyCell(image: GrayImage): GrayImage {
  if (image.width <= 40 && image.height <= 40) return image;
  return crop(image, image.width * 0.7, image.height * 0.42, Math.max(8, image.width * 0.045), Math.max(8, image.height * 0.08));
}

function readGray(dir: string, names: string[]): { name: string; image: GrayImage } | undefined {
  for (const name of names) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as GrayJson;
    if (!parsed.width || !parsed.height || !Array.isArray(parsed.pixels)) continue;
    return { name, image: grayFromJson(parsed) };
  }
  return undefined;
}
