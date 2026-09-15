import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent } from "../src/core/clientLog.js";
import {
  checkBookmarkUrl,
  checkStashSearchText,
  commandPreview,
  decodeBase64,
  DEFAULT_NOTES_PANEL,
  encodeBase64,
  hotkeyActionId,
  imageDimensions,
  ITEM_ID_PATTERN,
  newItemId,
  normalizeBookmarksSettings,
  normalizeCommandsSettings,
  normalizeNotesSettings,
  NOTE_IMAGE_MAX_BYTES,
  parseImageDataUri,
  placeholderContextFrom,
  sanitizeCommand,
  sanitizeNote,
  sanitizeStashSearch,
  starterCommands,
  starterStashSearches,
  toDataUri,
} from "../src/core/commandsBookmarksNotes.js";

const PREFIX = "2026/09/11 20:52:15 40206281 2caa229f [INFO Client 23032] ";
const FIXTURES = path.join(process.cwd(), "fixtures", "commandsBookmarksNotes");

function whisper(rest: string): Extract<ClientLogEvent, { kind: "whisper" }> {
  const event = parseClientLogLine(PREFIX + rest, areaInfo);
  if (!event || event.kind !== "whisper") throw new Error(`not a whisper: ${rest}`);
  return event;
}

describe("ids and hotkey action ids", () => {
  it("builds ids that match the sanitizer's own pattern", () => {
    const id = newItemId("command", 1_757_000_000_000, () => 0.5);
    expect(id.startsWith("cmd_")).toBe(true);
    expect(ITEM_ID_PATTERN.test(id)).toBe(true);
    for (const kind of ["command", "search", "bookmark", "note"] as const) {
      expect(ITEM_ID_PATTERN.test(newItemId(kind, 1, () => 0))).toBe(true);
    }
  });

  it("maps each kind to its hotkey group prefix", () => {
    expect(hotkeyActionId("command", "cmd_a_0001")).toBe("commands.cmd_a_0001");
    expect(hotkeyActionId("search", "srch_a_0001")).toBe("stash-searches.srch_a_0001");
    expect(hotkeyActionId("bookmark", "bm_a_0001")).toBe("bookmarks.bm_a_0001");
    expect(hotkeyActionId("note", "note_a_0001")).toBe("notes.note_a_0001");
  });

  it("keeps every starter example inside the limits", () => {
    for (const item of starterCommands()) {
      expect(ITEM_ID_PATTERN.test(item.id)).toBe(true);
      expect(item.template.includes("\n")).toBe(false);
      expect(sanitizeCommand(item, 0)?.issues).toEqual([]);
    }
    for (const item of starterStashSearches()) {
      expect(sanitizeStashSearch(item, 0)?.value.enabled).toBe(true);
    }
  });
});

describe("sanitizeCommand", () => {
  it("refuses anything that is not an object", () => {
    expect(sanitizeCommand("nope", 0)).toBeUndefined();
    expect(sanitizeCommand(null, 0)).toBeUndefined();
    expect(sanitizeCommand([], 0)).toBeUndefined();
  });

  it("trims the name, caps it, and reports what it changed", () => {
    const long = sanitizeCommand({ id: "cmd_a1_0001", label: "x".repeat(80), template: "/hideout" }, 0)!;
    expect(long.value.label).toHaveLength(60);
    expect(long.issues.join(" ")).toContain("shortened");
    const empty = sanitizeCommand({ id: "cmd_a1_0001", label: "   ", template: "/hideout" }, 2)!;
    expect(empty.value.label).toBe("Command 3");
  });

  it("collapses a multi-line template and cuts one that is too long", () => {
    const multi = sanitizeCommand({ id: "cmd_a1_0001", label: "Multi", template: "a\nb" }, 0)!;
    expect(multi.value.template).toBe("a b");
    const long = sanitizeCommand({ id: "cmd_a1_0001", label: "Long", template: "/x".repeat(400) }, 0)!;
    expect(long.value.template).toHaveLength(300);
    expect(long.issues.join(" ")).toContain("cut to 300");
  });

  it("accepts a whisper reply and keeps an untypable line with a warning", () => {
    const ok = sanitizeCommand({ id: "cmd_a1_0001", label: "Thanks", template: "@{player} thanks!" }, 0)!;
    expect(ok.issues).toEqual([]);
    const bad = sanitizeCommand({ id: "cmd_a1_0001", label: "gg", template: "gg é" }, 0)!;
    expect(bad.value.template).toBe("gg é");
    expect(bad.issues.join(" ")).toContain("cannot type");
  });

  it("generates an id when one is missing", () => {
    const generated = sanitizeCommand({ label: "No id", template: "/hideout" }, 0)!;
    expect(ITEM_ID_PATTERN.test(generated.value.id)).toBe(true);
    expect(generated.issues.join(" ")).toContain("generated");
  });
});

