// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandsView, NotesView, RunOutcome } from "../../src/shared/commandsBookmarksNotes.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/features/commandsBookmarksNotes/api", () => {
  const api = {
    invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
    on: (channel: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(channel, callback);
      return () => bridge.listeners.delete(channel);
    },
  };
  const get = () => (bridge.available ? api : null);
  return { getCommandsApi: get, getBookmarksApi: get, getNotesApi: get, getAppApi: () => null };
});

vi.mock("../../src/renderer/features/hotkeys/hotkeysApi", () => ({
  getHotkeysApi: () => null,
}));

import NotesPanel from "../../src/renderer/features/commandsBookmarksNotes/panels/NotesPanel.vue";
import StashSearchPanel from "../../src/renderer/features/commandsBookmarksNotes/panels/StashSearchPanel.vue";

const PNG = "data:image/png;base64,AAAA";

function notesView(partial: Partial<NotesView> = {}): NotesView {
  return {
    notes: [
      {
        id: "note_a1b2c3_0001",
        title: "Ritual",
        icon: "🩸",
        markdown: "see [poe2db](https://poe2db.tw/us/Omens)",
        image: { mime: "image/png", bytes: 4 },
        enabled: true,
        hotkey: { actionId: "notes.note_a1b2c3_0001", accelerator: null, registered: false },
      },
      {
        id: "note_a1b2c3_0002",
        title: "Maps",
        icon: "🗺",
        markdown: "**run them**",
        enabled: true,
        hotkey: { actionId: "notes.note_a1b2c3_0002", accelerator: null, registered: false },
      },
    ],
    panel: { anchor: "left", width: 440, height: 380 },
    panelVisible: true,
    issues: [],
    ...partial,
  };
}

function commandsView(partial: Partial<CommandsView> = {}): CommandsView {
  return {
    commands: [],
    searches: [
      {
        id: "srch_a1b2c3_0001",
        label: "T15+",
        text: '"tier: 1[5-6]"',
        enabled: true,
        hotkey: { actionId: "stash-searches.srch_a1b2c3_0001", accelerator: null, registered: false },
      },
      {
        id: "srch_a1b2c3_0002",
        label: "Off",
        text: "rarity: unique",
        enabled: false,
        hotkey: { actionId: "stash-searches.srch_a1b2c3_0002", accelerator: null, registered: false },
      },
    ],
    feedbackNotices: true,
    placeholders: { context: {}, sources: {} },
    chatEnabled: true,
    dryRun: false,
    issues: [],
    ...partial,
  };
}

function outcome(partial: Partial<RunOutcome> = {}): RunOutcome {
  return { ok: true, dryRun: false, at: "2026-09-14T00:00:00.000Z", resolved: '"^Waystone"', sent: '"^Waystone"', ...partial };
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NotesPanel", () => {
  function answer(view = notesView()): void {
    bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "notes:list") return view;
      if (channel === "notes:get") {
        const note = view.notes.find((entry) => entry.id === args[0]);
        return note ? { note, ...(note.image ? { imageDataUri: PNG } : {}) } : undefined;
      }
      if (channel === "bookmarks:open-url") return { ok: true, mode: "external", url: String(args[0]), at: "" };
      return undefined;
    });
  }

  it("lists the notes and shows the one the payload asks for", async () => {
    answer();
    const wrapper = mount(NotesPanel, {
      props: { panelId: "notes", payload: { noteId: "note_a1b2c3_0002" }, visible: true },
    });
    await flushPromises();
    expect(wrapper.findAll(".notes-rail-item")).toHaveLength(2);
    expect(wrapper.find(".note-title").text()).toBe("Maps");
    expect(wrapper.find(".note-markdown strong").text()).toBe("run them");
    wrapper.unmount();
  });

  it("loads the image of the selected note", async () => {
    answer();
    const wrapper = mount(NotesPanel, { props: { panelId: "notes", payload: {}, visible: true } });
    await flushPromises();
    expect(wrapper.find("img.note-image").attributes("src")).toBe(PNG);
    wrapper.unmount();
  });

  it("asks main to open a link instead of navigating", async () => {
    answer();
    const wrapper = mount(NotesPanel, { props: { panelId: "notes", payload: {}, visible: true } });
    await flushPromises();
    await wrapper.find(".note-markdown a").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("bookmarks:open-url", "https://poe2db.tw/us/Omens", "external");
    wrapper.unmount();
  });

  it("caps the body at the configured panel height, not at a fixed 60vh", async () => {
    answer(notesView({ panel: { anchor: "left", width: 440, height: 300 } }));
    const wrapper = mount(NotesPanel, { props: { panelId: "notes", payload: {}, visible: true } });
    await flushPromises();
    // 300 px panel minus the host's title bar.
    expect(wrapper.find(".notes-body").attributes("style")).toContain("max-height: 256px");
    wrapper.unmount();
  });

  it("shows the empty state with no notes", async () => {
    answer(notesView({ notes: [] }));
    const wrapper = mount(NotesPanel, { props: { panelId: "notes", payload: {}, visible: true } });
    await flushPromises();
    expect(wrapper.text()).toContain("No notes yet");
    wrapper.unmount();
  });
});

