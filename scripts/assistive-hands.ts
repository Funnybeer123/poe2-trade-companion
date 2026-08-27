// Compatibility entry point. All bag-to-stash input now runs through the same
// audited AssistiveRunService used by Electron.
if (process.argv.includes("--score")) {
  throw new Error("assistive-score-retired-use-electron-transfer-controls");
}
if (!process.argv.some((arg) => arg.startsWith("--kind="))) {
  process.argv.push("--kind=empty");
}
if (!process.argv.includes("--live") && !process.argv.includes("--dry-run")) {
  process.argv.push(process.argv.includes("--probe") ? "--dry-run" : "--live");
}

await import("./assistive-run.js");

export {};
