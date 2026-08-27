export interface ClipboardReader {
  readText(): string;
}

/**
 * Read-only clipboard text source. Does not write the clipboard or synthesize
 * copy keystrokes — the operator (or a later user-invoked hotkey) owns capture.
 */
export class ClipboardSource {
  readonly #reader: ClipboardReader;

  constructor(reader: ClipboardReader) {
    this.#reader = reader;
  }

  readText(): string {
    return this.#reader.readText();
  }
}

export function createClipboardSource(reader: ClipboardReader): ClipboardSource {
  return new ClipboardSource(reader);
}

export function createElectronClipboardReader(clipboard: { readText(): string }): ClipboardReader {
  return {
    readText(): string {
      return clipboard.readText();
    },
  };
}
