/**
 * Auto-flask guard + auto-cast — standalone CLI (the action daemon runs the
 * same guard alongside its numpad actions when artifacts/flask-guard.json
 * is enabled).
 *
 *   npm run flask:calibrate                    click the LIFE globe, then the MANA globe
 *   npm run flask:calibrate -- life            one globe only (life | mana)
 *   npm run flask:calibrate -- skill:verisium  one auto-cast skill icon (see flask:status for ids)
 *   npm run flask:status                       sample every globe and skill once and print the verdicts
 *   npm run flask:guard -- --dry-run           watch and log WOULD-fire events, press nothing
 *   npm run flask:guard                        live: press the flask keys when a globe drops,
 *                                              and each skill key whenever its icon reads ready
 *
 * Calibration: switch to the game when told and click the globe at the
 * exact height where the flask should fire — with the globe filled ABOVE
 * that point (full life/mana in town is ideal). For a skill, click the TOP
 * EDGE of its skill-bar icon while the skill is READY (not on cooldown) —
 * the cooldown sweep relights the top last. The averaged colour at the
 * click becomes that probe's reference. Ctrl+C stops the guard.
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
import { describeRgb, FLASK_GLOBES, isSkillProbeId, probeConfigFor, skillProbeId } from "../src/shared/flaskGuard.js";

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

async function calibrate(targets: string[]): Promise<void> {
  const host = startWinHost({ requestTimeoutMs: 45_000 });
  try {
    for (const target of targets) {
      const entry = probeConfigFor(loadFlaskGuardConfig(root).config, target);
      if (!entry) {
        console.error(`[${target}] unknown probe — life, mana, or skill:<id> (npm run flask:status lists the ids)`);
        process.exitCode = 1;
        return;
      }
      console.log(
        entry.kind === "globe"
          ? `\n[${target.toUpperCase()}] Switch to the game and CLICK the ${target} globe at the height where the flask should fire.` +
              ` Keep the globe filled above that point (30s).`
          : `\n[${entry.label}] Switch to the game and CLICK the TOP EDGE of the ${entry.label} icon on the skill bar while the skill is READY (30s).`,
      );
      const result = await calibrateFlaskProbe(host, target, { root, timeoutMs: 30_000 });
      if (!result.ok) {
        console.error(`[${target}] calibration failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[${target}] saved point (${result.point?.x}, ${result.point?.y}) reference ${describeRgb(result.rgb!)}` +
          (result.looksFilled
            ? entry.kind === "globe"
              ? " — looks like fluid ✔"
              : " — looks like a lit icon ✔"
            : entry.kind === "globe"
              ? " — WARNING: that reads as empty glass or chrome, not fluid. Was the globe filled above the click? Re-run to fix."
              : " — WARNING: that is dark. Was the skill on cooldown when you clicked? Re-run while it is ready."),
      );
    }
    const loaded = loadFlaskGuardConfig(root);
    if (!loaded.config.enabled) {
      if (targets.some((target) => isSkillProbeId(target))) {
        // Never switch auto-cast on as a side effect of measuring an icon.
        console.log("The guard is OFF. Enable it under Tools → Hotkeys → Auto-flask & auto-cast (or calibrate a globe, which enables it).");
      } else {
        saveFlaskGuardConfig(root, { ...loaded.config, enabled: true });
        console.log("Auto-flask enabled (was off). Toggle it in Tools → Hotkeys → Auto-flask & auto-cast.");
      }
    }
    console.log(`Config: ${flaskGuardConfigPath(root)}`);
  } finally {
    await host.close();
  }
}

async function status(): Promise<void> {
  const loaded = loadFlaskGuardConfig(root);
  for (const issue of loaded.issues) console.warn(`config: ${issue}`);
  // The listing first, so the ids are printed even before anything is calibrated.
  console.log(`enabled=${loaded.config.enabled} config=${flaskGuardConfigPath(root)}`);
  for (const globe of FLASK_GLOBES) {
    const cfg = loaded.config[globe];
    console.log(`${globe}: key ${cfg.key} cooldown ${cfg.cooldownMs}ms ${cfg.point ? `at (${cfg.point.x}, ${cfg.point.y})` : "NOT CALIBRATED"}${cfg.enabled ? "" : " (off)"}`);
  }
  for (const skill of loaded.config.skills) {
    console.log(`${skillProbeId(skill)} (${skill.label}): key ${skill.key || "NONE"} retry gap ${skill.cooldownMs}ms ${skill.point ? `at (${skill.point.x}, ${skill.point.y})` : "NOT CALIBRATED"}${skill.enabled ? "" : " (off)"}`);
  }
  const host = startWinHost();
  try {
    const result = await sampleFlaskProbes(host, loaded.config);
    if (!result.ok) {
      console.log(`no live sample: ${result.error}`);
      return;
    }
    console.log(`foregroundIsPoe=${result.foregroundIsPoe}`);
    for (const probe of result.probes) {
      const cfg = probeConfigFor(loaded.config, probe.id)?.probe;
      if (!cfg) continue;
      const skill = isSkillProbeId(probe.id);
      const state = skill ? (probe.state === "filled" ? "READY" : probe.state === "low" ? "COOLING" : "UNKNOWN") : probe.state.toUpperCase();
      const rule = skill
        ? `needs every channel within ${probe.thresholds.match}`
        : `needs chroma>=${probe.thresholds.minChroma} bright>=${probe.thresholds.minBright}`;
      console.log(
        `${probe.id} (${probe.label}): ${state} now ${describeRgb(probe.rgb)} | reference ${describeRgb(probe.reference)}` +
          ` | ${rule} | key ${cfg.key} ${skill ? "retry gap" : "cooldown"} ${cfg.cooldownMs}ms at (${cfg.point?.x}, ${cfg.point?.y})`,
      );
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
  const which = args.filter((arg) => arg === "life" || arg === "mana" || isSkillProbeId(arg));
  await calibrate(which.length > 0 ? which : [...FLASK_GLOBES]);
} else if (has("--status")) {
  await status();
} else {
  await guard(has("--dry-run"));
}
process.exit(process.exitCode ?? 0);
