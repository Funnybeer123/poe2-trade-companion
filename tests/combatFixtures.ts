import { defaultCombatConfig, type CombatConfig, type CombatFrame } from "../src/core/combatAssist.js";
export function color(r: number, g: number, b: number, count = 256) { return Array.from({ length: count }, () => [r, g, b]).flat(); }
export function calibratedCombat(): CombatConfig {
  const config = defaultCombatConfig();
  config.width = 2560; config.height = 1440;
  config.health.enabled = config.mana.enabled = config.unleash.enabled = true;
  config.regions = {
    health: { x: 100, y: 1100, width: 5, height: 200, reference: color(160, 15, 20, 500) },
    mana: { x: 2400, y: 1100, width: 5, height: 200, reference: color(15, 20, 160, 500) },
    unleash: { x: 2000, y: 1300, width: 50, height: 50, reference: color(180, 70, 220), cooldown: color(40, 15, 50) },
    // Calibrated but OFF by default so the older expectations (1 / Mouse5 / R) still hold; tests enable it explicitly.
    verisium: { x: 2100, y: 1300, width: 50, height: 50, reference: color(90, 200, 230), cooldown: color(20, 45, 55) },
    anchor: { x: 2350, y: 1050, width: 32, height: 32, reference: color(180, 165, 100) },
  };
  return config;
}
export function fill(full: number[], percent: number): number[] { return full.map((v, i) => i < (100 - percent) * 15 ? 5 : v); }
export function combatFrame(config = calibratedCombat(), time = 0): CombatFrame {
  return { capturedAt: time, hwnd: "1234", process: "PathOfExileSteam", width: config.width, height: config.height,
    samples: Object.fromEntries(Object.entries(config.regions).map(([name, region]) => [name, [...region.reference]])) };
}