describe("checkStashSearchText / sanitizeStashSearch", () => {
  it("accepts the regex forms the game understands", () => {
    expect(checkStashSearchText('"tier: 1[5-6]"').ok).toBe(true);
    expect(checkStashSearchText('"^Waystone"').text).toBe('"^Waystone"');
  });

  it("refuses untypable characters, emptiness and over-long text", () => {
    const arrow = checkStashSearchText("tier → 15");
    expect(arrow.ok).toBe(false);
    expect(arrow.untypable).toEqual(["→"]);
    expect(checkStashSearchText("   ").ok).toBe(false);
    expect(checkStashSearchText("x".repeat(251)).reason).toContain("251 characters");
  });

  it("keeps an unusable search but switches it off", () => {
    const item = sanitizeStashSearch({ id: "srch_a1_0001", label: "Arrow", text: "→" }, 0)!;
    expect(item.value.enabled).toBe(false);
    expect(item.issues.join(" ")).toContain("cannot type");
  });
});

describe("checkBookmarkUrl", () => {
  it("accepts http and https", () => {
    expect(checkBookmarkUrl("https://poe2db.tw/us/").url).toBe("https://poe2db.tw/us/");
    expect(checkBookmarkUrl("http://localhost:5173/x?y=1").ok).toBe(true);
  });

  it("refuses every other scheme and shape", () => {
    expect(checkBookmarkUrl("javascript:alert(1)").ok).toBe(false);
    expect(checkBookmarkUrl("file:///c:/x").ok).toBe(false);
    expect(checkBookmarkUrl("ftp://example.com/x").ok).toBe(false);
    expect(checkBookmarkUrl("https://user:pw@host/").reason).toContain("password");
    expect(checkBookmarkUrl("https://example.com/a b").ok).toBe(false);
    expect(checkBookmarkUrl(`https://example.com/${"x".repeat(2100)}`).ok).toBe(false);
    expect(checkBookmarkUrl(42).ok).toBe(false);
  });
});

describe("sanitizeNote", () => {
  it("defaults the icon, normalizes newlines and caps the text", () => {
    const note = sanitizeNote({ id: "note_a1_0001", title: "Ritual", markdown: "a\r\nb" }, 0)!;
    expect(note.value.icon).toBe("📝");
    expect(note.value.markdown).toBe("a\nb");
    const long = sanitizeNote({ id: "note_a1_0001", title: "Long", markdown: "x".repeat(20_001) }, 0)!;
    expect(long.value.markdown).toHaveLength(20_000);
    expect(long.issues.join(" ")).toContain("cut to 20000");
  });

  it("drops an image record with a MIME we do not support", () => {
    const note = sanitizeNote(
      { id: "note_a1_0001", title: "Bad", markdown: "x", image: { mime: "image/svg+xml", bytes: 10 } },
      0,
    )!;
    expect(note.value.image).toBeUndefined();
    expect(note.issues.join(" ")).toContain("unreadable");
  });
});

describe("settings sanitizers", () => {
  const junk = JSON.parse(readFileSync(path.join(FIXTURES, "settings-junk.json"), "utf8")) as Record<string, unknown>;

  it("defaults on junk input", () => {
    expect(normalizeCommandsSettings(undefined).value).toEqual({ commands: [], searches: [], feedbackNotices: true });
    expect(normalizeCommandsSettings(42).value.commands).toEqual([]);
    expect(normalizeBookmarksSettings([]).value.window).toEqual({ width: 960, height: 720, alwaysOnTop: true });
    expect(normalizeNotesSettings(null).value.panel).toEqual(DEFAULT_NOTES_PANEL);
  });

  it("repairs the junk document and says what it did", () => {
    const commands = normalizeCommandsSettings(junk.commands);
    expect(commands.value.commands.map((item) => item.label)).toEqual(["Invite", "Command 2", "Duplicate id", "Multi"]);
    expect(commands.issues.join(" | ")).toContain("unusable entry, dropped");
    expect(commands.issues.join(" | ")).toContain("duplicate id");
    expect(commands.value.feedbackNotices).toBe(false);
    const searches = commands.value.searches;
    expect(searches.find((item) => item.label === "Arrow")?.enabled).toBe(false);
    expect(searches.find((item) => item.label === "Empty")?.enabled).toBe(false);

    const bookmarks = normalizeBookmarksSettings(junk.bookmarks);
    expect(bookmarks.value.bookmarks.map((item) => item.label)).toEqual(["poe2db"]);
    expect(bookmarks.value.bookmarks[0]!.mode).toBe("window");
    expect(bookmarks.value.window).toEqual({ width: 480, height: 2160, alwaysOnTop: false });

    const notes = normalizeNotesSettings(junk.notes);
    expect(notes.value.notes.map((note) => note.title)).toEqual(["Ritual", "Bad image", "Good image"]);
    expect([...notes.value.notes[0]!.icon].length).toBe(4);
    expect(notes.value.notes[2]!.image).toEqual({ mime: "image/png", bytes: 70, width: 1, height: 1 });
    expect(notes.value.panel).toEqual({ anchor: "left", width: 280, height: 1000 });
    expect(notes.value.lastNoteId).toBeUndefined();
  });

  it("caps every list at 40 entries", () => {
    const many = Array.from({ length: 43 }, (_, index) => ({
      id: `cmd_a1_${String(index).padStart(4, "0")}`,
      label: `c${index}`,
      template: "/hideout",
    }));
    const result = normalizeCommandsSettings({ commands: many });
    expect(result.value.commands).toHaveLength(40);
    expect(result.issues[0]).toBe("commands: 43 entries, kept the first 40");
  });
});

