import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveWinHostScript } from "../src/adapters/winHost.js";
import { confirmOk } from "../src/core/followerConfirm.js";

// Static checks on the native worker's source: it is never started here, so no input is sent.
const source = readFileSync(resolveWinHostScript("win-follower-input-host.ps1"), "utf8");
const synthetic = readFileSync(new URL("../scripts/test-follower-input-host.ps1", import.meta.url), "utf8");
const between = (from: string, to: string) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  expect(start, from).toBeGreaterThanOrEqual(0); expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
};
const sprint = () => between("public static void Sprint(", "static void NoteHuman(");
const order = (text: string, ...parts: string[]) => parts.map(part => { const at = text.indexOf(part); expect(at, part).toBeGreaterThanOrEqual(0); return at; });
// The bounds every rectangle check below uses come out of the source, so a changed constant changes what is asserted.
const fraction = (text: string, pattern: RegExp) => { const found = text.match(pattern); expect(found, String(pattern)).not.toBeNull(); return Number(found![1]); };
// .NET Math.Round is half to even; the host rounds these same fractions.
const round = (n: number) => { const floor = Math.floor(n), rest = n - floor; return rest > .5 ? floor + 1 : rest < .5 ? floor : floor % 2 ? floor + 1 : floor; };
const VIEWS: [number, number][] = [[2560, 1440], [1920, 1080], [3440, 1440], [1280, 800], [320, 240]];

describe("follower input host: sprint hold", () => {
  it("takes a start flag from the sprint op", () => {
    expect(source).toContain("public static void Sprint(string expectedHwnd, int viewWidth, int viewHeight, long capturedAtQpcMs, int maxAgeMs, bool start)");
    expect(source).toMatch(/\[FollowInput\]::Sprint\([^\n]*\[int\]\$command\.maxAgeMs, \(\$command\.start -eq \$true\)\)/);
  });
  it("presses space in exactly one place, and only when nothing is held and the request is a start", () => {
    expect(source.match(/Space\(true\)/g)).toHaveLength(1);
    const body = sprint(), gate = body.slice(body.lastIndexOf("lock (sprintGate)"));
    const at = order(gate, "if (!spaceHeld) {", 'if (!start) throw new Exception("Sprint lapsed");', 'if (Down(0x20)) throw new Exception("Space held - manual control");', "Space(true)", "spaceHeld = true;", "spaceDeadline = QpcMs() + SprintRenewMs;");
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // An already held key only has its deadline renewed: the deadline line sits outside the not-held block.
    expect(gate.slice(at[4], at[5])).toContain("}");
  });
  it("refuses a renew of a lapsed hold before any window or key check, with the exact error the loop expects", () => {
    const body = sprint();
    const [early, check] = order(body, 'if (!start) lock (sprintGate) { if (!spaceHeld) throw new Exception("Sprint lapsed"); }', "FollowClickCheck check");
    expect(early).toBeLessThan(check);
    expect(source.match(/"Sprint lapsed"/g)).toHaveLength(2);
  });
  it("checks the space key only while the worker holds nothing, never as a general human-input guard", () => {
    expect(source.match(/0x20\b/g)).toHaveLength(2); // Space()'s virtual key and the first-press check
    expect(between("static void ThrowIfHumanInput()", "// Pure request validation")).not.toContain("0x20");
    expect(source).toContain('"Space held - manual control"');
  });
  it("lets go on any sprint refusal, and the watchdog checks and releases under one lock", () => {
    expect(sprint()).toMatch(/\} catch \{ ReleaseSprint\(\); throw; \}\s*\}\s*$/);
    expect(source).toContain("lock (sprintGate) { expired = spaceHeld && QpcMs() > spaceDeadline; if (expired) ReleaseSprint(); }");
  });
});

