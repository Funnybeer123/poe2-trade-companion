import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveWinHostScript } from "../src/adapters/winHost.js";

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
  const VIEWS: [number, number][] = [[2560, 1440], [1920, 1080], [3440, 1440], [1280, 800], [320, 240]];
  const party = () => between('if (area == "party") {', 'if (area != "move")');
  const fraction = (text: string, pattern: RegExp) => { const found = text.match(pattern); expect(found, String(pattern)).not.toBeNull(); return Number(found![1]); };
  // The bounds the checks below use come out of the source, so a changed constant changes what is asserted.
  const rect = () => ({
    top: fraction(party(), /y < Math\.Round\(viewHeight \* (0\.\d+)\)/),
    right: fraction(party(), /x >= Math\.Round\(viewWidth \* (0\.\d+)\)/),
    bottom: fraction(party(), /y >= Math\.Round\(viewHeight \* (0\.\d+)\)/),
  });
  // .NET Math.Round is half to even; the host rounds these same fractions.
  const round = (n: number) => { const floor = Math.floor(n), rest = n - floor; return rest > .5 ? floor + 1 : rest < .5 ? floor : floor % 2 ? floor + 1 : floor; };
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

describe("follower input host: synthetic native checks", () => {
  it("cover the lapsed renew and a refused click without sending input", () => {
    expect(synthetic).toContain("[FollowInput]::Sprint('0', 2560, 1440, [FollowInput]::QpcMs(), 120, $false) } 'Sprint lapsed'");
    expect(synthetic).toContain("[FollowInput]::QpcMs() - 1000, 120, 'move') } 'Stale capture'");
    // Never a start from the test script: that is the only call that can press a key.
    expect(synthetic).not.toMatch(/::Sprint\([^)]*\$true\)/);
    expect(synthetic).toContain("Space may go down only on a start, and never over a human hold");
  });
  it("check the party rectangle without ever running a click that could be accepted", () => {
    expect(synthetic).toContain("ExpectParty 25 336 $null");
    expect(synthetic).toContain("[FollowInput]::QpcMs(), 120, 'party') } 'Click outside the party frame area'");
    const clicks = synthetic.split("\n").filter(line => line.includes("::MoveClick("));
    expect(clicks).toHaveLength(2);
    for (const line of clicks) expect(line.trimStart(), line).toMatch(/^ExpectRefusal \{/);
  });
});
