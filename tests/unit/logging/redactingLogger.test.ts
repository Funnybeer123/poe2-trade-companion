import { createRedactingLogger, redactLogText } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("redacting logger", () => {
  it("redacts session tokens from general logs", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger({
      redactIdentifiers: true,
      identifiers: ["ExileCharacter"],
      write: (_level, line) => {
        lines.push(line);
      },
    });
    logger.info("login POESESSID=abc123def character=ExileCharacter");
    expect(lines[0]).toContain("POESESSID=[redacted-token]");
    expect(lines[0]).not.toContain("abc123def");
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain("ExileCharacter");
  });

  it("always redacts secrets even when identifier redaction is off", () => {
    const text = redactLogText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", {
      redactIdentifiers: false,
    });
    expect(text).toContain("Bearer [redacted-token]");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
