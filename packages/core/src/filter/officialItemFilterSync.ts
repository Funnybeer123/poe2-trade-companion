/**
 * Official item-filter OAuth sync.
 *
 * GGG developer portal (re-checked 2026-08-27): "We are currently unable to
 * process new applications." No test client is supplied.
 *
 * Status: BLOCKED: oauth-registration
 * Local loot-filter export remains the supported path.
 */
export const OFFICIAL_ITEM_FILTER_SYNC_STATUS = "BLOCKED: oauth-registration" as const;

export interface OfficialItemFilterSyncResult {
  ok: false;
  oauthSync: false;
  status: typeof OFFICIAL_ITEM_FILTER_SYNC_STATUS;
  detail: string;
}

export class OfficialItemFilterSync {
  readonly status = OFFICIAL_ITEM_FILTER_SYNC_STATUS;

  sync(): OfficialItemFilterSyncResult {
    return {
      ok: false,
      oauthSync: false,
      status: OFFICIAL_ITEM_FILTER_SYNC_STATUS,
      detail:
        "Official item-filter API sync requires OAuth account:item_filter. GGG is not accepting new applications and no test client is supplied.",
    };
  }
}

export function createOfficialItemFilterSync(): OfficialItemFilterSync {
  return new OfficialItemFilterSync();
}
