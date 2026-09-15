// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BookmarksView,
  CommandsView,
  NotesView,
} from "../../src/shared/commandsBookmarksNotes.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  appListeners: new Map<string, (payload: unknown) => void>(),
  hotkeyInvoke: vi.fn(),
  hotkeyListeners: new Set<(payload: unknown) => void>(),
  route: { hash: "" },
}));

vi.mock("../../src/renderer/features/commandsBookmarksNotes/api", () => {
  const api = {
    invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
    on: (channel: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(channel, callback);
      return () => bridge.listeners.delete(channel);
    },
  };
  const appApi = {
    invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
    on: (channel: string, callback: (payload: unknown) => void) => {
      bridge.appListeners.set(channel, callback);
      return () => bridge.appListeners.delete(channel);
    },
  };
  const get = () => (bridge.available ? api : null);
  return {
    getCommandsApi: get,
    getBookmarksApi: get,
    getNotesApi: get,
    getAppApi: () => (bridge.available ? appApi : null),
  };
});

vi.mock("../../src/renderer/features/hotkeys/hotkeysApi", () => ({
  getHotkeysApi: () => ({
    invoke: (channel: string, ...args: unknown[]) => bridge.hotkeyInvoke(channel, ...args),
    on: (_channel: string, callback: (payload: unknown) => void) => {
      bridge.hotkeyListeners.add(callback);
      return () => bridge.hotkeyListeners.delete(callback);
    },
  }),
}));

vi.mock("vue-router", () => ({ useRoute: () => bridge.route }));

import CommandsNotesTool from "../../src/renderer/features/commandsBookmarksNotes/CommandsNotesTool.vue";
import NoteImageField from "../../src/renderer/features/commandsBookmarksNotes/NoteImageField.vue";

function commandsView(partial: Partial<CommandsView> = {}): CommandsView {
  return {
    commands: [
      {
        id: "cmd_a1b2c3_0001",
        label: "Invite",
        template: "/invite {player}",
        enabled: true,
        hotkey: { actionId: "commands.cmd_a1b2c3_0001", accelerator: "Alt+1", registered: true },
      },
    ],
    searches: [
      {
        id: "srch_a1b2c3_0001",
        label: "T15+",
        text: '"tier: 1[5-6]"',
        enabled: true,
        hotkey: { actionId: "stash-searches.srch_a1b2c3_0001", accelerator: null, registered: false },
      },
    ],
    feedbackNotices: true,
    placeholders: { context: { player: "Bob", char: "Xan" }, sources: { player: "whisper", char: "character" } },
    chatEnabled: true,
    dryRun: false,
    issues: ["commands: 43 entries, kept the first 40"],
    ...partial,
  };
}

function bookmarksView(partial: Partial<BookmarksView> = {}): BookmarksView {
  return {
    bookmarks: [
      {
        id: "bm_a1b2c3_0001",
        label: "poe2db",
        url: "https://poe2db.tw/us/",
        mode: "external",
        enabled: true,
        hotkey: { actionId: "bookmarks.bm_a1b2c3_0001", accelerator: null, registered: false },
      },
    ],
    window: { width: 960, height: 720, alwaysOnTop: true },
    windowOpen: false,
    windowVisible: false,
    issues: [],
    ...partial,
  };
}

function notesView(partial: Partial<NotesView> = {}): NotesView {
  return {
    notes: [
      {
        id: "note_a1b2c3_0001",
        title: "Ritual",
        icon: "🩸",
        markdown: "**Omen** of Whittling",
        enabled: true,
        hotkey: { actionId: "notes.note_a1b2c3_0001", accelerator: null, registered: false },
      },
    ],
    panel: { anchor: "left", width: 440, height: 380 },
    panelVisible: false,
    issues: [],
    ...partial,
  };
}

function answer(views: { commands?: CommandsView; bookmarks?: BookmarksView; notes?: NotesView } = {}): void {
  const commands = views.commands ?? commandsView();
  const bookmarks = views.bookmarks ?? bookmarksView();
  const notes = views.notes ?? notesView();
  bridge.invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case "commands:list":
      case "commands:save":
        return commands;
      case "bookmarks:list":
      case "bookmarks:save":
        return bookmarks;
      case "notes:list":
      case "notes:save":
        return notes;
      case "notes:get":
        return { note: notes.notes[0], imageDataUri: undefined };
      case "commands:run":
        return { ok: true, dryRun: false, at: "2026-09-14T00:00:00.000Z", resolved: "/invite Bob", sent: "/invite Bob" };
      case "bookmarks:open":
        return { ok: true, mode: "external", url: "https://poe2db.tw/us/", at: "2026-09-14T00:00:00.000Z" };
      default:
        return undefined;
    }
  });
}

