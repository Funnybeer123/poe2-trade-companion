if (!process.argv.some((arg) => arg.startsWith("--kind="))) {
  process.argv.push("--kind=two-cycle");
}
if (!process.argv.includes("--live") && !process.argv.includes("--dry-run")) {
  process.argv.push("--dry-run");
}

await import("./assistive-run.js");

export {};
