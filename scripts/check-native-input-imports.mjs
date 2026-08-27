#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_PACKAGES = ["koffi", "uiohook-napi", "@nut-tree", "robotjs", "nut-js"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "release",
  "artifacts",
  ".git",
  "playwright-report",
]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const ALLOWED_PREFIX = path.normalize("packages/native-input");

const importPatterns = FORBIDDEN_PACKAGES.map((pkg) => {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    pkg,
    regexes: [
      new RegExp(`from\\s+['"]${escaped}(?:/[^'"]*)?['"]`),
      new RegExp(`import\\s+['"]${escaped}(?:/[^'"]*)?['"]`),
      new RegExp(`import\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]\\s*\\)`),
      new RegExp(`require\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]\\s*\\)`),
    ],
  };
});

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(full, files);
      continue;
    }
    if (SOURCE_EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const root = process.cwd();
const files = await walk(root);
const violations = [];

for (const file of files) {
  const rel = path.relative(root, file);
  const normalized = path.normalize(rel);
  if (normalized === ALLOWED_PREFIX || normalized.startsWith(`${ALLOWED_PREFIX}${path.sep}`)) {
    continue;
  }
  const text = await readFile(file, "utf8");
  for (const { pkg, regexes } of importPatterns) {
    if (regexes.some((regex) => regex.test(text))) {
      violations.push(`${rel} imports ${pkg}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Native input imports outside packages/native-input/**:");
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log("OK: no native input imports outside packages/native-input/**");