describe("StashSearchPanel", () => {
  function answer(run: RunOutcome = outcome()): void {
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "commands:list") return commandsView();
      if (channel === "commands:search-text" || channel === "commands:run-search") return run;
      return undefined;
    });
  }

  it("prefills the field and lists the enabled searches only", async () => {
    answer();
    const wrapper = mount(StashSearchPanel, {
      props: { panelId: "stash-search", payload: { prefill: '"^Waystone"' }, visible: true },
    });
    await flushPromises();
    expect((wrapper.find("input").element as HTMLInputElement).value).toBe('"^Waystone"');
    expect(wrapper.findAll("button.pill")).toHaveLength(1);
    wrapper.unmount();
  });

  it("types the typed text once, from the panel", async () => {
    answer();
    const wrapper = mount(StashSearchPanel, {
      props: { panelId: "stash-search", payload: {}, visible: true },
    });
    await flushPromises();
    await wrapper.find("input").setValue('"^Waystone"');
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("commands:search-text", '"^Waystone"', { fromPanel: true });
    expect(wrapper.text()).toContain('Typed: "^Waystone"');
    wrapper.unmount();
  });

  it("runs a saved search from its chip", async () => {
    answer();
    const wrapper = mount(StashSearchPanel, {
      props: { panelId: "stash-search", payload: {}, visible: true },
    });
    await flushPromises();
    await wrapper.find("button.pill").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("commands:run-search", "srch_a1b2c3_0001", { fromPanel: true });
    wrapper.unmount();
  });

  it("closes itself shortly after a real fill, but stays open on a dry-run", async () => {
    vi.useFakeTimers();
    answer();
    const wrapper = mount(StashSearchPanel, { props: { panelId: "stash-search", payload: {}, visible: true } });
    await flushPromises();
    await wrapper.find("input").setValue('"^Waystone"');
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.emitted("close")).toBeUndefined();
    vi.advanceTimersByTime(700);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();

    answer(outcome({ dryRun: true }));
    const dry = mount(StashSearchPanel, { props: { panelId: "stash-search", payload: {}, visible: true } });
    await flushPromises();
    await dry.find("input").setValue('"^Waystone"');
    await dry.find("form").trigger("submit");
    await flushPromises();
    vi.advanceTimersByTime(2000);
    expect(dry.emitted("close")).toBeUndefined();
    expect(dry.text()).toContain("Dry-run · would type");
    dry.unmount();
  });

  it("shows a block without retrying", async () => {
    answer(outcome({ ok: false, blockedBy: "not-foreground", error: "Path of Exile is not the foreground window" }));
    const wrapper = mount(StashSearchPanel, { props: { panelId: "stash-search", payload: {}, visible: true } });
    await flushPromises();
    await wrapper.find("input").setValue('"^Waystone"');
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Blocked: not-foreground");
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "commands:search-text")).toHaveLength(1);
    wrapper.unmount();
  });
});
