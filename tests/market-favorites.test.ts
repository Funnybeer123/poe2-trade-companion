import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FAVORITES,
  MAX_FOLDERS,
  emptyFavorites,
  favoritesTree,
  moveFavorite,
  moveFolder,
  newFavoriteId,
  newFolderId,
  normalizeMarketFavorites,
  parseMarketFavorites,
  removeFavorite,
  removeFolder,
  saveFavorite,
  saveFolder,
  serializeMarketFavorites,
  type MarketFavoritesFile,
} from "../src/core/marketFavorites.js";
import type { MarketDraft } from "../src/core/marketQuery.js";

const NOW = "2026-09-10T12:00:00.000Z";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "market", name), "utf8"));
}

const ring: MarketDraft = { kind: "search", query: { stats: [], type: "Ruby Ring" } };
const bulk: MarketDraft = { kind: "exchange", query: { have: ["divine"], want: ["exalted"] } };

describe("normalizeMarketFavorites", () => {
  it("reads the v1 fixture unchanged", () => {
    const { value, issues } = normalizeMarketFavorites(fixture("favorites-v1.json"));
    expect(issues).toEqual([]);
    expect(value.folders.map((folder) => folder.id)).toEqual(["fld_rings", "fld_bulk"]);
    expect(value.favorites).toHaveLength(3);
    expect(value.favorites.find((favorite) => favorite.id === "fav_div_ex")?.draft.kind).toBe("exchange");
  });

  it("repairs the junk fixture instead of throwing", () => {
    const { value, issues } = normalizeMarketFavorites(fixture("favorites-junk.json"));
    expect(value.schemaVersion).toBe(1);
    expect(value.folders).toHaveLength(1);
    expect(value.folders[0]).toMatchObject({ id: "fld_ok", name: "Keep me", colour: "grey", order: 0 });
    expect(issues.some((issue) => issue.includes("duplicate folder id"))).toBe(true);
    const orphan = value.favorites.find((favorite) => favorite.id === "fav_orphan");
    expect(orphan?.folderId).toBeNull();
    expect(issues.some((issue) => issue.includes("missing folder"))).toBe(true);
    expect(value.favorites.some((favorite) => favorite.name === "No query")).toBe(false);
    expect(issues.some((issue) => issue.includes("no usable query"))).toBe(true);
    expect(value.favorites.filter((favorite) => favorite.id === "fav_orphan")).toHaveLength(1);
    const junkStats = value.favorites.find((favorite) => favorite.id === "fav_bad_stats");
    if (junkStats?.draft.kind !== "search") throw new Error("expected a search draft");
    expect(junkStats.draft.query.stats).toHaveLength(1);
    expect(junkStats.draft.query.misc?.ilvl).toEqual({ min: 1, max: 100 });
  });

  it("applies the caps", () => {
    const many = {
      folders: Array.from({ length: MAX_FOLDERS + 5 }, (_row, index) => ({ id: `f${index}`, name: `F${index}` })),
      favorites: Array.from({ length: MAX_FAVORITES + 5 }, (_row, index) => ({
        id: `v${index}`,
        name: `V${index}`,
        draft: ring,
      })),
    };
    const { value, issues } = normalizeMarketFavorites(many);
    expect(value.folders).toHaveLength(MAX_FOLDERS);
    expect(value.favorites).toHaveLength(MAX_FAVORITES);
    expect(issues.some((issue) => issue.includes("folders"))).toBe(true);
    expect(issues.some((issue) => issue.includes("favourites"))).toBe(true);
  });

  it("falls back to an empty file for junk text", () => {
    expect(parseMarketFavorites(undefined)).toEqual(emptyFavorites());
    expect(parseMarketFavorites("{{{")).toEqual(emptyFavorites());
  });

  it("round-trips through serialize/parse", () => {
    const { value } = normalizeMarketFavorites(fixture("favorites-v1.json"));
    expect(parseMarketFavorites(serializeMarketFavorites(value))).toEqual(value);
  });
});

describe("ids", () => {
  it("are prefixed and unique enough", () => {
    expect(newFavoriteId()).toMatch(/^fav_[a-z0-9]+_[a-z0-9]+$/);
    expect(newFolderId()).toMatch(/^fld_[a-z0-9]+_[a-z0-9]+$/);
    expect(newFavoriteId()).not.toBe(newFavoriteId());
  });
});

