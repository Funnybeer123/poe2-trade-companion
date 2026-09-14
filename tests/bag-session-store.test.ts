import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBagJournal, readBagJournal } from "../src/main/bagSessionStore.js";
import { session, simulator, weakText } from "./support/bagFixtures.js";
import { runBagStage } from "../src/core/bagSession.js";
const dirs: string[] = [];
const temporary = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "poe2-bag-journal-")); dirs.push(dir); return path.join(dir, "session.jsonl"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("durable bag mutation journal", () => {
  it("round trips originals and unique per-item receipts through independently reopened state", async () => {
    const file = temporary(), journal = openBagJournal(file), s = session([{ text: weakText(), row: 0, col: 1 }]);
    journal.save(s);
    const sim = simulator(s, { save: journal.save });
    const result = await runBagStage(s, "drop", sim.ports);
    journal.close();
    const opened = openBagJournal(file);
    expect(opened.latest).toEqual(result); opened.close();
    expect(readBagJournal(file)).toHaveLength(5);
    expect(readBagJournal(file)[1]!.session.receipts[0]!.state).toBe("pending");
  });
  it("refuses concurrent writers and changed originals", () => {
    const file = temporary(), journal = openBagJournal(file), s = session([]);
    journal.save(s);
    expect(() => openBagJournal(file)).toThrow();
    s.original.errors.push("changed");
    expect(() => journal.save(s)).toThrow("original"); journal.close();
  });
  it("does not allow a completed action receipt to be rewritten", async () => {
    const file = temporary(), journal = openBagJournal(file), s = session([{ text: weakText(), row: 0, col: 1 }]);
    journal.save(s);
    const sim = simulator(s, { save: journal.save });
    const result = await runBagStage(s, "drop", sim.ports);
    result.receipts[0]!.after!.evidence = "rewritten";
    expect(() => journal.save(result)).toThrow("historical"); journal.close();
  });
  it.each(["torn", "corrupt-hash", "invented-count"])("refuses %s history instead of assuming success", fault => {
    const file = temporary(), journal = openBagJournal(file); journal.save(session([])); journal.close();
    if (fault === "torn") appendFileSync(file, '{"incomplete":');
    else {
      const e = JSON.parse(readFileSync(file, "utf8"));
      if (fault === "corrupt-hash") e.hash = "untrusted";
      if (fault === "invented-count") e.session.droppedIds.push("unverified");
      writeFileSync(file, JSON.stringify(e) + "\n");
    }
    expect(() => readBagJournal(file)).toThrow();
    expect(() => openBagJournal(file)).toThrow();
  });
});
