import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("migrations", () => {
  it("includes qa_action_traces in 001_init.sql", () => {
    const sql = readFileSync(resolve(repoRoot, "migrations/001_init.sql"), "utf8");
    expect(sql).toContain("qa_action_traces");
  });
});
