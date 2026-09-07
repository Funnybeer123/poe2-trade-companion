/**
 * npm run clean:release -- remove everything under release/.
 *
 * release/ holds electron-builder outputs (smoke-*, public*, qa*), all
 * gitignored and regenerable with `npm run pack*`; a handful of smoke runs
 * costs tens of gigabytes inside a OneDrive-synced tree. rm -rf semantics,
 * Windows-safe (retries on EBUSY/EPERM from a lingering explorer or
 * antivirus handle).
 *
 *   node scripts/clean-release.mjs [DIR]   (DIR defaults to ./release)
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const dir = path.resolve(process.argv[2] ?? "release");
if (path.basename(dir) !== "release") {
  console.error(`refusing to clean ${dir}: expected a directory named "release"`);
  process.exit(2);
}
if (!existsSync(dir)) {
  console.log(`clean:release -- nothing to do, ${dir} does not exist`);
  process.exit(0);
}

let removed = 0;
let failed = 0;
for (const name of readdirSync(dir)) {
  const target = path.join(dir, name);
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    removed += 1;
    console.log(`removed ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAILED ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(
  `clean:release -- ${removed} entr${removed === 1 ? "y" : "ies"} removed from ${dir}` +
    (failed ? `, ${failed} failed` : ""),
);
process.exit(failed ? 1 : 0);
