// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MarketFavoritesFile } from "../../src/shared/market.js";
import FavoritesExplorer from "../../src/renderer/features/market/components/FavoritesExplorer.vue";

const FILE: MarketFavoritesFile = {
  schemaVersion: 1,
  folders: [{ id: "fld_rings", name: "Rings", colour: "gold", order: 0, expanded: true }],
  favorites: [
    {
      id: "fav_1",
      folderId: "fld_rings",
      name: "Life ring",
      colour: "gold",
      order: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      draft: { kind: "search", query: { stats: [], type: "Ruby Ring" } },
    },
    {
      id: "fav_2",
      folderId: "fld_rings",
      name: "Cold ring",
      colour: "blue",
      order: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      draft: { kind: "search", query: { stats: [], type: "Sapphire Ring" } },
    },
    {
      id: "fav_3",
      folderId: null,
      name: "divine → exalted",
      colour: "teal",
      order: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      draft: { kind: "exchange", query: { have: ["divine"], want: ["exalted"] } },
    },
  ],
};

function explorer(file: MarketFavoritesFile = FILE) {
  return mount(FavoritesExplorer, { props: { favorites: file } });
}

describe("FavoritesExplorer", () => {
  it("renders the root group and each folder", () => {
    const wrapper = explorer();
    expect(wrapper.text()).toContain("Not in a folder");
    expect(wrapper.text()).toContain("Rings");
    expect(wrapper.text()).toContain("Life ring");
    expect(wrapper.text()).toContain("divine → exalted");
  });

  it("shows an empty state with no favourites", () => {
    const wrapper = explorer({ schemaVersion: 1, folders: [], favorites: [] });
    expect(wrapper.text()).toContain("No favourites yet");
  });

  it("opens a favourite", async () => {
    const wrapper = explorer();
    await wrapper.find("[data-favorite-id='fav_1'] .favorite-name").trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual(["fav_1"]);
  });

  it("moves a favourite by drag and drop", async () => {
    const wrapper = explorer();
    await wrapper.find("[data-favorite-id='fav_2']").trigger("dragstart");
    await wrapper.find("[data-favorite-id='fav_1']").trigger("drop");
    expect(wrapper.emitted("move")?.[0]?.[0]).toEqual({ id: "fav_2", folderId: "fld_rings", index: 0 });
  });

  it("offers a keyboard path for the same move", async () => {
    const wrapper = explorer();
    const row = wrapper.find("[data-favorite-id='fav_2']");
    await row.findAll("button").find((button) => button.text() === "↑")!.trigger("click");
    expect(wrapper.emitted("move")?.[0]?.[0]).toEqual({ id: "fav_2", folderId: "fld_rings", index: 0 });
  });

  it("moves a favourite to another folder from the select", async () => {
    const wrapper = explorer();
    const select = wrapper.find("[data-favorite-id='fav_1'] select");
    await select.setValue("");
    expect(wrapper.emitted("move")?.at(-1)?.[0]).toEqual({ id: "fav_1", folderId: null, index: 0 });
  });

  it("renames on Enter", async () => {
    const wrapper = explorer();
    await wrapper.find("[data-favorite-id='fav_1'] button[aria-label='Rename Life ring']").trigger("click");
    const input = wrapper.find("[data-favorite-id='fav_1'] input.favorite-rename");
    await input.setValue("Better name");
    await input.trigger("keydown.enter");
    expect(wrapper.emitted("rename")?.[0]).toEqual(["fav_1", "Better name"]);
  });

  it("deletes only on the second click", async () => {
    const wrapper = explorer();
    const button = wrapper.find("[data-favorite-id='fav_1'] button.danger");
    await button.trigger("click");
    expect(wrapper.emitted("remove")).toBeUndefined();
    expect(button.text()).toBe("Sure?");
    await button.trigger("click");
    expect(wrapper.emitted("remove")?.[0]).toEqual(["fav_1"]);
  });

  it("adds a folder on Enter and clears the field", async () => {
    const wrapper = explorer();
    const input = wrapper.find("input[aria-label='New folder name']");
    await input.setValue("Bulk");
    await input.trigger("keydown.enter");
    expect(wrapper.emitted("new-folder")?.[0]).toEqual(["Bulk"]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("opens the import dialog from the panel", async () => {
    const wrapper = explorer();
    await wrapper.findAll("button").find((button) => button.text() === "Import…")!.trigger("click");
    expect(wrapper.emitted("import")).toHaveLength(1);
  });
});
