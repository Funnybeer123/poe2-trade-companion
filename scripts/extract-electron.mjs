import { createRequire } from "node:module";
import path from "node:path";
import { writeFileSync, mkdirSync, cpSync } from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const extract = require("extract-zip");
const zip =
  "C:\\Users\\evanb\\AppData\\Local\\electron\\Cache\\970afa656e5cc63e0568b62d998525c6da59168482fcb76af9a6d533a8390a03\\electron-v34.3.0-win32-x64.zip";
const tmp = path.join(os.tmpdir(), "electron-34-extract");
mkdirSync(tmp, { recursive: true });
await extract(zip, { dir: tmp });
const dest = path.resolve("node_modules/electron/dist");
mkdirSync(dest, { recursive: true });
cpSync(tmp, dest, { recursive: true });
writeFileSync(path.resolve("node_modules/electron/path.txt"), "electron.exe");
console.log("ok", dest);
