import type { RedactionSettings } from "../trace/types.js";
import { redactIdentifiersInText, redactSecrets } from "../trace/redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RedactingLoggerOptions {
  redactIdentifiers?: boolean;
  identifiers?: string[];
  write?: (level: LogLevel, line: string) => void;
}

export function redactLogText(text: string, settings: RedactionSettings): string {
  const withSecrets = redactSecrets(text);
  if (!settings.redactIdentifiers) {
    return withSecrets;
  }
  return redactIdentifiersInText(withSecrets, settings.identifiers ?? []);
}

export function formatLogLine(level: LogLevel, message: string, extra?: unknown): string {
  if (extra === undefined) {
    return `${level} ${message}`;
  }
  try {
    return `${level} ${message} ${JSON.stringify(extra)}`;
  } catch {
    return `${level} ${message}`;
  }
}

export class RedactingLogger {
  readonly #settings: RedactionSettings;
  readonly #write: (level: LogLevel, line: string) => void;

  constructor(options: RedactingLoggerOptions = {}) {
    this.#settings = {
      redactIdentifiers: options.redactIdentifiers !== false,
      identifiers: options.identifiers,
    };
    this.#write = options.write ?? defaultWrite;
  }

  debug(message: string, extra?: unknown): void {
    this.#emit("debug", message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.#emit("info", message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.#emit("warn", message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.#emit("error", message, extra);
  }

  #emit(level: LogLevel, message: string, extra?: unknown): void {
    this.#write(level, redactLogText(formatLogLine(level, message, extra), this.#settings));
  }
}

function defaultWrite(level: LogLevel, line: string): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createRedactingLogger(options: RedactingLoggerOptions = {}): RedactingLogger {
  return new RedactingLogger(options);
}