describe("tree operations", () => {
  function seed(): MarketFavoritesFile {
    let file = emptyFavorites();
    const folder = saveFolder(file, { id: "fld_a", name: "Rings" });
    file = folder.file;
    file = saveFavorite(file, { id: "fav_1", name: "One", draft: ring, folderId: "fld_a" }, NOW).file;
    file = saveFavorite(file, { id: "fav_2", name: "Two", draft: ring, folderId: "fld_a" }, NOW).file;
    file = saveFavorite(file, { id: "fav_3", name: "Three", draft: bulk }, NOW).file;
    return file;
  }

  it("saves a new favourite with a derived colour", () => {
    const { file, favorite } = saveFavorite(emptyFavorites(), { name: "Bulk", draft: bulk }, NOW);
    expect(favorite.colour).toBe("teal");
    expect(favorite.createdAt).toBe(NOW);
    expect(file.favorites).toHaveLength(1);
  });

  it("updates in place without reshuffling", () => {
    const file = seed();
    const updated = saveFavorite(file, { id: "fav_1", name: "Renamed", draft: bulk }, "2026-09-11T00:00:00.000Z");
    expect(updated.file.favorites.map((favorite) => favorite.id)).toEqual(["fav_1", "fav_2", "fav_3"]);
    expect(updated.favorite.name).toBe("Renamed");
    expect(updated.favorite.draft.kind).toBe("exchange");
    expect(updated.favorite.updatedAt).toBe("2026-09-11T00:00:00.000Z");
    expect(updated.favorite.createdAt).toBe(NOW);
  });

  it("refuses a new favourite past the cap", () => {
    let file = emptyFavorites();
    for (let index = 0; index < MAX_FAVORITES; index += 1) {
      file = saveFavorite(file, { id: `fav_${index}`, name: `F${index}`, draft: ring }, NOW).file;
    }
    const refused = saveFavorite(file, { name: "one too many", draft: ring }, NOW);
    expect(refused.refused).toBe("favorite-limit");
    expect(refused.file.favorites).toHaveLength(MAX_FAVORITES);
  });

  it("moves a favourite between folders at an index", () => {
    const file = moveFavorite(seed(), { id: "fav_3", folderId: "fld_a", index: 0 });
    const group = favoritesTree(file).find((entry) => entry.folder?.id === "fld_a");
    expect(group?.favorites.map((favorite) => favorite.id)).toEqual(["fav_3", "fav_1", "fav_2"]);
    expect(favoritesTree(file)[0]!.favorites).toEqual([]);
  });

  it("clamps an out-of-range move index", () => {
    const file = moveFavorite(seed(), { id: "fav_1", folderId: "fld_a", index: 99 });
    const group = favoritesTree(file).find((entry) => entry.folder?.id === "fld_a");
    expect(group?.favorites.map((favorite) => favorite.id)).toEqual(["fav_2", "fav_1"]);
  });

  it("reparents a removed folder's favourites to the root", () => {
    const file = removeFolder(seed(), "fld_a");
    expect(file.folders).toEqual([]);
    expect(file.favorites.every((favorite) => favorite.folderId === null)).toBe(true);
    expect(favoritesTree(file)[0]!.favorites.map((favorite) => favorite.id)).toEqual(["fav_1", "fav_2", "fav_3"]);
  });

  it("removes a favourite and renumbers", () => {
    const file = removeFavorite(seed(), "fav_1");
    expect(file.favorites.map((favorite) => favorite.id)).toEqual(["fav_2", "fav_3"]);
    expect(file.favorites.find((favorite) => favorite.id === "fav_2")?.order).toBe(0);
  });

  it("reorders folders", () => {
    let file = seed();
    file = saveFolder(file, { id: "fld_b", name: "Bulk" }).file;
    file = moveFolder(file, { id: "fld_b", index: 0 });
    expect(file.folders.map((folder) => folder.id)).toEqual(["fld_b", "fld_a"]);
    expect(favoritesTree(file)[1]?.folder?.id).toBe("fld_b");
  });

  it("refuses a new folder past the cap", () => {
    let file = emptyFavorites();
    for (let index = 0; index < MAX_FOLDERS; index += 1) {
      file = saveFolder(file, { id: `fld_${index}`, name: `F${index}` }).file;
    }
    expect(saveFolder(file, { name: "one too many" }).refused).toBe("folder-limit");
  });

  it("puts the root group first in the tree", () => {
    const tree = favoritesTree(seed());
    expect(tree[0]!.folder).toBeNull();
    expect(tree[0]!.favorites.map((favorite) => favorite.id)).toEqual(["fav_3"]);
    expect(tree[1]!.folder?.name).toBe("Rings");
  });
});
