/** Zero-click watcher: wait for stash + gear folder row, then run the sort. */
import { spawn } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { labelsSimilar } from "../src/core/tabList.js";
const host = startWinHost({ requestTimeoutMs: 30_000 });
const kit = new StashTabKit(host);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GEAR = ["Weapons", "Helmets", "Amulets", "Rings", "Gloves", "Belts", "Boots", "OffHands", "Body Armour", "Jewels"];
try {
  for (let i = 0; i < 360; i += 1) {
    const band = await host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    if (/stash/i.test(String(band.text ?? ""))) {
      const strip = await kit.readStrip();
      if (strip.folder.some((e) => GEAR.some((g) => labelsSimilar(e.label, g)))) {
        console.log("stash + gear folder visible — launching sort");
        await host.close();
        const child = spawn("npx", ["--yes", "tsx", "scripts/sort-gear.ts", "--sources=Amulets", "--no-chest"], {
          stdio: "inherit",
          shell: true,
        });
        child.on("exit", (code) => process.exit(code ?? 1));
        await new Promise(() => {});
      }
    }
    await sleep(5000);
  }
  console.log("timed out after 30 minutes");
} finally { /* host closed on launch */ }
