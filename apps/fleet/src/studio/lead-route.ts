// apps/fleet/src/studio/lead-route.ts
//
// Issue #911: the one rule every (re)start path and fleet ls READY share.
// A glm-led studio's lead runs on the fleet LLM router with no Claude OAuth
// token. A row that is glm-led yet recorded a Claude account as the account
// its lead launched on is a lead on the wrong account.
//
// Pure: no I/O, safe to import from do.ts, the CLI and tests alike.

/** The subset of StudioStatus this rule reads. */
export interface LeadRouteRow {
  leadType?: "claude" | "glm";
  launchedAccount?: string | null;
}

/** True when the row says its lead runs on a Claude account but its leadType
 *  says glm. A glm lead never records a Claude account (launchFields returns
 *  envAccount undefined for it), so a recorded name here is the mismatch. */
export function leadAccountMismatch(row: LeadRouteRow): boolean {
  return row.leadType === "glm" && typeof row.launchedAccount === "string" && row.launchedAccount.length > 0;
}