describe("follower input host: movement click refusals", () => {
  it("runs the whole click inside one guard that releases sprint before rethrowing", () => {
    const wrapper = between("public static void MoveClick(", "static void GuardedClick(");
    expect(wrapper).toMatch(/\{\s*try \{ GuardedClick\(x, y, expectedHwnd, viewWidth, viewHeight, capturedAtQpcMs, maxAgeMs, area\); \} catch \{ ReleaseSprint\(\); throw; \}\s*\}\s*$/);
    expect(source.match(/\bGuardedClick\(/g)).toHaveLength(2);
  });
  it("keeps every refusal and both input calls inside the guarded body", () => {
    const body = between("static void GuardedClick(", "'@");
    for (const refusal of ["throw new Exception(check.Error)", '"Manual mouse movement"', '"Game is covered at the click point"', '"Stale capture"', '"Windows split the movement click"', "ThrowIfHumanInput();"]) expect(body).toContain(refusal);
    expect(body).toContain("SendInput(2, new [] { Button(true), Button(false) }, size)");
    expect(source.match(/Button\(true\)/g)).toHaveLength(1);
    expect(between("public static void MoveClick(", "static void GuardedClick(")).not.toMatch(/SendInput|SetCursorPos/);
  });
  it("keeps the dispatcher signature for moveclick", () => {
    expect(source).toContain("public static void MoveClick(int x, int y, string expectedHwnd, int viewWidth, int viewHeight, long capturedAtQpcMs, int maxAgeMs, string area)");
  });
});

describe("follower input host: party-frame travel button", () => {
  // Measured on real 2560x1440 frames: the blue swirl occupies x 11..38, y 322..349 for the first party member.
  const BUTTON = { left: 11, top: 322, right: 38, bottom: 349 };
  const party = () => between('if (area == "party") {', 'if (area == "confirm")');
  const rect = () => ({
    top: fraction(party(), /y < Math\.Round\(viewHeight \* (0\.\d+)\)/),
    right: fraction(party(), /x >= Math\.Round\(viewWidth \* (0\.\d+)\)/),
    bottom: fraction(party(), /y >= Math\.Round\(viewHeight \* (0\.\d+)\)/),
  });
  const box = (width: number, height: number) => { const r = rect(); return { minX: 0, maxX: round(width * r.right) - 1, minY: round(height * r.top), maxY: round(height * r.bottom) - 1 }; };
  const accepts = (x: number, y: number, width = 2560, height = 1440) => { const b = box(width, height); return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY; };

  it("is a tight rectangle high on the left edge, refused by name outside it", () => {
    expect(rect()).toEqual({ top: .16, right: .035, bottom: .50 });
    expect(party()).toContain('result.Error = "Click outside the party frame area"');
    expect(box(2560, 1440)).toEqual({ minX: 0, maxX: 89, minY: 230, maxY: 719 });
    expect(party()).toContain("x < 0 ||"); // x alone can be negative: its upper bound is a positive fraction
  });
  it("covers the whole measured button and a few more members stacked below it", () => {
    for (const [x, y] of [[BUTTON.left, BUTTON.top], [BUTTON.right, BUTTON.bottom], [BUTTON.left, BUTTON.bottom], [BUTTON.right, BUTTON.top], [25, 336]]) expect(accepts(x, y), `${x},${y}`).toBe(true);
    // Entries stack downward from the first; 1440p leaves room for several more below its button.
    expect(box(2560, 1440).maxY - BUTTON.bottom).toBeGreaterThan(300);
    for (const [width, height] of VIEWS) { const b = box(width, height); expect(b.maxY, `${width}x${height}`).toBeGreaterThan(b.minY + height * .2); }
  });
  it("refuses an unknown area, and matches only the exact string party", () => {
    expect(source).toContain('if (area != "move") { result.Error = "Unknown click area"; return result; }');
    const [loot, partyAt, unknown] = order(between("public static FollowClickCheck Check(int x, int y, int viewWidth, int viewHeight, long ageMs, int maxAgeMs, string area)", "// Pure manual-takeover rule"), 'if (area == "loot")', 'if (area == "party") {', '"Unknown click area"');
    expect(loot).toBeLessThan(partyAt); expect(partyAt).toBeLessThan(unknown);
    expect(party()).not.toMatch(/StartsWith|Contains|IndexOf/); // no prefix match: "partyx" still falls through to the refusal
  });
  it("reaches neither the movement disc, the loot area nor the rest of the UI", () => {
    const limit = fraction(source, /limit = viewHeight \* (0\.\d+);/), lootLeft = fraction(between('if (area == "loot")', 'if (area == "party")'), /x < Math\.Round\(viewWidth \* (0\.\d+)\)/);
    for (const [width, height] of VIEWS) {
      const b = box(width, height), where = `${width}x${height}`;
      // Nearest approach to the disc: the party box is left of centre and spans the centre row, so the gap is in x alone.
      expect(width / 2 - b.maxX, where).toBeGreaterThan(height * limit);
      expect(b.maxX, where).toBeLessThan(round(width * lootLeft)); // never borrows a loot click's rectangle
      expect(b.maxY, where).toBeLessThan(height * .55); // stays above the chat panel and the flask row
    }
    for (const [x, y] of [[25, 229], [25, 720], [90, 336], [-1, 336], [1280, 720], [2048, 600], [255, 336]]) expect(accepts(x, y), `${x},${y}`).toBe(false);
  });
});

describe("follower input host: teleport confirmation OK button", () => {
  // Measured on the real 2560x1440 capture of the dialog: OK spans x 1595..1870, y 728..800, centre (1732, 764).
  // CANCEL is the other button, left of centre at (948, 764), and clicking it would cancel the teleport.
  const OK = { left: 1595, top: 728, right: 1870, bottom: 800 }, CANCEL = { x: 948 / 2560, y: 764 / 1440 };
  const confirm = () => between('if (area == "confirm") {', 'if (area != "move")');
  const rect = () => ({
    left: fraction(confirm(), /x < Math\.Round\(viewWidth \* (0\.\d+)\)/),
    top: fraction(confirm(), /y < Math\.Round\(viewHeight \* (0\.\d+)\)/),
    right: fraction(confirm(), /x >= Math\.Round\(viewWidth \* (0\.\d+)\)/),
    bottom: fraction(confirm(), /y >= Math\.Round\(viewHeight \* (0\.\d+)\)/),
  });
  const box = (width: number, height: number) => { const r = rect(); return { minX: round(width * r.left), maxX: round(width * r.right) - 1, minY: round(height * r.top), maxY: round(height * r.bottom) - 1 }; };
  const accepts = (x: number, y: number, width = 2560, height = 1440) => { const b = box(width, height); return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY; };

  it("is a tight box around the measured OK button, refused by name outside it", () => {
    expect(rect()).toEqual({ left: .61, top: .49, right: .745, bottom: .57 });
    expect(box(2560, 1440)).toEqual({ minX: 1562, maxX: 1906, minY: 706, maxY: 820 });
    expect(confirm()).toContain('result.Error = "Click outside the confirm dialog area"');
    for (const [x, y] of [[OK.left, OK.top], [OK.right, OK.bottom], [OK.left, OK.bottom], [OK.right, OK.top], [1732, 764]]) expect(accepts(x, y), `${x},${y}`).toBe(true);
    // Tight: at most a button's own height of margin on any side of the measured button.
    const b = box(2560, 1440), height = OK.bottom - OK.top;
    for (const margin of [OK.left - b.minX, b.maxX - OK.right, OK.top - b.minY, b.maxY - OK.bottom]) { expect(margin).toBeGreaterThan(8); expect(margin).toBeLessThan(height); }
  });

  it("cannot contain CANCEL at any view size, because it starts right of it", () => {
    // Structural, not arithmetic: the box begins at a fraction of width larger than CANCEL's own.
    expect(rect().left).toBeGreaterThan(CANCEL.x);
    for (const [width, height] of VIEWS) {
      const b = box(width, height), cancel = { x: round(width * CANCEL.x), y: round(height * CANCEL.y) }, where = `${width}x${height}`;
      expect(accepts(cancel.x, cancel.y, width, height), where).toBe(false);
      expect(b.minX - cancel.x, where).toBeGreaterThan(width * .2); // and never within a fifth of the view of it
    }
    for (const [x, y] of [[948, 764], [1280, 720], [1732, 900], [1732, 600], [2048, 764], [25, 336]]) expect(accepts(x, y), `${x},${y}`).toBe(false);
  });

  it("permits exactly the point the detector aims at, and nothing the party frame owns", () => {
    const partyRight = fraction(between('if (area == "party") {', 'if (area == "confirm")'), /x >= Math\.Round\(viewWidth \* (0\.\d+)\)/);
    expect(rect().left).toBeGreaterThan(partyRight);
    for (const [width, height] of VIEWS) {
      const ok = confirmOk({ width, height }), where = `${width}x${height}`;
      expect(accepts(ok.x, ok.y, width, height), where).toBe(true);
      expect(box(width, height).minX, where).toBeGreaterThan(round(width * partyRight) - 1); // clear of the party box
    }
  });

  it("refuses an unknown area, and matches only the exact string confirm", () => {
    const [loot, party, confirmAt, unknown] = order(between("public static FollowClickCheck Check(int x, int y, int viewWidth, int viewHeight, long ageMs, int maxAgeMs, string area)", "// Pure manual-takeover rule"), 'if (area == "loot")', 'if (area == "party") {', 'if (area == "confirm") {', '"Unknown click area"');
    expect([loot, party, confirmAt, unknown]).toEqual([loot, party, confirmAt, unknown].sort((a, b) => a - b));
    expect(source).toContain('if (area != "move") { result.Error = "Unknown click area"; return result; }');
    expect(confirm()).not.toMatch(/StartsWith|Contains|IndexOf/); // "confirmation" falls through to the refusal
    expect(confirm()).not.toMatch(/SendInput|SetCursorPos/); // an area check decides nothing but ok or the error
  });
});

describe("follower input host: synthetic native checks", () => {
  it("cover the lapsed renew and a refused click without sending input", () => {
    expect(synthetic).toContain("[FollowInput]::Sprint('0', 2560, 1440, [FollowInput]::QpcMs(), 120, $false) } 'Sprint lapsed'");
    expect(synthetic).toContain("[FollowInput]::QpcMs() - 1000, 120, 'move') } 'Stale capture'");
    // Never a start from the test script: that is the only call that can press a key.
    expect(synthetic).not.toMatch(/::Sprint\([^)]*\$true\)/);
    expect(synthetic).toContain("Space may go down only on a start, and never over a human hold");
  });
  it("check the party and confirm rectangles without ever running a click that could be accepted", () => {
    expect(synthetic).toContain("ExpectParty 25 336 $null");
    expect(synthetic).toContain("[FollowInput]::QpcMs(), 120, 'party') } 'Click outside the party frame area'");
    // An accepted click of either kind would move the cursor and press the button, so only refusals run natively.
    expect(synthetic).toContain("ExpectConfirm 1732 764 $null");
    expect(synthetic).toContain("ExpectConfirm 948 764 'Click outside the confirm dialog area'");
    expect(synthetic).toContain("[FollowInput]::MoveClick(948, 764, '0', 2560, 1440, [FollowInput]::QpcMs(), 120, 'confirm') } 'Click outside the confirm dialog area'");
    const clicks = synthetic.split("\n").filter(line => line.includes("::MoveClick("));
    expect(clicks).toHaveLength(3);
    for (const line of clicks) expect(line.trimStart(), line).toMatch(/^ExpectRefusal \{/);
  });
});
