import { createOfficialItemFilterSync, OFFICIAL_ITEM_FILTER_SYNC_STATUS } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("OfficialItemFilterSync", () => {
  it("stays blocked without OAuth registration", () => {
    const sync = createOfficialItemFilterSync();
    const result = sync.sync();
    expect(result.ok).toBe(false);
    expect(result.oauthSync).toBe(false);
    expect(result.status).toBe("BLOCKED: oauth-registration");
    expect(OFFICIAL_ITEM_FILTER_SYNC_STATUS).toBe("BLOCKED: oauth-registration");
  });
});
