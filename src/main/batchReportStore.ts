import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StashValuationReport } from "../core/stashValuation.js";

/** Atomic working report plus immutable revisions, including pre-feature reports and transfer receipts. */
export function writeBatchReport(file: string, report: StashValuationReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const history = path.join(path.dirname(file), "batch-history");
  mkdirSync(history, { recursive: true });
  const archive = (contents: string) => {
    const hash = createHash("sha256").update(contents).digest("hex");
    const destination = path.join(history, hash + ".json");
    if (!existsSync(destination)) writeFileSync(destination, contents, { encoding: "utf8", flag: "wx" });
  };
  if (existsSync(file)) archive(readFileSync(file, "utf8"));
  const contents = JSON.stringify(report, null, 2);
  archive(contents);
  writeFileSync(file + ".tmp", contents, "utf8");
  renameSync(file + ".tmp", file);
}
