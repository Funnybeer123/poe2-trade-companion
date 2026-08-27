import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emptyProfile, type CalibrationProfile } from "./calibrationProfile.js";

export function profilePath(dir: string): string {
  return path.join(dir, "calibration.json");
}

export function loadProfile(dir: string): CalibrationProfile {
  const file = profilePath(dir);
  if (!existsSync(file)) return emptyProfile();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CalibrationProfile;
    if (parsed.version !== 1) return emptyProfile();
    return { ...emptyProfile(), ...parsed, npcs: parsed.npcs ?? [] };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(dir: string, profile: CalibrationProfile): string {
  mkdirSync(dir, { recursive: true });
  const next = { ...profile, version: 1 as const, updatedAt: new Date().toISOString() };
  const file = profilePath(dir);
  writeFileSync(file, JSON.stringify(next));
  return file;
}

export function resetProfile(dir: string): CalibrationProfile {
  const next = emptyProfile();
  saveProfile(dir, next);
  return next;
}
