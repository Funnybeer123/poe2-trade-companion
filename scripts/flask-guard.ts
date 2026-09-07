/**
 * Auto-flask guard — standalone CLI (the action daemon runs the same guard
 * alongside its numpad actions when artifacts/flask-guard.json is enabled).
 *
 *   npm run flask:calibrate            click the LIFE globe, then the MANA globe
 *   npm run flask:calibrate -- life    one globe only (life | mana)
 *   npm run flask:status               sample both globes once and print the verdicts
 *   npm run flask:guard -- --dry-run   watch and log WOULD-fire events, press nothing
 *   npm run flask:guard                live: press the flask keys when a globe drops
 *
 * Calibration: switch to the game when told and click the globe at the
 * exact height where the flask should fire — with the globe filled ABOVE
 * that point (full life/mana in town is ideal). The averaged colour at the
 * click becomes that globe's "filled" reference. Ctrl+C stops the guard.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import {
  calibrateFlaskProbe,
  FlaskGuardRunner,
  sampleFlaskProbes,
} from "../src/adapters/flaskGuardRunner.js";
import { flaskGuardConfigPath, loadFlaskGuardConfig, saveFlaskGuardConfig } from "../src/core/flaskGuardConfig.js";
import { describeRgb, FLASK_GLOBES, type FlaskGlobe } from "../src/shared/flaskGuard.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const logFile = path.join(artifactDir, "flask-guard.log");
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (prefix: string) => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);

function log(entry: { phase: string; message: string }): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
}

async function calibrate(globes: FlaskGlobe[]): Promise<void> {
  const host = startWinHost({ requestTimeoutMs: 45_000 });
  try {
    for (const globe of globes) {
      console.log(
        `\n[${globe.toUpperCase()}] Switch to the game and CLICK the ${globe} globe at the height where the flask should fire.` +
          ` Keep the globe filled above that point (30s).`,
      );
      const result = await calibrateFlaskProbe(host, globe, { root, timeoutMs: 30_000 });
      if (!result.ok) {
        console.error(`[${globe}] calibration failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[${globe}] saved point (${result.point?.x}, ${result.point?.y}) reference ${describeRgb(result.rgb!)}` +
          (result.looksFilled
            ? " — looks like fluid ✔"
            : " — WARNING: that reads as empty glass or chrome, not fluid. Was the globe filled above the click? Re-run to fix."),
      );
    }
    const loaded = loadFlaskGuardConfig(root);
    if (!loaded.config.enabled) {
      saveFlaskGuardConfig(root, { ...loaded.config, enabled: true });
      console.log("Auto-flask enabled (was off). Toggle it in Tools → Hotkeys → Auto-flask.");
    }
    console.log(`Config: ${flaskGuardConfigPath(root)}`);
  } finally {
    await host.close();
  }
}

async function status(): Promise<void> {
  const loaded = loadFlaskGuardConfig(root);
  for (const issue of loaded.issues) console.warn(`config: ${issue}`);
  const host = startWinHost();
  try {
    const result = await sampleFlaskProbes(host, loaded.config);
    if (!result.ok) {
      console.error(`status failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`enabled=${loaded.config.enabled} foregroundIsPoe=${result.foregroundIsPoe}`);
    for (const probe of result.probes) {
      const cfg = loaded.config[probe.globe];
      console.log(
        `${probe.globe}: ${probe.state.toUpperCase()} now ${describeRgb(probe.rgb)} | reference ${describeRgb(probe.reference)}` +
          ` | needs chroma>=${probe.thresholds.minChroma} bright>=${probe.thresholds.minBright}` +
          ` | key ${cfg.key} cooldown ${cfg.cooldownMs}ms at (${cfg.point?.x}, ${cfg.point?.y})`,
      );
    }
    for (const globe of FLASK_GLOBES) {
      if (!loaded.config[globe].point) console.log(`${globe}: not calibrated`);
    }
  } finally {
    await host.close();
  }
}

async function guard(dryRun: boolean): Promise<void> {
  const cycleMs = Number(valueOf("--cycle-ms=")) || 5_000;
  const runner = new FlaskGuardRunner({ root, log, dryRun, cycleMs });
  const loaded = loadFlaskGuardConfig(root);
  for (const issue of loaded.issues) log({ phase: "config", message: issue });
  if (!loaded.config.enabled) {
    log({ phase: "config", message: "auto-flask is disabled in the config; run the calibration or enable it in Tools → Hotkeys → Auto-flask" });
  }
  runner.start();
  log({ phase: "listening", message: `${dryRun ? "DRY-RUN " : ""}guard running; Ctrl+C stops` });
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
  });
  log({ phase: "stopping", message: "SIGINT — stopping guard" });
  await runner.stop();
  const summary = runner.status();
  log({ phase: "stopped", message: `cycles=${summary.cycles} fires=${summary.totalFires}` });
}

if (has("--calibrate")) {
  const which = args.find((arg) => arg === "life" || arg === "mana") as FlaskGlobe | undefined;
  await calibrate(which ? [which] : [...FLASK_GLOBES]);
} else if (has("--status")) {
  await status();
} else {
  await guard(has("--dry-run"));
}
process.exit(process.exitCode ?? 0);
