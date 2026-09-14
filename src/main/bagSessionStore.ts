import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { validateBagSession, type BagSession } from "../core/bagSession.js";

interface Entry { sequence: number; previous: string; hash: string; session: BagSession }
const hashEntry = (sequence: number, previous: string, session: BagSession) =>
  createHash("sha256").update(JSON.stringify({ sequence, previous, session })).digest("hex");
function assertHistory(previous: BagSession | undefined, next: BagSession) {
  if (!previous) return;
  if (JSON.stringify(previous.original) !== JSON.stringify(next.original)) throw new Error("Cannot overwrite original bag capture.");
  for (let i = 0; i < previous.receipts.length; i++) {
    const before = previous.receipts[i]!, after = next.receipts[i];
    if (!after || JSON.stringify(before.action) !== JSON.stringify(after.action) || JSON.stringify(before.before) !== JSON.stringify(after.before) ||
      before.state === "verified" && JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Cannot rewrite historical mutation receipts.");
  }
}
/** Strict append-only journal. No truncation repair or silently swallowed write errors.
 * A torn tail is uncertain input history and must be inspected, never replayed. */
export function readBagJournal(file: string): Entry[] {
  if (!existsSync(file)) return [];
  const contents = readFileSync(file, "utf8");
  if (contents && !contents.endsWith("\n")) throw new Error("Torn bag journal; mutation history requires inspection.");
  const entries: Entry[] = [];
  for (const line of contents.split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as Entry;
    validateBagSession(e.session);
    if (e.sequence !== entries.length || e.previous !== (entries.at(-1)?.hash ?? "") || e.hash !== hashEntry(e.sequence, e.previous, e.session)) throw new Error("Bag journal chain is corrupt.");
    assertHistory(entries.at(-1)?.session, e.session);
    entries.push(e);
  }
  return entries;
}
export function openBagJournal(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = openSync(file + ".lock", "wx");
  let fd: number | undefined, closed = false;
  try {
    const entries = readBagJournal(file);
    fd = openSync(file, "a");
    return {
      get latest(): BagSession | undefined { return entries.length ? structuredClone(entries.at(-1)!.session) : undefined; },
      save(session: BagSession) {
        if (closed) throw new Error("Bag journal is closed.");
        validateBagSession(session);
        assertHistory(entries.at(-1)?.session, session);
        const sequence = entries.length, previous = entries.at(-1)?.hash ?? "";
        const e: Entry = { sequence, previous, session: structuredClone(session), hash: hashEntry(sequence, previous, session) };
        const bytes = Buffer.from(JSON.stringify(e) + "\n");
        let written = 0;
        while (written < bytes.length) {
          const n = writeSync(fd!, bytes, written, bytes.length - written);
          if (n <= 0) throw new Error("Bag journal write did not progress.");
          written += n;
        }
        fsyncSync(fd!); entries.push(e);
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd!); closeSync(lock); unlinkSync(file + ".lock");
      },
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    closeSync(lock); unlinkSync(file + ".lock"); throw error;
  }
}
