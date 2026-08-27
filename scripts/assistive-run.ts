import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../src/core/calibrationStore.js";
import { resolveBuildMode } from "../src/core/capabilities.js";
import { readClassFlag, searchScenarioQuery } from "../src/core/itemClassFilter.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { AssistiveRunService, type AssistiveRunKind } from "../src/main/assistiveRunService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kindArg = process.argv.find((arg) => arg.startsWith("--kind="))?.slice(7) ?? "empty";
if (!["fill", "empty", "two-cycle"].includes(kindArg)) throw new Error(`unsupported-kind-${kindArg}`);
const kind = kindArg as AssistiveRunKind;
const wantedClasses = readClassFlag(process.argv);
const dryRun = !process.argv.includes("--live");
const stashTab = loadProfile(path.join(root, "fixtures", "perception", "templates")).activeStashTab === "quad"
  ? "quad"
  : "normal";
const query = searchScenarioQuery(wantedClasses);
const maxItemsArg = process.argv.find((arg) => arg.startsWith("--max-items="))?.slice(12);
const maxItems = maxItemsArg ? Number(maxItemsArg) : undefined;
const allowlist = (process.env.POE2_PROCESS_ALLOWLIST ?? "PathOfExileSteam.exe,PathOfExile.exe,PathOfExile_x64Steam.exe")
  .split(/[;,]/)
  .map((entry) => entry.trim())
  .filter(Boolean);

const service = new AssistiveRunService({
  mode: resolveBuildMode(process.env.POE2_BUILD_MODE),
  qaOptIn: process.env.POE2_QA_OPT_IN === "1",
  killSwitch: new KillSwitch(),
  memoryRoot: root,
  artifactDir: path.join(root, "artifacts", "assistive-cli"),
  profile: () => loadProfile(path.join(root, "fixtures", "perception", "templates")),
  onEvent: (event) => console.log(JSON.stringify({ event })),
});

if (process.argv.includes("--reset-memory")) {
  console.log(JSON.stringify({ memory: service.resetMemory(stashTab, query) }, null, 2));
} else {
  try {
    const result = await service.start({
      kind,
      dryRun,
      wantedClasses,
      uniqueAcrossCycles: process.argv.includes("--unique-across-cycles"),
      qaAcknowledged: process.env.POE2_QA_ACK === "1",
      allowlist,
      actionsPerMinute: Number(process.env.POE2_ACTIONS_PER_MINUTE ?? 240),
      maxItems,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 2;
  }
}
