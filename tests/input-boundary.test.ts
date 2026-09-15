import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every .ts file under `dir`, recursively (missing dir = no files). */
function typescriptFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...typescriptFilesUnder(full));
    else if (entry.endsWith(".ts")) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

/**
 * The ported overlay features (src/main/features/*) reach the game ONLY
 * through the audited chat-command service, which owns the one input host,
 * the kill-switch checks, the foreground/allowlist guard, the dry-run gate
 * and the action trace. A feature that spawned its own host or emitted its
 * own clicks would bypass all of it, so importing the host or sending an
 * input op from the feature tree is a test failure.
 */
const FEATURE_INPUT_EXCEPTIONS = new Set([
  // Read-only window probe (op "rect" only): tells the stash-price overlay
  // where the game window is. Asserted below to stay read-only.
  "src/main/features/stashTracker/hostProbe.ts",
]);

/**
 * Comments are prose, not behaviour: a module's header explaining that it
 * sends no input would otherwise fail the very scan that proves it. Strip
 * block and line comments before matching so the guard reads code only.
 */
function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FORBIDDEN_INPUT_IMPORT = /\b(?:startWinHost|WinHostInputSink|GameInputController)\b/;
const FORBIDDEN_HOST_OP =
  /(?:host|win)\.send\(\s*\{\s*op:\s*"(?:click|ctrlclick|shiftctrlclick|ctrlburst|rightclick|drag|hotkey|type|move|focus|wheel|waitclick|copysweep|clickburst|setclipboard)"/;

describe("input boundary", () => {
  it("no ported feature reaches the game except through the chat-command service", () => {
    const featureFiles = typescriptFilesUnder("src/main/features");
    const coreFiles = [
      "evaluate",
      "market",
      "trade",
      "commands",
      "inspect",
      "stashTracker",
      "session",
      "campaignGuide",
      "pricingHistory",
      "appSettings",
    ].flatMap((pkg) =>
      typescriptFilesUnder("src/core").filter((file) =>
        path.basename(file).toLowerCase().startsWith(pkg.toLowerCase()),
      ),
    );
    // The scan must actually see the feature tree; an empty list would pass vacuously.
    expect(featureFiles.length).toBeGreaterThan(4);

    for (const file of [...featureFiles, ...coreFiles]) {
      const source = codeWithoutComments(readFileSync(file, "utf8"));
      if (FEATURE_INPUT_EXCEPTIONS.has(file)) {
        // The one audited exception stays read-only: no input op, ever.
        expect(source, `${file} must not emit input`).not.toMatch(FORBIDDEN_HOST_OP);
        continue;
      }
      expect(source, `${file} must not import the input host`).not.toMatch(FORBIDDEN_INPUT_IMPORT);
      expect(source, `${file} must not send input ops`).not.toMatch(FORBIDDEN_HOST_OP);
    }
  });

  it("only GameInputController and inputSink mention native emit", () => {
    const controller = readFileSync("src/core/gameInputController.ts", "utf8");
    const sink = readFileSync("src/core/inputSink.ts", "utf8");
    const winSink = readFileSync("src/adapters/winHostInputSink.ts", "utf8");
    const service = readFileSync("src/main/assistiveRunService.ts", "utf8");
    const cycle = readFileSync("scripts/assistive-cycle.ts", "utf8");
    const deposit = readFileSync("scripts/assistive-deposit.ts", "utf8");
    const hands = readFileSync("scripts/assistive-hands.ts", "utf8");
    const sizes = readFileSync("scripts/assistive-item-sizes.ts", "utf8");
    const calibrate = readFileSync("scripts/calibrate-ui.ts", "utf8");
    const follow = readFileSync("src/core/controllers.ts", "utf8");
    expect(controller).toContain("sink.emit");
    expect(sink).toContain("NativeInputSink");
    expect(winSink).toContain("ctrlburst");
    expect(service).toContain("GameInputController");
    expect(service).not.toMatch(/host\.send\(\{\s*op:\s*"(?:click|ctrlburst|rightclick|drag|hotkey|type|move)"/);
    expect(cycle).not.toContain("startWinHost");
    expect(deposit).not.toContain("startWinHost");
    expect(cycle).toContain('process.argv.push("--dry-run")');
    expect(cycle).not.toContain('process.argv.push("--live")');
    for (const script of [hands, sizes, calibrate]) {
      expect(script).not.toMatch(
        /(?:host|win)\.send\(\{\s*op:\s*"(?:click|ctrlclick|ctrlburst|rightclick|drag|hotkey|type|move|focus)"/,
      );
    }
    expect(follow).not.toContain("NativeInputSink");
    expect(follow).not.toContain("user32");
  });
});