describe("placeholderContextFrom", () => {
  const tradeLine =
    '@From Himbothlice: Hi, I would like to buy your Ghoul Lash, Long Belt listed for 1 exalted in Forbidden Rites (stash tab "~price 1 exalted"; position: left 10, top 10)';

  it("builds the worked example from the log tail", () => {
    const snapshot = placeholderContextFrom({
      status: { character: { name: "Xan" }, area: { info: { name: "Beacon of Salvation Hideout" } } },
      whispers: [whisper(tradeLine), whisper("@From Bob: ty")],
    });
    expect(snapshot.context).toEqual({
      char: "Xan",
      area: "Beacon of Salvation Hideout",
      player: "Bob",
      latestWhisper: "ty",
      item: "Ghoul Lash, Long Belt",
      price: "1 exalted",
      tab: "~price 1 exalted",
      left: 10,
      top: 10,
      league: "Forbidden Rites",
    });
    expect(snapshot.sources.player).toBe("whisper");
    expect(snapshot.sources.item).toBe("trade-whisper");
    expect(snapshot.whisperAt).toBeTruthy();
  });

  it("ignores outgoing whispers and falls back to the feed league", () => {
    const snapshot = placeholderContextFrom({
      whispers: [whisper("@To Bob: hi")],
      league: "Runes of Aldur",
    });
    expect(snapshot.context.player).toBeUndefined();
    expect(snapshot.context.league).toBe("Runes of Aldur");
    expect(snapshot.sources.league).toBe("price-feed");
  });

  it("keeps a bulk whisper's quantity", () => {
    const bulk = whisper(
      "@From Bob: Hi, I'd like to buy your 2 Preserved Cranium for my 10 exalted in Forbidden Rites.",
    );
    const snapshot = placeholderContextFrom({ whispers: [bulk] });
    expect(snapshot.context.item).toContain("2 ");
    expect(snapshot.context.price).toBe("10 exalted");
  });

  it("returns nothing at all without a log", () => {
    expect(placeholderContextFrom({}).context).toEqual({});
  });
});

describe("commandPreview", () => {
  const snapshot = placeholderContextFrom({
    status: { character: { name: "Xan" } },
    whispers: [whisper("@From Bob: ty")],
  });

  it("resolves what it can and reports what it cannot", () => {
    expect(commandPreview("/invite {player}", snapshot).resolved).toBe("/invite Bob");
    expect(commandPreview("@{player} hi", snapshot).ok).toBe(true);
    const unknown = commandPreview("/x {nope}", snapshot);
    expect(unknown.unresolved).toEqual(["nope"]);
    expect(unknown.ok).toBe(false);
    const arrow = commandPreview("gg →", snapshot);
    expect(arrow.untypable).toEqual(["→"]);
    expect(arrow.issues[0]).toContain("cannot type");
  });

  it("refuses a line whose only placeholder has no value", () => {
    const empty = commandPreview("/invite {player}", placeholderContextFrom({}));
    expect(empty.resolved).toBe("/invite {player}");
    expect(empty.ok).toBe(false);
  });
});

describe("note images", () => {
  const png = readFileSync(path.join(FIXTURES, "px.png"));
  const pngBytes = new Uint8Array(png);

  it("round-trips the 1x1 PNG through a data URI", () => {
    const uri = toDataUri("image/png", pngBytes);
    const parsed = parseImageDataUri(uri);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.image.bytes.length).toBe(70);
    expect(imageDimensions(parsed.image.bytes, "image/png")).toEqual({ width: 1, height: 1 });
    expect(encodeBase64(decodeBase64(encodeBase64(pngBytes))!)).toBe(encodeBase64(pngBytes));
  });

  it("reads JPEG, GIF and WebP headers", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x11, 0x00]);
    expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 2, height: 3 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 5, 0]);
    expect(imageDimensions(gif, "image/gif")).toEqual({ width: 4, height: 5 });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x58], 12);
    webp.set([5, 0, 0], 24);
    webp.set([6, 0, 0], 27);
    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 6, height: 7 });
  });

  it("refuses oversize, unsupported and broken data URIs", () => {
    const big = `data:image/png;base64,${encodeBase64(new Uint8Array(NOTE_IMAGE_MAX_BYTES + 8))}`;
    const oversize = parseImageDataUri(big);
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.reason).toContain("limit 2 MB");
    expect(parseImageDataUri("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").ok).toBe(false);
    expect(parseImageDataUri("data:image/png;base64,!!!!").ok).toBe(false);
    expect(parseImageDataUri("https://example.com/x.png").ok).toBe(false);
    expect(parseImageDataUri(null).ok).toBe(false);
  });
});
