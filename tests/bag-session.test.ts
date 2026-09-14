import { describe, expect, it } from "vitest";
import { bagDecision, captureBagLedger, captureBagObservations, eligibleBagEquipment, wisdomCount } from "../src/core/bagAssessment.js";
import { runBagStage, validateBagSession, type BagObservationRequest } from "../src/core/bagSession.js";
import { parseBagTriageArgs } from "../src/core/bagTriageArgs.js";
import { batch, text, strongText, AT } from "./support/batchFixtures.js";
import { scene, session, simulator, unid, weakText, wisdom } from "./support/bagFixtures.js";

describe("complete physical bag capture and shared decision parity", () => {
  it("captures all 60 cells, keeps touching identical copies distinct and records dim/unread cells", () => {
    const s = session([{ text: wisdom(), row: 0, col: 0 }, { text: weakText(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 },
      { text: text([], { itemClass: "Body Armours" }), row: 1, col: 1 }]);
    expect(s.report.capture?.complete).toBe(true);
    expect(s.report.rows).toHaveLength(4);
    expect(new Set(s.report.rows.map(r => r.id)).size).toBe(4);
    expect(s.report.rows.find(r => r.itemClass === "Body Armours")?.cells).toHaveLength(6);
    const cells = structuredClone(s.scene.cells); cells[59]!.state = "unread";
    const incomplete = captureBagObservations("partial", cells, undefined, AT);
    expect(incomplete.unreadCells).toHaveLength(1);
    expect(incomplete.rows.every(row => bagDecision(row, incomplete).action !== "drop")).toBe(true);
  });
  it("does not merge touching same-class 2×2 items or collapse a partial footprint", () => {
    const t = text([], { itemClass: "Boots" });
    const s = session([{ text: t, row: 1, col: 0 }, { text: t, row: 1, col: 2 }]);
    expect(s.report.rows).toHaveLength(2);
    expect(s.report.rows.every(r => r.cells?.length === 4)).toBe(true);
    const partial = scene([{ text: t, row: 1, col: 0, w: 1, h: 1 }]);
    expect(captureBagObservations("partial", partial.cells, undefined, AT).capture?.complete).toBe(false);
  });
  it("reconciles the same physical identities without creating assessment history", () => {
    const observed = scene([{ text: wisdom(), row: 0, col: 0 }, { text: weakText(), row: 0, col: 1 },
      { text: weakText(), row: 0, col: 2 }, { text: text([], { itemClass: "Boots" }), row: 1, col: 0 }]);
    const ledger = captureBagLedger("scan", observed.cells, undefined, AT);
    const assessed = captureBagObservations("scan", observed.cells, undefined, AT);
    const identities = (report: typeof ledger) => report.rows.map(row => ({ id: row.id, rawText: row.rawText, cells: row.cells }));
    expect(identities(ledger)).toEqual(identities(assessed));
    expect(ledger.capture).toEqual(assessed.capture);
    expect(ledger.assessmentHistory).toBeUndefined();
    expect(ledger.rows.every(row => row.assessment === undefined)).toBe(true);
  });
  it.each(["missing", "stale", "empty-copy", "cross-item", "invalid-cell", "duplicate-cell"])("rejects or retains %s coverage", fault => {
    const s = scene([{ text: weakText(), row: 0, col: 1 }]);
    if (fault === "missing") s.cells.pop();
    if (fault === "stale") s.cells[1]!.confirmation = "sentinel";
    if (fault === "empty-copy") s.cells[1]!.rawText = "";
    if (fault === "cross-item") s.cells[1]!.confirmation = strongText();
    if (fault === "invalid-cell") s.cells[1]!.row = -1;
    if (fault === "duplicate-cell") s.cells[1] = s.cells[0]!;
    if (["invalid-cell", "duplicate-cell"].includes(fault)) expect(() => captureBagObservations("bad", s.cells)).toThrow();
    else expect(captureBagObservations("bad", s.cells).capture?.complete).toBe(false);
  });
  it("protects non-equipment, supported crafting bases, uniques and unfamiliar modifiers", () => {
    const texts = [wisdom(), text([], { itemClass: "Waystones", status: "Unidentified" }), text([], { itemClass: "Tablets", status: "Unidentified" }),
      text([], { itemClass: "Uncut Skill Gems" }), text([], { itemClass: "Mystery Class", status: "Unidentified" }),
      text([], { rarity: "Normal", base: "Unset Ring" }), text(["Unsampled effect"], { rarity: "Unique" }),
      text(["Unsampled effect"]), strongText()];
    for (const raw of texts) {
      const s = session([{ text: raw, row: 0, col: 1 }]);
      expect(bagDecision(s.report.rows[0]!, s.report, AT).action).not.toBe("drop");
    }
    for (const raw of texts.slice(0, 5)) expect(eligibleBagEquipment(raw)).toBe(false);
  });
  it("does not use historical stash positions or routing status as drop authority", () => {
    const historical = batch([weakText(), strongText()]);
    expect(historical.rows.every(r => bagDecision(r, historical, AT).action !== "drop")).toBe(true);
    const s = session([{ text: weakText(), row: 0, col: 1 }]);
    const r = s.report.rows[0]!;
    expect(bagDecision(r, s.report, AT).action).toBe("drop");
    for (const override of ["keep", "review"] as const) {
      s.report.settings.feedback = { [r.id]: override };
      expect(bagDecision(r, s.report, AT).action).toBe(override);
    }
  });
  it("keeps strict fresh market evidence, while failed/expired pricing cannot convert Review", () => {
    const s = session([{ text: weakText(), row: 0, col: 1 }, { text: text(["Unknown effect"]), row: 0, col: 2 }]);
    const quote = { ...s.report.rows[0]!.quote, state: "priced" as const, patch: s.report.rows[0]!.assessment!.patch,
      low: 2, fair: 3, high: 4, sampleSize: 12, candidateCount: 12, confidence: 95, fetchedAt: AT, validUntil: "2026-09-14T13:00:00Z" };
    s.report.rows[0]!.quote = quote;
    expect(bagDecision(s.report.rows[0]!, s.report, AT).action).toBe("keep");
    for (const state of ["unavailable", "no-comparables", "unsupported"] as const) {
      s.report.rows[1]!.quote.state = state;
      expect(bagDecision(s.report.rows[1]!, s.report, AT).action).toBe("review");
    }
    s.report.rows[0]!.quote.validUntil = "2026-09-13T13:00:00Z";
    // A complete independent Low-priority decision remains local evidence, never price evidence.
    expect(bagDecision(s.report.rows[0]!, s.report, AT).action).toBe("drop");
  });
});

describe("per-item identification, dropping and restart receipts", () => {
  const mixed = () => session([{ text: wisdom(2), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 },
    { text: unid(), row: 0, col: 2 }, { text: strongText(), row: 0, col: 3 }, { text: text(["Unknown effect"]), row: 0, col: 4 }]);
  it("uses one scroll per physical item, preserves originals and completes separate bounded stages", async () => {
    const original = mixed(), sim = simulator(original);
    const identified = await runBagStage(original, "identify", sim.ports);
    expect(identified.identifiedIds).toHaveLength(2);
    expect(identified.original).toEqual(original.original);
    expect(identified.report.rows[0]!.quantity).toBe(0);
    expect(identified.report.assessmentHistory).toHaveLength(3);
    const drops = simulator(identified);
    const result = await runBagStage(identified, "drop", drops.ports, 1);
    expect(result.droppedIds).toHaveLength(1);
    expect(drops.actions.map(a => a.kind)).toEqual(["pickup", "drop"]);
    expect(result.receipts.every(r => r.state === "verified" && r.after)).toBe(true);
    const resumed = simulator(result);
    const done = await runBagStage(result, "drop", resumed.ports, 10);
    expect(done.droppedIds).toHaveLength(2);
    expect(resumed.actions).toHaveLength(2);
    expect(done.report.rows).toHaveLength(5); // Departures remain in the local ledger.
    validateBagSession(done);
  });
  it("bounds identification to one physical item and resumes without repeating it", async () => {
    const initial = mixed(), sim = simulator(initial);
    const requests: BagObservationRequest[] = [];
    const first = await runBagStage(initial, "identify", { ...sim.ports, observe: async request => {
      requests.push(request!); return sim.ports.observe(request);
    } }, { maxIdentifications: 1 });
    expect(first.identifiedIds).toEqual([initial.report.rows[1]!.id]);
    expect(sim.actions.map(action => [action.kind, action.cell])).toEqual([
      ["arm", { row: 0, col: 0 }], ["identify", { row: 0, col: 1 }],
    ]);
    expect(requests.map(request => request.phase)).toEqual(["before", "after", "after"]);
    expect(requests.every(request => request.itemId === initial.report.rows[1]!.id &&
      request.rawText === unid() && request.cells?.[0]?.col === 1)).toBe(true);
    expect(requests.at(-1)?.action?.kind).toBe("identify");
    const resumed = simulator(first);
    const second = await runBagStage(first, "identify", resumed.ports, { maxIdentifications: 1 });
    expect(second.identifiedIds).toHaveLength(2);
    expect(resumed.actions[1]?.cell).toEqual({ row: 0, col: 2 });
    validateBagSession(second);
    const invalid = structuredClone(second);
    invalid.receipts[0]!.action.cell.col = 1;
    expect(() => validateBagSession(invalid)).toThrow("action history");
  });
  it.each([-1, 1.5, 60, Number.NaN])("rejects invalid identification limit %s before observation or input", async maxIdentifications => {
    const initial = mixed(), sim = simulator(initial);
    await expect(runBagStage(initial, "identify", sim.ports, { maxIdentifications })).rejects.toThrow("max-identifications");
    expect(sim.actions).toHaveLength(0);
  });
  it("a zero identification limit emits no input and preserves the bag", async () => {
    const initial = mixed(), sim = simulator(initial);
    expect(await runBagStage(initial, "identify", sim.ports, { maxIdentifications: 0 })).toEqual(initial);
    expect(sim.actions).toHaveLength(0);
  });
  it.each(["missing", "wrong", "zero", "malformed"])("does not spend an unverified %s Wisdom stack", async fault => {
    const raw = fault === "wrong" ? wisdom().replace("Scroll of Wisdom", "Chaos Orb") : fault === "zero" ? wisdom(0) : wisdom().replace("Stack Size:", "Stack:");
    const s = session([...(fault === "missing" ? [] : [{ text: raw, row: 0, col: 0 }]), { text: unid(), row: 0, col: 1 }]);
    const sim = simulator(s);
    await expect(runBagStage(s, "identify", sim.ports)).rejects.toThrow("Wisdom");
    expect(sim.actions).toHaveLength(0);
    expect(wisdomCount(raw)).toBeUndefined();
  });
  it("with a short stack identifies exactly one, and never reidentifies that item", async () => {
    const s = mixed();
    s.report.rows[0]!.rawText = wisdom(1); s.report.rows[0]!.quantity = 1;
    s.scene.cells[0]!.rawText = wisdom(1); s.scene.cells[0]!.confirmation = wisdom(1);
    const sim = simulator(s);
    const first = await runBagStage(s, "identify", sim.ports);
    expect(first.identifiedIds).toHaveLength(1);
    const next = simulator(first);
    await expect(runBagStage(first, "identify", next.ports)).rejects.toThrow("Wisdom");
    expect(next.actions).toHaveLength(0);
  });
  it.each(["missed-arm", "no-change", "wrong-item", "scroll-not-consumed", "cursor-held", "moved-neighbor"])("stops after %s without blind retries or drops", async fault => {
    const s = mixed();
    const sim = simulator(s, { mutate(action, observed) {
      if (action.kind === "arm" && fault === "missed-arm") observed.cursor.state = "empty";
      if (action.kind !== "identify") return;
      if (fault === "no-change") { observed.cells[1]!.rawText = unid(); observed.cells[1]!.confirmation = unid(); }
      if (fault === "wrong-item") { observed.cells[1]!.rawText = weakText().replace("Ruby Ring", "Iron Ring"); observed.cells[1]!.confirmation = observed.cells[1]!.rawText; }
      if (fault === "scroll-not-consumed") { observed.cells[0]!.rawText = wisdom(2); observed.cells[0]!.confirmation = wisdom(2); }
      if (fault === "cursor-held") observed.cursor.state = "item";
      if (fault === "moved-neighbor") { observed.cells[3]!.rawText = weakText(); observed.cells[3]!.confirmation = weakText(); }
    } });
    await expect(runBagStage(s, "identify", sim.ports)).rejects.toThrow();
    expect(sim.actions.length).toBeLessThanOrEqual(2);
    expect(sim.latest.receipts.at(-1)?.state).toBe("pending");
    await expect(runBagStage(sim.latest, "drop", sim.ports)).rejects.toThrow("reconciliation");
  });
  it.each(["town", "hideout", "unknown", "focus", "modal", "death", "loading", "transition", "ground", "cursor", "stale", "calibration"])("refuses %s before pickup", async fault => {
    const s = session([{ text: weakText(), row: 0, col: 1 }]), sim = simulator(s), scene = sim.current;
    if (["town", "hideout", "unknown"].includes(fault)) scene.context = fault as "town";
    if (fault === "focus") scene.foreground = false;
    if (fault === "modal") scene.obstructed = true;
    if (fault === "death") scene.alive = false;
    if (fault === "loading") scene.loading = true;
    if (fault === "transition") scene.mapInstance += "changed";
    if (fault === "ground") scene.ground.valid = false;
    if (fault === "cursor") scene.cursor.state = "unknown";
    if (fault === "stale") scene.at = "2026-09-14T11:00:00Z";
    if (fault === "calibration") scene.calibration += "changed";
    await expect(runBagStage(s, "drop", sim.ports)).rejects.toThrow();
    expect(sim.actions).toHaveLength(0);
  });
  it.each(["pickup-failed", "wrong-held", "held-after-drop", "no-ground-receipt", "old-label"])("stops on %s with an honest pending receipt", async fault => {
    const s = session([{ text: weakText(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }]);
    const sim = simulator(s, { mutate(a, observed) {
      if (a.kind === "pickup" && fault === "pickup-failed") observed.cursor.state = "empty";
      if (a.kind === "pickup" && fault === "wrong-held") observed.cursor.rawText = strongText();
      if (a.kind === "drop" && fault === "held-after-drop") observed.cursor.state = "item";
      if (a.kind === "drop" && fault === "no-ground-receipt") delete observed.groundReceipt;
      if (a.kind === "drop" && fault === "old-label") observed.groundReceipt!.actionId = "previous-action";
    } });
    await expect(runBagStage(s, "drop", sim.ports, 59)).rejects.toThrow();
    expect(sim.actions.length).toBeLessThanOrEqual(2);
    expect(sim.latest.droppedIds).toHaveLength(0);
  });
  it("does not hide a middle-drop failure behind first/last success", async () => {
    const s = session(Array.from({ length: 3 }, (_, i) => ({ text: weakText(), row: 0, col: i + 1 })));
    const sim = simulator(s, { mutate(a, observed, actions) {
      if (a.kind === "drop" && actions.filter(a => a.kind === "drop").length === 2) observed.cursor.state = "item";
    } });
    await expect(runBagStage(s, "drop", sim.ports, 59)).rejects.toThrow();
    expect(sim.latest.droppedIds).toHaveLength(1);
    expect(sim.actions).toHaveLength(4);
  });
  it("reconciles a crash after identification without spending another scroll", async () => {
    const s = mixed();
    const sim = simulator(s, { save(current) { if (current.identifiedIds.length) throw new Error("disk failure after identify"); } });
    await expect(runBagStage(s, "identify", sim.ports)).rejects.toThrow("disk failure");
    const restarted = simulator(sim.latest); restarted.current = sim.current;
    const result = await runBagStage(sim.latest, "reconcile", restarted.ports);
    expect(result.identifiedIds).toHaveLength(1); expect(restarted.actions).toHaveLength(0);
  });
  it("reconciles a crash after ground release only with that action's ground receipt", async () => {
    const s = session([{ text: weakText(), row: 0, col: 1 }]);
    const sim = simulator(s, { save(current) { if (current.droppedIds.length) throw new Error("disk failure after drop"); } });
    await expect(runBagStage(s, "drop", sim.ports)).rejects.toThrow("disk failure");
    const resumed = simulator(sim.latest); resumed.current = sim.current;
    const result = await runBagStage(sim.latest, "reconcile", resumed.ports);
    expect(result.droppedIds).toHaveLength(1); expect(resumed.actions).toHaveLength(0);
  });
  it("journal failure before pending input prevents the input", async () => {
    const s = mixed(), sim = simulator(s, { save() { throw new Error("disk full"); } });
    await expect(runBagStage(s, "identify", sim.ports)).rejects.toThrow("disk full");
    expect(sim.actions).toHaveLength(0);
  });
  it("does not emit a mutation if a durable journal flush ages its observation", async () => {
    let now = AT;
    const initial = mixed(), sim = simulator(initial, { save() { now = new Date(Date.parse(AT) + 2001).toISOString(); } });
    await expect(runBagStage(initial, "identify", { ...sim.ports, now: () => now })).rejects.toThrow("stale");
    expect(sim.actions).toHaveLength(0);
    expect(sim.latest.receipts.at(-1)?.state).toBe("pending");
  });
  it.each(["arm", "pickup"])("does not repeat an interrupted verified %s transaction after restart", async kind => {
    const s = kind === "arm" ? mixed() : session([{ text: weakText(), row: 0, col: 1 }]);
    const sim = simulator(s, { save(current) {
      if (current.receipts.length === 2) throw new Error("crash before next mutation");
    } });
    await expect(runBagStage(s, kind === "arm" ? "identify" : "drop", sim.ports)).rejects.toThrow("crash");
    expect(sim.latest.receipts.at(-1)?.state).toBe("verified");
    const restart = simulator(sim.latest);
    const refused = kind === "arm" ? ["drop", "reconcile"] as const : ["identify", "drop", "reconcile"] as const;
    for (const stage of refused) await expect(runBagStage(sim.latest, stage, restart.ports)).rejects.toThrow("operator inspection");
    expect(restart.actions).toHaveLength(0);
    if (kind === "arm") {
      const done = await runBagStage(sim.latest, "identify", restart.ports, { maxIdentifications: 1 });
      expect(done.identifiedIds).toHaveLength(1);
      expect(restart.actions.map(action => action.kind)).toEqual(["identify"]);
    }
  });
  it("reconciles an initially unreadable Wisdom cursor, then identifies only its original target without rearming", async () => {
    const initial = mixed(), sim = simulator(initial, { mutate(action, observed) {
      if (action.kind === "arm") observed.cursor.state = "unknown";
    } });
    await expect(runBagStage(initial, "identify", sim.ports)).rejects.toThrow("cursor");
    expect(sim.actions.map(action => action.kind)).toEqual(["arm"]);
    const restart = simulator(sim.latest);
    restart.current.cursor = { state: "wisdom", evidence: "synthetic:verified-wisdom-cursor" };
    const armed = await runBagStage(sim.latest, "reconcile", restart.ports);
    expect(armed.receipts.at(-1)?.state).toBe("verified");
    expect(restart.actions).toHaveLength(0);
    const resumed = simulator(armed);
    const done = await runBagStage(armed, "identify", resumed.ports, { maxIdentifications: 1 });
    expect(resumed.actions.map(action => [action.kind, action.itemId])).toEqual([["identify", initial.report.rows[1]!.id]]);
    expect(done.identifiedIds).toEqual([initial.report.rows[1]!.id]);
    expect(done.report.rows[0]!.quantity).toBe(1);
    validateBagSession(done);
  });
  it.each(["cursor", "target", "neighbor", "scroll", "map"])("refuses armed continuation after changed %s evidence without generating recovery input", async fault => {
    const initial = mixed(), sim = simulator(initial, { save(current) {
      if (current.receipts.length === 2) throw new Error("crash before identify");
    } });
    await expect(runBagStage(initial, "identify", sim.ports)).rejects.toThrow("crash");
    const resumed = simulator(sim.latest);
    if (fault === "cursor") resumed.current.cursor.state = "empty";
    if (fault === "map") resumed.current.mapInstance += "changed";
    if (["target", "neighbor", "scroll"].includes(fault)) {
      const cell = resumed.current.cells[fault === "target" ? 1 : fault === "neighbor" ? 3 : 0]!;
      cell.rawText = fault === "scroll" ? wisdom(1) : weakText(); cell.confirmation = cell.rawText;
    }
    await expect(runBagStage(sim.latest, "identify", resumed.ports, { maxIdentifications: 1 })).rejects.toThrow();
    expect(resumed.actions).toHaveLength(0);
  });
  it("honors stop at every checkpoint with no automatic recovery input", async () => {
    for (let stop = 1; stop <= 8; stop++) {
      const s = session([{ text: weakText(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }]);
      let actionsAtStop = -1;
      const sim = simulator(s, { checkpoint(n) { if (n === stop) { actionsAtStop = sim.actions.length; throw new Error("emergency-stop"); } } });
      await expect(runBagStage(s, "drop", sim.ports, 59)).rejects.toThrow("emergency-stop");
      expect(sim.actions).toHaveLength(actionsAtStop);
    }
  });
});

describe("strict offline/live argument boundary", () => {
  it.each(["--max-drops=NaN", "--max-drops=-1", "--max-drops=1.5", "--max-drops=60", "--typo", "--calibrate-moves", "--careful", "--keep-unknown", "--drop-x=100"])("rejects %s before adapters", arg => {
    expect(() => parseBagTriageArgs(["--stage=drop", "--journal=fixture", "--run", arg])).toThrow();
  });
  it("rejects conflicting inputs, duplicate flags, implicit mutation and wrong stage options", () => {
    for (const args of [["--run", "--replay=file"], ["--run", "--run"], ["--stage=identify"], ["--from-scan=x", "--run"],
      ["--stage=identify", "--journal=x"], ["--stage=reconcile", "--journal=x", "--run"], ["--max-drops=1"]]) expect(() => parseBagTriageArgs(args)).toThrow();
    expect(parseBagTriageArgs(["--from-scan=x"]).stage).toBe("assess");
    expect(parseBagTriageArgs(["--stage=drop", "--journal=x", "--replay=y"]).maxDrops).toBe(1);
  });
  it.each(["NaN", "0", "-1", "1.5", "60", "1e1", "Infinity"])("rejects invalid identification limit %s before adapters", value => {
    expect(() => parseBagTriageArgs(["--stage=identify", "--journal=x", "--run", "--max-identifications=" + value])).toThrow("max-identifications");
  });
  it("defaults live identification to one item and confines live file flags to live stages", () => {
    const base = ["--stage=identify", "--journal=x", "--run"];
    expect(parseBagTriageArgs(base).maxIdentifications).toBe(1);
    expect(parseBagTriageArgs([...base, "--max-identifications=59"]).maxIdentifications).toBe(59);
    for (const stage of ["capture", "drop", "reconcile"]) {
      expect(() => parseBagTriageArgs(["--stage=" + stage, "--journal=x", "--max-identifications=1"])).toThrow("only to the identify stage");
    }
    for (const flag of ["--calibration", "--perception", "--client-log"]) {
      expect(() => parseBagTriageArgs(["--stage=capture", "--replay=x", flag + "=fixture"])).toThrow("offline assessment/replay");
      expect(() => parseBagTriageArgs(["--from-scan=x", flag + "=fixture"])).toThrow("offline assessment/replay");
      expect(parseBagTriageArgs([...base, flag + "=fixture"]).stage).toBe("identify");
    }
  });
});
