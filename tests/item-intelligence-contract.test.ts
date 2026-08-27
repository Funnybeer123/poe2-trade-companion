import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_PROFILE_SCHEMA_VERSION } from "../src/core/buildProfiles.js";
import { SCAN_CONTRACT_VERSION } from "../src/core/scanContracts.js";
import { SCAN_RULE_SCHEMA_VERSION } from "../src/core/scanRules.js";
import { SCAN_SESSION_JOURNAL_VERSION } from "../src/main/scanSessionStore.js";
import {
  ITEM_INTELLIGENCE_CHANNELS,
  ITEM_INTELLIGENCE_EVENT_CHANNELS,
  ITEM_INTELLIGENCE_IPC_VERSION,
} from "../src/shared/ipc.js";

interface ContractFixture {
  schemaVersion: number;
  invokeChannels: string[];
  eventChannels: string[];
  contracts: {
    rule: { schemaVersion: number };
    build: { schemaVersion: number };
    scan: { schemaVersion: number; journalVersion: number };
  };
}

describe("versioned item-intelligence contracts", () => {
  it("keeps the checked-in golden manifest synchronized with runtime constants", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          "fixtures",
          "contracts",
          "item-intelligence-v1.json",
        ),
        "utf8",
      ),
    ) as ContractFixture;

    expect(fixture.schemaVersion).toBe(ITEM_INTELLIGENCE_IPC_VERSION);
    expect(fixture.invokeChannels).toEqual(ITEM_INTELLIGENCE_CHANNELS);
    expect(fixture.eventChannels).toEqual(ITEM_INTELLIGENCE_EVENT_CHANNELS);
    expect(fixture.contracts.rule.schemaVersion).toBe(
      SCAN_RULE_SCHEMA_VERSION,
    );
    expect(fixture.contracts.build.schemaVersion).toBe(
      BUILD_PROFILE_SCHEMA_VERSION,
    );
    expect(fixture.contracts.scan.schemaVersion).toBe(SCAN_CONTRACT_VERSION);
    expect(fixture.contracts.scan.journalVersion).toBe(
      SCAN_SESSION_JOURNAL_VERSION,
    );
  });
});