function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll("button").find((node) => node.text() === text);
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.appListeners.clear();
  bridge.hotkeyListeners.clear();
  bridge.route.hash = "";
  bridge.invoke.mockReset();
  bridge.hotkeyInvoke.mockReset();
  bridge.hotkeyInvoke.mockImplementation(async (channel: string, id: string, accelerator?: string | null) => {
    if (channel === "hotkeys:rebind") {
      return [
        {
          id,
          label: id,
          group: "Commands",
          defaultAccelerator: null,
          accelerator: accelerator ?? null,
          registered: (accelerator ?? null) !== null,
        },
      ];
    }
    return { ok: true };
  });
  answer();
});

describe("Commands & notes tool", () => {
  it("renders the heading and the commands tab", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.find("h2").text()).toBe("Commands & notes");
    expect(wrapper.text()).toContain("Invite");
    expect(wrapper.text()).toContain("Would send: /invite Bob");
    expect(wrapper.text()).toContain("commands: 43 entries, kept the first 40");
    wrapper.unmount();
  });

  it("shows the desktop-only state without a bridge", async () => {
    bridge.available = false;
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.text()).toContain("Commands & notes need the desktop app");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    wrapper.unmount();
  });

  it("lists the current placeholder values", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("{player}");
    expect(text).toContain("Bob");
    expect(text).toContain("latest whisper");
    wrapper.unmount();
  });

  it("follows the route hash to the stash searches tab", async () => {
    bridge.route.hash = "#searches";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.text()).toContain("Open search panel");
    expect(wrapper.text()).toContain('"tier: 1[5-6]"');
    wrapper.unmount();
  });

  it("saves the whole list after an edit", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    const save = button(wrapper, "Save");
    expect(save?.attributes("disabled")).toBeDefined();
    await wrapper.find('input[type="text"]').setValue("Invite buyer");
    await flushPromises();
    expect(button(wrapper, "Save")?.attributes("disabled")).toBeUndefined();
    await button(wrapper, "Save")!.trigger("click");
    await flushPromises();
    const call = bridge.invoke.mock.calls.find(([channel]) => channel === "commands:save");
    expect(call?.[1]).toEqual({
      commands: [{ id: "cmd_a1b2c3_0001", label: "Invite buyer", template: "/invite {player}", enabled: true }],
    });
    wrapper.unmount();
  });

  it("needs two clicks to delete a row", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await button(wrapper, "Delete")!.trigger("click");
    await flushPromises();
    expect(button(wrapper, "Confirm delete")).toBeTruthy();
    await button(wrapper, "Confirm delete")!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("No commands yet");
    wrapper.unmount();
  });

  it("runs one line from the desktop with the foreground hand-off", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await button(wrapper, "Send now")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("commands:run", "cmd_a1b2c3_0001", { focus: true });
    expect(wrapper.text()).toContain("Sent: /invite Bob");
    wrapper.unmount();
  });

  it("relabels the run button while dry-run is on", async () => {
    answer({ commands: commandsView({ dryRun: true }) });
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(button(wrapper, "Preview send (dry-run)")).toBeTruthy();
    wrapper.unmount();
  });

  it("warns about a line that goes to the selected chat channel", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await wrapper.findAll('input[type="text"]')[1]!.setValue("hello everyone");
    await flushPromises();
    expect(wrapper.text()).toContain("goes to whatever chat channel");
    wrapper.unmount();
  });

  it("binds a hotkey through validate then rebind", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await button(wrapper, "Rebind")!.trigger("click");
    await flushPromises();
    const capture = wrapper.find(".capture-input");
    await capture.trigger("keydown", { key: "1", altKey: true, code: "Digit1" });
    await flushPromises();
    expect(bridge.hotkeyInvoke.mock.calls[0]?.[0]).toBe("hotkeys:validate");
    expect(bridge.hotkeyInvoke.mock.calls[1]).toEqual(["hotkeys:rebind", "commands.cmd_a1b2c3_0001", "Alt+1"]);
    wrapper.unmount();
  });

  it("shows the new accelerator as soon as the rebind answers", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    // The row's own snapshot says Alt+1; rebinding must not leave the cell
    // showing a stale key until the tab is re-entered.
    await button(wrapper, "Rebind")!.trigger("click");
    await flushPromises();
    await wrapper.find(".capture-input").trigger("keydown", { key: "2", altKey: true, code: "Digit2" });
    await flushPromises();
    expect(wrapper.find("kbd").text()).toBe("Alt+2");
    expect(button(wrapper, "Clear")).toBeTruthy();
    wrapper.unmount();
  });

  it("follows hotkeys:changed when the key is rebound elsewhere", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.find("kbd").text()).toBe("Alt+1");
    for (const listener of bridge.hotkeyListeners) {
      listener([
        {
          id: "commands.cmd_a1b2c3_0001",
          label: "Invite",
          group: "Commands",
          defaultAccelerator: null,
          accelerator: null,
          registered: false,
          error: "Alt+1 is taken by another application.",
        },
      ]);
    }
    await flushPromises();
    expect(wrapper.find("kbd").exists()).toBe(false);
    expect(wrapper.text()).toContain("Alt+1 is taken by another application.");
    wrapper.unmount();
  });

  it("offers no binding for a starter example nobody has saved", async () => {
    answer({ commands: commandsView({ issues: ["showing example commands — save to keep them"] }) });
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(button(wrapper, "Rebind")).toBeUndefined();
    expect(wrapper.text()).toContain("Save to bind");
    wrapper.unmount();
  });

  it("follows the top-bar Dry-run switch", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(button(wrapper, "Send now")).toBeTruthy();
    bridge.appListeners.get("app:dry-run-changed")?.(true);
    await flushPromises();
    expect(button(wrapper, "Preview send (dry-run)")).toBeTruthy();
    wrapper.unmount();
  });

  it("keeps an unsaved edit when the notices switch is toggled", async () => {
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await wrapper.find('input[type="text"]').setValue("Invite buyer");
    await flushPromises();
    await wrapper.find('.advanced-options input[type="checkbox"]').setValue(false);
    await flushPromises();
    expect((wrapper.find('input[type="text"]').element as HTMLInputElement).value).toBe("Invite buyer");
    expect(button(wrapper, "Save")?.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("shows an error instead of a spinner when the bridge throws", async () => {
    bridge.invoke.mockRejectedValue(new Error("no handler for commands:list"));
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("no handler for commands:list");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("Bookmarks tab", () => {
  it("explains an address it would refuse", async () => {
    bridge.route.hash = "#bookmarks";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    const url = wrapper.findAll('input[type="text"]')[1]!;
    await url.setValue("javascript:alert(1)");
    await flushPromises();
    expect(wrapper.text()).toContain("only http and https addresses are allowed");
    wrapper.unmount();
  });

  it("opens a bookmark and reports where it went", async () => {
    bridge.route.hash = "#bookmarks";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await button(wrapper, "Open")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("bookmarks:open", "bm_a1b2c3_0001");
    expect(wrapper.text()).toContain("Opened in the external browser");
    wrapper.unmount();
  });
});

describe("Notes tab", () => {
  it("previews the markdown subset", async () => {
    bridge.route.hash = "#notes";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    expect(wrapper.find(".note-markdown strong").text()).toBe("Omen");
    wrapper.unmount();
  });

  it("keeps unsaved text when an image is attached", async () => {
    bridge.route.hash = "#notes";
    const notes = notesView();
    answer({ notes });
    bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "notes:list" || channel === "notes:save") return notes;
      if (channel === "notes:set-image") return { ...notes.notes[0], image: { mime: "image/png", bytes: 4 } };
      if (channel === "notes:get") return { note: notes.notes[0], imageDataUri: "data:image/png;base64,AAAA" };
      return undefined;
    });
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await wrapper.find("textarea").setValue("# my own cheat sheet");
    await flushPromises();

    // The field itself reads the file (covered by the 2 MB test below); what
    // matters here is what the tab does with the data URI it emits.
    wrapper.findComponent(NoteImageField).vm.$emit("image", "data:image/png;base64,AAAA");
    await flushPromises();
    await flushPromises();

    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "notes:set-image")).toBe(true);
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("# my own cheat sheet");
    expect(button(wrapper, "Save")?.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("asks for a save before an image can be attached to a brand-new note", async () => {
    bridge.route.hash = "#notes";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    await button(wrapper, "Add note")!.trigger("click");
    await flushPromises();
    const inputs = wrapper.findAll('input[type="file"]');
    expect(inputs.at(-1)!.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Save the note first");
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "notes:set-image")).toBe(false);
    wrapper.unmount();
  });

  it("refuses an image over the 2 MB limit before main ever sees it", async () => {
    bridge.route.hash = "#notes";
    const wrapper = mount(CommandsNotesTool);
    await flushPromises();
    const input = wrapper.find('input[type="file"]');
    const file = new File([new Uint8Array(3 * 1024 * 1024)], "big.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("limit 2 MB");
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "notes:set-image")).toBe(false);
    wrapper.unmount();
  });
});
