import { describe, expect, it } from "vitest";
import { parseImageDataUri, toDataUri } from "../src/core/commandsBookmarksNotes.js";
import { NoteImageStore, noteImagesDir, type NoteImageFs } from "../src/main/features/commandsBookmarksNotes/noteImages.js";

const DIR = "C:/user/notes-images";

function memoryFs(seed: Record<string, Uint8Array> = {}): { fs: NoteImageFs; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const normalize = (file: string): string => file.replace(/\\/g, "/");
  return {
    files,
    fs: {
      exists: (file) => files.has(normalize(file)),
      read: (file) => files.get(normalize(file)),
      write: (file, bytes) => {
        files.set(normalize(file), bytes);
      },
      remove: (file) => {
        files.delete(normalize(file));
      },
      list: (dir) =>
        [...files.keys()]
          .filter((file) => file.startsWith(`${normalize(dir)}/`))
          .map((file) => file.slice(normalize(dir).length + 1)),
      mkdir: () => undefined,
    },
  };
}

const PNG = parseImageDataUri(toDataUri("image/png", new Uint8Array([1, 2, 3])));
if (!PNG.ok) throw new Error("fixture image did not parse");
const GIF = parseImageDataUri(toDataUri("image/gif", new Uint8Array([4, 5])));
if (!GIF.ok) throw new Error("fixture image did not parse");

describe("noteImagesDir", () => {
  it("sits next to the settings file, not under artifacts", () => {
    expect(noteImagesDir("C:/user").replace(/\\/g, "/")).toBe(DIR);
  });
});

describe("NoteImageStore", () => {
  it("writes, reads back as a data URI and removes", () => {
    const { fs, files } = memoryFs();
    const store = new NoteImageStore(DIR, fs);
    const meta = store.put("note_a1b2c3_0001", PNG.image);
    expect(meta).toEqual({ mime: "image/png", bytes: 3 });
    expect(files.has(`${DIR}/note_a1b2c3_0001.png`)).toBe(true);
    expect(store.get("note_a1b2c3_0001", meta)).toBe(toDataUri("image/png", new Uint8Array([1, 2, 3])));
    store.remove("note_a1b2c3_0001");
    expect(files.size).toBe(0);
  });

  it("drops the old file when the type changes", () => {
    const { fs, files } = memoryFs();
    const store = new NoteImageStore(DIR, fs);
    store.put("note_a1b2c3_0001", PNG.image);
    const meta = store.put("note_a1b2c3_0001", GIF.image);
    expect([...files.keys()]).toEqual([`${DIR}/note_a1b2c3_0001.gif`]);
    expect(store.get("note_a1b2c3_0001", meta)).toContain("data:image/gif;base64,");
  });

  it("answers undefined when the file is gone", () => {
    const { fs } = memoryFs();
    const store = new NoteImageStore(DIR, fs);
    expect(store.get("note_a1b2c3_0001", { mime: "image/png", bytes: 3 })).toBeUndefined();
  });

  it("sweeps orphans but never a file it could not have written", () => {
    const { fs, files } = memoryFs({
      [`${DIR}/note_a1b2c3_0001.png`]: new Uint8Array([1]),
      [`${DIR}/note_a1b2c3_0002.png`]: new Uint8Array([2]),
      [`${DIR}/my-own-screenshot.png`]: new Uint8Array([3]),
      [`${DIR}/notes.txt`]: new Uint8Array([4]),
    });
    const store = new NoteImageStore(DIR, fs);
    const removed = store.sweep(new Set(["note_a1b2c3_0001"]));
    expect(removed).toEqual(["note_a1b2c3_0002.png"]);
    expect([...files.keys()].sort()).toEqual(
      [`${DIR}/my-own-screenshot.png`, `${DIR}/note_a1b2c3_0001.png`, `${DIR}/notes.txt`].sort(),
    );
  });

  it("reclaims the image of a hand-edited note id, which is not always `note_…`", () => {
    // A settings file edited by hand can carry any id the sanitizer accepts,
    // and the store names the file after it — so the sweep must recognise it.
    const { fs, files } = memoryFs({
      [`${DIR}/cmd_x1y2z3_abcd.png`]: new Uint8Array([1]),
      [`${DIR}/holiday.png`]: new Uint8Array([2]),
    });
    const store = new NoteImageStore(DIR, fs);
    expect(store.sweep(new Set())).toEqual(["cmd_x1y2z3_abcd.png"]);
    expect([...files.keys()]).toEqual([`${DIR}/holiday.png`]);
  });
});
