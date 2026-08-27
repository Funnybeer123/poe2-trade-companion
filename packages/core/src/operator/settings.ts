export const OPERATOR_SETTINGS_KEY = "operator";

export interface OperatorSettings {
  league: string;
  redactIdentifiers: boolean;
  qaAcknowledged: boolean;
  priceCheckHotkey: string;
  overlayOpacity: number;
}

export function defaultOperatorSettings(): OperatorSettings {
  return {
    league: "Standard",
    redactIdentifiers: true,
    qaAcknowledged: false,
    priceCheckHotkey: "CommandOrControl+Shift+D",
    overlayOpacity: 1,
  };
}

export function parseOperatorSettings(raw: unknown): OperatorSettings {
  const defaults = defaultOperatorSettings();
  if (typeof raw !== "object" || raw === null) {
    return defaults;
  }
  const value = raw as Partial<OperatorSettings>;
  return {
    league: typeof value.league === "string" && value.league.length > 0 ? value.league : defaults.league,
    redactIdentifiers:
      typeof value.redactIdentifiers === "boolean" ? value.redactIdentifiers : defaults.redactIdentifiers,
    qaAcknowledged: value.qaAcknowledged === true,
    priceCheckHotkey:
      typeof value.priceCheckHotkey === "string" && value.priceCheckHotkey.length > 0
        ? value.priceCheckHotkey
        : defaults.priceCheckHotkey,
    overlayOpacity:
      typeof value.overlayOpacity === "number" && Number.isFinite(value.overlayOpacity)
        ? Math.min(1, Math.max(0.2, value.overlayOpacity))
        : defaults.overlayOpacity,
  };
}

export interface SettingsPort {
  get(key: string): string | undefined;
  set(key: string, valueJson: string, updatedAtMs: number): void;
}

export class MemorySettingsStore implements SettingsPort {
  readonly #values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  set(key: string, valueJson: string, _updatedAtMs: number): void {
    void _updatedAtMs;
    this.#values.set(key, valueJson);
  }
}
