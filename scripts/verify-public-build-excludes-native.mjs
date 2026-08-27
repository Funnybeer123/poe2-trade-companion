#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_PATH_FRAGMENTS = [
  "packages/native-input",
  `${path.sep}native-input${path.sep}`,
  "@poe2tc/native-input",
];
const FORBIDDEN_FILE_NAMES = new Set(["nativeInputSink.js", "nativeInputSink.ts", "NativeInputSink.js"]);
const FORBIDDEN_CONTENT = [
  "@poe2tc/native-input",
  "NativeInputSink",
  "uiohook-napi",
  "robotjs",
  "@nut-tree",
  "nut-js",
];
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_BASENAMES = new Set(["builder-debug.yml", "builder-effective-config.yaml"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".html", ".css", ".yml", ".yaml", ".txt", ".md"]);

function parseArgs(argv) {
  const filesFrom = [];
  const roots = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--files-from") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--files-from requires a path");
      }
      filesFrom.push(next);
      i += 1;
      continue;
    }
    roots.push(arg);
  }
  return { filesFrom, roots };
}

async function walkFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walkFiles(full, files);
      }
      continue;
    }
    files.push(full);
  }
  return files;
}

function normalize(rel) {
  return rel.split(path.sep).join("/");
}

function pathForbidden(rel) {
  const posix = normalize(rel);
  if (FORBIDDEN_PATH_FRAGMENTS.some((fragment) => posix.includes(fragment.replaceAll("\\", "/")))) {
    return `path includes native-input: ${posix}`;
  }
  if (FORBIDDEN_FILE_NAMES.has(path.basename(rel))) {
    return `forbidden file: ${posix}`;
  }
  return undefined;
}

async function contentForbidden(rel, text) {
  const posix = normalize(rel);
  if (
    posix.includes("electron-builder.qa.yml") ||
    posix.includes("verify-public-build-excludes-native") ||
    posix.endsWith("builder-debug.yml")
  ) {
    return undefined;
  }
  for (const token of FORBIDDEN_CONTENT) {
    if (text.includes(token)) {
      return `${posix} contains ${token}`;
    }
  }
  if (posix.endsWith("package.json") && text.includes('"poe2tcMode": "authorized-qa"')) {
    return `${posix} bakes authorized-qa`;
  }
  return undefined;
}

async function listAsarEntries(archivePath) {
  try {
    const asar = await import("@electron/asar");
    return asar.listPackage(archivePath, { isPack: false }).map((entry) =>
      path.posix.join(path.basename(archivePath), String(entry).replace(/^\//, "")),
    );
  } catch {
    return [];
  }
}

async function collectFromRoots(roots) {
  const files = [];
  for (const root of roots) {
    const info = await stat(root);
    if (info.isDirectory()) {
      const walked = await walkFiles(root);
      files.push(...walked);
      for (const file of walked) {
        if (file.endsWith(".asar")) {
          files.push(...(await listAsarEntries(file)));
        }
      }
    } else if (root.endsWith(".asar")) {
      files.push(...(await listAsarEntries(root)));
    } else {
      files.push(root);
    }
  }
  return files;
}

async function collectFromLists(lists) {
  const files = [];
  for (const listPath of lists) {
    const text = await readFile(listPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        files.push(trimmed);
      }
    }
  }
  return files;
}

const { filesFrom, roots } = parseArgs(process.argv.slice(2));
const listed = await collectFromLists(filesFrom);
const walked = roots.length > 0 ? await collectFromRoots(roots) : [];
const files = [...listed, ...walked];

if (files.length === 0) {
  console.error("Usage: node scripts/verify-public-build-excludes-native.mjs [--files-from list.txt] [packDir]");
  process.exit(2);
}

const violations = [];
for (const file of files) {
  const rel = path.isAbsolute(file) && roots[0] !== undefined ? path.relative(roots[0], file) : file;
  if (SKIP_BASENAMES.has(path.basename(rel)) || rel.endsWith(".asar")) {
    continue;
  }
  const pathIssue = pathForbidden(rel);
  if (pathIssue !== undefined) {
    violations.push(pathIssue);
    continue;
  }
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 2_000_000 || !TEXT_EXT.has(path.extname(file))) {
      continue;
    }
    const text = await readFile(file, "utf8");
    const contentIssue = await contentForbidden(rel, text);
    if (contentIssue !== undefined) {
      violations.push(contentIssue);
    }
  } catch {
    const contentIssue = await contentForbidden(rel, rel);
    if (contentIssue !== undefined) {
      violations.push(contentIssue);
    }
  }
}

if (violations.length > 0) {
  console.error("Public pack must not include native-input or an armable QA artifact:");
  for (const violation of violations) {
    console.error(` - ${violation}`);
  }
  process.exit(1);
}

console.log("OK: public pack file list excludes packages/native-input and native input libraries");
