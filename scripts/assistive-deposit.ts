if (!process.argv.some((arg) => arg.startsWith("--kind="))) {
  process.argv.push(process.argv.includes("--fill") ? "--kind=fill" : "--kind=empty");
}
if (!process.argv.includes("--live") && !process.argv.includes("--dry-run")) {
  process.argv.push(process.argv.includes("--run") ? "--live" : "--dry-run");
}

await import("./assistive-run.js");

export {};
