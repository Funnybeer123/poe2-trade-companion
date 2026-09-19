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

describe("follower input host: synthetic native checks", () => {
  it("cover the lapsed renew and a refused click without sending input", () => {
    expect(synthetic).toContain("[FollowInput]::Sprint('0', 2560, 1440, [FollowInput]::QpcMs(), 120, $false) } 'Sprint lapsed'");
    expect(synthetic).toContain("[FollowInput]::QpcMs() - 1000, 120, 'move') } 'Stale capture'");
    // Never a start from the test script: that is the only call that can press a key.
    expect(synthetic).not.toMatch(/::Sprint\([^)]*\$true\)/);
    expect(synthetic).toContain("Space may go down only on a start, and never over a human hold");
  });
});
