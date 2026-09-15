/**
 * Sidecar store for note images: `<userData>/notes-images/<noteId>.<ext>`.
 *
 * The settings document only ever carries the image META (mime, bytes,
 * dimensions) so the JSON never grows a binary; the bytes live beside it as
 * ordinary files and are handed to the overlay as data URIs.
 *
 * The sweep only ever deletes files whose NAME is one this store could have
 * written (`note_<…>_<4>.png|jpg|webp|gif`): a file the user dropped into that
 * folder themselves must survive.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  imageExtension,
  NOTE_IMAGE_FILE_PATTERN,
  toDataUri,
  type ImageDataUri,
} from "../../../core/commandsBookmarksNotes.js";
import type { NoteImageMeta } from "../../../shared/commandsBookmarksNotes.js";

/** The slice of node:fs the store uses (tests inject a memory fs). */
export interface NoteImageFs {
  exists(file: string): boolean;
  read(file: string): Uint8Array | undefined;
  write(file: string, bytes: Uint8Array): void;
  remove(file: string): void;
  list(dir: string): string[];
  mkdir(dir: string): void;
}

export function noteImagesDir(userDataDir: string): string {
  return path.join(userDataDir, "notes-images");
}

export const realNoteImageFs: NoteImageFs = {
  exists: (file) => existsSync(file),
  read: (file) => {
    try {
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
    } catch {
      return undefined;
    }
  },
  write: (file, bytes) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  },
  remove: (file) => {
    try {
      rmSync(file, { force: true });
    } catch {
      // A file that is already gone is the outcome we wanted.
    }
  },
  list: (dir) => {
    try {
      return existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  },
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
};

const EXTENSIONS = ["png", "jpg", "webp", "gif"] as const;

export class NoteImageStore {
  constructor(
    private readonly dir: string,
    private readonly fs: NoteImageFs = realNoteImageFs,
  ) {}

  fileFor(noteId: string, mime: NoteImageMeta["mime"]): string {
    return path.join(this.dir, `${noteId}.${imageExtension(mime)}`);
  }

  /** Writes the bytes and removes an older file that used another extension. */
  put(noteId: string, image: ImageDataUri): NoteImageMeta {
    this.fs.mkdir(this.dir);
    const file = this.fileFor(noteId, image.mime);
    for (const extension of EXTENSIONS) {
      const other = path.join(this.dir, `${noteId}.${extension}`);
      if (other !== file && this.fs.exists(other)) this.fs.remove(other);
    }
    this.fs.write(file, image.bytes);
    return { mime: image.mime, bytes: image.bytes.length };
  }

  /** The stored image as a data URI, or undefined when the file is gone. */
  get(noteId: string, meta: NoteImageMeta): string | undefined {
    const bytes = this.fs.read(this.fileFor(noteId, meta.mime));
    return bytes ? toDataUri(meta.mime, bytes) : undefined;
  }

  remove(noteId: string): void {
    for (const extension of EXTENSIONS) {
      const file = path.join(this.dir, `${noteId}.${extension}`);
      if (this.fs.exists(file)) this.fs.remove(file);
    }
  }

  /**
   * Deletes images belonging to notes that no longer exist. Only names this
   * store could have written are candidates — anything else in the folder is
   * the user's and is left alone.
   */
  sweep(keepIds: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const name of this.fs.list(this.dir)) {
      if (!NOTE_IMAGE_FILE_PATTERN.test(name)) continue;
      const stem = name.slice(0, name.lastIndexOf("."));
      if (keepIds.has(stem)) continue;
      this.fs.remove(path.join(this.dir, name));
      removed.push(name);
    }
    return removed;
  }
}
