import type { QaActionTrace, RedactionSettings } from "./types.js";

const SECRET_REPLACERS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /POESESSID[=:\s]+\S+/gi, replacement: "POESESSID=[redacted-token]" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Bearer [redacted-token]" },
  { pattern: /access_token[=:\s]+\S+/gi, replacement: "access_token=[redacted-token]" },
  { pattern: /refresh_token[=:\s]+\S+/gi, replacement: "refresh_token=[redacted-token]" },
  { pattern: /sessionid[=:\s]+\S+/gi, replacement: "sessionid=[redacted-token]" },
];

export function redactSecrets(text: string): string {
  let next = text;
  for (const { pattern, replacement } of SECRET_REPLACERS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

export function redactIdentifiersInText(text: string, identifiers: string[]): string {
  let next = text;
  for (const identifier of identifiers) {
    if (identifier.length === 0) {
      continue;
    }
    next = next.split(identifier).join("[redacted]");
  }
  return next;
}

function collectIdentifiers(trace: QaActionTrace, settings: RedactionSettings): string[] {
  const identifiers = [...(settings.identifiers ?? [])];
  const targetMatch = /target=([^\s]+)/.exec(trace.observedSummary);
  if (targetMatch?.[1] && targetMatch[1] !== "none" && targetMatch[1] !== "[redacted]") {
    identifiers.push(targetMatch[1]);
  }
  return identifiers;
}

function redactOptionalText(
  value: string | undefined,
  redact: (text: string) => string,
): string | undefined {
  return value === undefined ? undefined : redact(value);
}

export function redactQaActionTrace(
  trace: QaActionTrace,
  settings: RedactionSettings,
): QaActionTrace {
  const applySecrets = (text: string): string => redactSecrets(text);
  const identifiers = settings.redactIdentifiers ? collectIdentifiers(trace, settings) : [];
  const applyAll = (text: string): string =>
    settings.redactIdentifiers
      ? redactIdentifiersInText(applySecrets(text), identifiers)
      : applySecrets(text);

  return {
    ...trace,
    observedSummary: applyAll(trace.observedSummary),
    decisionReason: applyAll(trace.decisionReason),
    result: redactOptionalText(trace.result, applyAll),
    followUpSummary: redactOptionalText(trace.followUpSummary, applyAll),
    recoveryOf: redactOptionalText(trace.recoveryOf, applyAll),
    process: trace.process
      ? {
          name: trace.process.name,
          title: settings.redactIdentifiers
            ? redactOptionalText(trace.process.title, applyAll) ?? "[redacted]"
            : redactOptionalText(trace.process.title, applySecrets),
        }
      : undefined,
    intendedActions: trace.intendedActions.map((action) => {
      if (action.type === "noop") {
        return { ...action, reason: applyAll(action.reason) };
      }
      return action;
    }),
  };
}
