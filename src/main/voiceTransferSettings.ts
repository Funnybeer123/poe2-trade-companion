import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_VOICE_TRANSFER_CONFIG,
  normalizeVoiceTransferConfig,
  type VoiceTransferConfig,
} from "../core/voiceTransfer.js";

export function voiceTransferSettingsPath(root: string): string {
  return path.join(root, "voice-transfer.json");
}

export function loadVoiceTransferConfig(root: string): VoiceTransferConfig {
  const file = voiceTransferSettingsPath(root);
  if (!existsSync(file)) {
    return normalizeVoiceTransferConfig(undefined);
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<VoiceTransferConfig>;
    return normalizeVoiceTransferConfig(parsed, DEFAULT_VOICE_TRANSFER_CONFIG);
  } catch {
    return normalizeVoiceTransferConfig(undefined);
  }
}

export function saveVoiceTransferConfig(
  root: string,
  config: VoiceTransferConfig,
): string {
  const next = normalizeVoiceTransferConfig(config, DEFAULT_VOICE_TRANSFER_CONFIG);
  mkdirSync(root, { recursive: true });
  const file = voiceTransferSettingsPath(root);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}
