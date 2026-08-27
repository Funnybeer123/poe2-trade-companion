#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_INPUT_PACKAGES = ["uiohook-napi", "@nut-tree", "robotjs", "nut-js"];
const KOFFI_PACKAGE = "koffi";
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
const NATIVE_INPUT_PREFIX = path.normalize("packages/native-input");
const KOFFI_ALLOWED_PREFIXES = [
  NATIVE_INPUT_PREFIX,
  path.normalize("packages/perception-live"),
];

const inputImportPatterns = FORBIDDEN_INPUT_PACKAGES.map((pkg) => {
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

const koffiEscaped = KOFFI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const koffiRegexes = [
  new RegExp(`from\\s+['"]${koffiEscaped}(?:/[^'"]*)?['"]`),
  new RegExp(`import\\s+['"]${koffiEscaped}(?:/[^'"]*)?['"]`),
  new RegExp(`import\\(\\s*['"]${koffiEscaped}(?:/[^'"]*)?['"]\\s*\\)`),
  new RegExp(`require\\(\\s*['"]${koffiEscaped}(?:/[^'"]*)?['"]\\s*\\)`),
];

function isUnderPrefix(normalized, prefix) {
  return normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`);
}

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
  const text = await readFile(file, "utf8");

  if (!isUnderPrefix(normalized, NATIVE_INPUT_PREFIX)) {
    for (const { pkg, regexes } of inputImportPatterns) {
      if (regexes.some((regex) => regex.test(text))) {
        violations.push(`${rel} imports ${pkg}`);
      }
    }
  }

  if (!KOFFI_ALLOWED_PREFIXES.some((prefix) => isUnderPrefix(normalized, prefix))) {
    if (koffiRegexes.some((regex) => regex.test(text))) {
      violations.push(`${rel} imports ${KOFFI_PACKAGE}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Native input imports outside the approved adapters:");
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log(
  "OK: no native input imports outside packages/native-input/**; koffi only in native-input and perception-live",
);
