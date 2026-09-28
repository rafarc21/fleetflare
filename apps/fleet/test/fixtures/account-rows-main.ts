// Issue #289/#285: StudioStatus rows exactly as origin/main 66d0e679 stores
// them, produced by main's own launchAccountOrRefuse (vitest, then JSON) --
// none of them carries `launchedAccount`, the field this change adds. Kept so
// a row written before the change is proven to load and render.
//   launched            -- a mapped, launchable studio: main writes nothing
//   staleFailoverRecord -- an earlier failover's claudeAccount, never relaunched
//   refused             -- failover off, mapped secret missing, stale record kept
import type { StudioStatus } from "../../src/studio/types";

export const MAIN_ROWS: Record<"launched" | "staleFailoverRecord" | "refused", StudioStatus> = {
  "launched": {
    "id": "demosite-life--pilot",
    "state": "running",
    "tailscaleHost": null,
    "lastRefresh": null,
    "error": null,
    "lastRefreshError": null,
    "burn": null,
    "spawnedBy": null,
    "spawnTokenHash": null,
    "repoSlug": null
  },
  "staleFailoverRecord": {
    "id": "demosite-life--scratch",
    "state": "running",
    "tailscaleHost": null,
    "lastRefresh": null,
    "error": null,
    "lastRefreshError": null,
    "burn": null,
    "spawnedBy": null,
    "spawnTokenHash": null,
    "repoSlug": null,
    "claudeAccount": "CLAUDE_CODE_OAUTH_TOKEN_3"
  },
  "refused": {
    "id": "demosite-life--web-studio",
    "state": "degraded",
    "tailscaleHost": null,
    "lastRefresh": null,
    "error": "claude account: demosite-life is mapped to CLAUDE_CODE_OAUTH_TOKEN_2 (CLAUDE_ACCOUNT_BY_REPO), and that secret is not set — refusing to launch rather than fall back to another account. Set it: wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2",
    "lastRefreshError": null,
    "burn": null,
    "spawnedBy": null,
    "spawnTokenHash": null,
    "repoSlug": null,
    "claudeAccount": "CLAUDE_CODE_OAUTH_TOKEN_3"
  }
};
