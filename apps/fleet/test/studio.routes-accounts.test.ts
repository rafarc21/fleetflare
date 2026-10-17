import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import {
  BRINGUP_CMD, FRESH_SESSION_REFUSED_PREFIX,
} from "../src/studio/provision";
import {
  RECYCLE_REFUSED_PREFIX, LaunchRefusedError, StartRefusedError,
} from "../src/studio/do";
import { wakeCmd, PANE_PROBE_CMD, PANE_SCREEN_CMD } from "../src/studio/wake";
import { appendHouseRules } from "../src/studio/blueprint";
import { redactSecrets } from "../src/studio/redact";
import { emptyObserved, type Observed } from "../src/studio/observed";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Env } from "../src/env";
import {
  writeFleetAccountLimit, readFleetAccountLimits, readOneAccountLimit, writeAccountHold,
} from "../src/studio/account-limits-store";
import { readFleetAccountUsage, writeFleetAccountUsage } from "../src/studio/account-usage-store";
import { resolveClaudeAccounts, selectByHeadroom } from "../src/studio/accounts";
import {
  STUDIO_ID, FAKE_ROLE_PROMPT, FAKE, decodeRolePrompt,
  envWithFakeStudio, envWithThrowingVerb, fakeFetchBlueprintFile,
  setFakeRescueAnswer, resetFakeRescueAnswer,
} from "./helpers/routes-studio-harness";

function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM worker_exceptions").run();
});

// Issue #141 review, item 4 — `fleet ls` shows only accounts studios are
// CURRENTLY on; a dead account with no studio parked on it right now (every
// studio already failed off it, the real case an org-wide disable produces)
// is invisible to that view. This route surfaces every configured account,
// fleet-wide, whether or not any studio is on it right now.
describe("GET /studio/accounts", () => {
  it("401 without an Access header", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(new Request("https://x/studio/accounts"), testEnv);
    expect(res.status).toBe(401);
  });

  it("no dead accounts: every configured account listed, all dead:false", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq("/studio/accounts"), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; label: string | null; dead: boolean; until: string | null; seenAt: string | null }[];
    expect(body).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, until: null, seenAt: null, kind: null, reason: null },
    ]);
  });

  it("one dead account: that account's row carries dead:true and its seenAt", async () => {
    authorized();
    const { testEnv: base } = envWithFakeStudio();
    const testEnv = { ...base, CLAUDE_CODE_OAUTH_TOKEN_2: "test-oauth-2" } as unknown as Env;
    const seenAt = "2026-09-30T12:00:00.000Z";
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", null, seenAt, true);

    const res = await handleStudio(authorizedReq("/studio/accounts"), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; label: string | null; dead: boolean; until: string | null; seenAt: string | null }[];
    expect(body).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, until: null, seenAt: null, kind: null, reason: null },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: null, dead: true, until: null, seenAt, kind: null, reason: null },
    ]);
  });
});

// Issue #232, step 2 — the dumb, validated persistence endpoint the step-3
// CLI (`fleet accounts sync`) posts its locally-computed SyncDecision[] to.
// This route never calls cswap or decideAccountSync itself; it only applies
// decisions already made elsewhere via writeFleetAccountLimit /
// clearFleetAccountLimit, same auth lane as every other /studio/* route
// (verifyAccess already ran before any pathname branch is reached).
// Issue #232 review round: `claude-swap.ts`'s SyncDecision reshape — "clear"
// now carries `seenAt` too, and the request carries a new top-level
// `usageFetchedAt` (MAJOR 6's yardstick for whether a "clear" is stale
// relative to a fresher row). `usageFetchedAt` defaults here to the same
// instant the fixtures below treat as "now", so a test that wants a
// pre-existing row to read as OLDER or NEWER than the snapshot overrides it
// explicitly rather than relying on wall-clock time.
describe("POST /studio/accounts/sync", () => {
  const USAGE_FETCHED_AT = "2026-10-05T00:00:00.000Z";
  type SyncBody = { applied: string[]; rejected: { name: string; reason: string }[]; skipped: { name: string; reason: string }[] };
  const syncReq = (decisions: unknown[], usageFetchedAt: string | undefined = USAGE_FETCHED_AT) => authorizedReq(
    "/studio/accounts/sync",
    { method: "POST", body: JSON.stringify({ decisions, ...(usageFetchedAt === undefined ? {} : { usageFetchedAt }) }) },
  );

  it("401 without an Access header", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      new Request("https://x/studio/accounts/sync", {
        method: "POST",
        body: JSON.stringify({ decisions: [], usageFetchedAt: USAGE_FETCHED_AT }),
      }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("GET on this path is 405 (does not collide with GET /studio/accounts)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq("/studio/accounts/sync"), testEnv);
    expect(res.status).toBe(405);
  });

  it("400s on a non-JSON body", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq("/studio/accounts/sync", { method: "POST", body: "not json" }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("400s when decisions is not an array", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq("/studio/accounts/sync", {
        method: "POST",
        body: JSON.stringify({ decisions: "nope", usageFetchedAt: USAGE_FETCHED_AT }),
      }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("400s the whole request when usageFetchedAt is missing", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq("/studio/accounts/sync", { method: "POST", body: JSON.stringify({ decisions: [] }) }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("400s the whole request when usageFetchedAt is not a parseable timestamp", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(syncReq([], "not-a-date"), testEnv);
    expect(res.status).toBe(400);
  });

  it("a limit decision for a real account writes a row readFleetAccountLimits then shows", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until, seenAt });
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]?.dead).toBeUndefined();
  });

  // BLOCKER 2: `until: null` is a VALID limit (a window with no readable
  // resetsAt) — only an ABSENT `until` key is invalid, never explicit null.
  it("a limit decision with until: null explicitly is accepted and written", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: null, seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until: null, seenAt });
  });

  // BLOCKER 2: a missing `until` key must never decode as "free" at the D1
  // boundary — rejected outright, nothing written.
  it("a limit decision missing the until key is rejected and writes nothing", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid until" }]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  it("a limit decision with a non-date seenAt is rejected and writes nothing", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: null, seenAt: "not-a-date" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid seenAt" }]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  // MAJOR 5: a usage sighting is orthogonal to "account is dead" — a "limit"
  // write must preserve an existing dead:true flag rather than silently
  // dropping it.
  it("a limit write against a currently dead:true row leaves dead:true set", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", null, "2026-10-04T00:00:00.000Z", true);
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const after = await readOneAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN");
    expect(after).toEqual({ until, seenAt, dead: true, source: "usage" });
  });

  it("a limit write against a row with no prior dead flag leaves dead unset", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const after = await readOneAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN");
    expect(after?.dead).toBeUndefined();
  });

  // MINOR: every "limit" write from this route carries source: "usage".
  it("a limit write carries source: usage on the stored row", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";

    await handleStudio(syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt }]), testEnv);

    const after = await readOneAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN");
    expect(after?.source).toBe("usage");
  });

  it("a clear decision where no row currently exists is a no-op success, applied", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T00:00:00.000Z" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  it("a clear decision deletes a row OLDER than usageFetchedAt, applied", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", "2026-10-05T05:00:00.000Z", "2026-10-04T00:00:00.000Z");

    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T00:00:00.000Z" }],
        "2026-10-05T00:00:00.000Z",
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  // MAJOR 6: a row at least as fresh as this usage snapshot must survive — a
  // different path (failover.ts's pane capture) may have recorded it AFTER
  // the snapshot this clear decision was computed from was taken.
  it("a clear decision does NOT delete a row at least as NEW as usageFetchedAt — skipped, not applied", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const fresherSeenAt = "2026-10-05T00:00:00.000Z";
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", "2026-10-05T05:00:00.000Z", fresherSeenAt);

    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: fresherSeenAt }],
        "2026-10-04T23:00:00.000Z", // usageFetchedAt is OLDER than the row's own seenAt
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [], rejected: [], skipped: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "newer row exists" }],
    });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until: "2026-10-05T05:00:00.000Z", seenAt: fresherSeenAt });
  });

  // Maestro review round 2, finding 6: the freshness yardstick for a "clear"
  // must be THIS account's own data time (usageFetchedAt - usageAgeSeconds),
  // never the bare usageFetchedAt the CLI subprocess happened to run at. The
  // maestro's own example: a 499s-old reading, row seen ~4 minutes before the
  // CLI run. The row's seenAt (23:56:00) is OLDER than usageFetchedAt
  // (00:00:00 the next day) but NEWER than the reading's real data time
  // (usageFetchedAt - 499s = 23:51:41) -- so the row is genuinely fresher
  // than the usage reading once the reading's own staleness is accounted
  // for, and must survive. The OLD (buggy) comparison against bare
  // usageFetchedAt would have wrongly cleared it (see this test ported to a
  // RED run against the pre-fix code in the dispatch's own regression-proof
  // step).
  it("finding 6 regression: a row seenAt before usageFetchedAt but after the per-account data time (usageFetchedAt - usageAgeSeconds) survives, not cleared", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const rowSeenAt = "2026-10-04T23:56:00.000Z"; // ~4 minutes before the CLI run
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", "2026-10-05T05:00:00.000Z", rowSeenAt);

    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T00:00:00.000Z", usageAgeSeconds: 499 }],
        "2026-10-05T00:00:00.000Z", // usageFetchedAt -- the CLI run's own instant
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [], rejected: [], skipped: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "newer row exists" }],
    });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until: "2026-10-05T05:00:00.000Z", seenAt: rowSeenAt });
  });

  it("a clear decision also clears a dead:true row entirely", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", null, "2026-10-04T00:00:00.000Z", true);

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T00:00:00.000Z" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  it("a clear decision with a non-date seenAt is rejected and writes nothing", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", "2026-10-05T05:00:00.000Z", "2026-10-04T00:00:00.000Z");

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "not-a-date" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid seenAt" }]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toBeDefined();
  });

  it("an unmanaged decision writes nothing and is echoed in applied", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "unmanaged" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  // NEW action (claude-swap.ts's rework): same "handled, nothing to write"
  // treatment as "unmanaged".
  it("a no-data decision writes nothing and is echoed in applied", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "no-data", reason: "usageStatus: relogin_required" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  it("a known name with an invalid action is rejected, not applied, and writes nothing", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "nuke-it" }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid action" }]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  // MINOR: a malformed entry (null, missing name, non-string name) must never
  // reach a property access that could throw/500 — rejected cleanly instead.
  it("malformed entries (null, missing name, non-string name) are rejected cleanly, no 500", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();

    const res = await handleStudio(
      syncReq([
        null,
        { action: "limit", until: null, seenAt: "2026-10-05T00:00:00.000Z" },
        { name: 42, action: "clear" },
      ]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([
      { name: "", reason: "malformed entry" },
      { name: "", reason: "malformed entry" },
      { name: "", reason: "malformed entry" },
    ]);
  });

  it("two decisions for the same name in one batch are both rejected and neither writes", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";

    const res = await handleStudio(
      syncReq([
        { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-05T05:00:00.000Z", seenAt },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt },
      ]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "duplicate name in batch" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "duplicate name in batch" },
    ]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
  });

  it("an unknown account name is rejected but a valid entry in the same batch still applies", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";

    const res = await handleStudio(
      syncReq([
        { name: "CLAUDE_CODE_OAUTH_TOKEN_NOPE", action: "clear" },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: null, seenAt },
      ]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_NOPE");

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until: null, seenAt });
  });

  // Issue #238 step 2: a "limit" decision carrying a valid `usage` field also
  // writes the new, separate account-usage:<slot> row.
  it("a limit decision with a valid usage field writes a readFleetAccountUsage snapshot too", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const usage = { fiveHourPct: 97, sevenDayPct: 40, scopedMaxPct: 20 };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...usage, seenAt });
  });

  // Issue #238 step 2: the whole point of the separate-store design -- a
  // "clear" decision writes a usage snapshot even though no account-limit row
  // survives the clear at all (the two stores are independent).
  it("a clear decision with a valid usage field writes a usage snapshot even though no account-limit row survives", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const usage = { fiveHourPct: 10, sevenDayPct: 25, scopedMaxPct: 5 };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...usage, seenAt });
  });

  // Issue #238 step 2: a malformed usage field rejects the WHOLE entry --
  // no usage write, and the limit/clear action itself must NOT be
  // half-applied either.
  it("a limit decision with a malformed usage field (non-numeric fiveHourPct) is rejected entirely, no partial write", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const usage = { fiveHourPct: "not a number", sevenDayPct: 40, scopedMaxPct: 20 };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid usage" }]);

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in limits).toBe(false);
    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in usageRows).toBe(false);
  });

  it("a clear decision with a malformed usage field (scopedMaxPct neither number nor null) is rejected entirely, no partial write", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeFleetAccountLimit(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", "2026-10-05T05:00:00.000Z", "2026-10-04T00:00:00.000Z");
    const seenAt = "2026-10-05T00:00:00.000Z";
    const usage = { fiveHourPct: 10, sevenDayPct: 25, scopedMaxPct: "none" };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid usage" }]);

    // The pre-existing limit row must survive untouched -- the clear itself
    // must never have been applied once the whole entry was rejected.
    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toBeDefined();
    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in usageRows).toBe(false);
  });

  // Issue #238 step 2: a decision with NO usage field at all is unchanged
  // existing (#232/#240) behaviour -- no usage write, limit/clear applies
  // exactly as before.
  it("a limit decision with no usage field at all writes no usage snapshot, limit still applies", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const limits = await readFleetAccountLimits(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(limits["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ until, seenAt });
    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in usageRows).toBe(false);
  });

  // Maestro review round 2, MAJOR 1: the persisted account-usage row's
  // seenAt must be the real DATA time (usageFetchedAt - usageAgeSeconds),
  // never the CLI-run-time usageFetchedAt itself -- the same correction
  // finding 6 already applied to the account-limit store's own freshness
  // comparison, now also needed on the account-usage store's OWN stored
  // seenAt for a "limit" decision.
  it("a limit decision's persisted usage row seenAt accounts for usageAgeSeconds, not the bare usageFetchedAt", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const usageFetchedAt = "2026-10-05T00:00:00.000Z";
    const seenAt = usageFetchedAt; // same instant the CLI stamps onto every decision
    const until = "2026-10-05T05:00:00.000Z";
    const usageAgeSeconds = 480; // 8 minutes old at CLI-run-time
    const usage = { fiveHourPct: 97, sevenDayPct: 40, scopedMaxPct: 20 };

    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usageAgeSeconds, usage }],
        usageFetchedAt,
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    const expectedSeenAt = new Date(Date.parse(usageFetchedAt) - usageAgeSeconds * 1000).toISOString();
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...usage, seenAt: expectedSeenAt });

    // A live-failover read 3 minutes LATER must treat this row as STALE: the
    // real data age is 8 + 3 = 11 minutes, past the 10-minute ceiling -- even
    // though the row's own wall-clock age from usageFetchedAt is only 3 min.
    const laterNow = new Date(Date.parse(usageFetchedAt) + 3 * 60_000);
    const account = resolveClaudeAccounts(testEnv).find((a) => a.name === "CLAUDE_CODE_OAUTH_TOKEN")!;
    expect(selectByHeadroom([account], usageRows, laterNow)).toBeNull();
  });

  // Same bug, "clear" branch: this route already computes dataTimeMs for its
  // OWN MAJOR-6 skip comparison against the account-limit row, but was still
  // stamping the account-usage row's seenAt from the bare wall-clock seenAt
  // rather than that same dataTimeMs.
  it("a clear decision's persisted usage row seenAt also accounts for usageAgeSeconds, not the bare usageFetchedAt", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const usageFetchedAt = "2026-10-05T00:00:00.000Z";
    const seenAt = usageFetchedAt;
    const usageAgeSeconds = 480;
    const usage = { fiveHourPct: 10, sevenDayPct: 25, scopedMaxPct: 5 };

    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt, usageAgeSeconds, usage }],
        usageFetchedAt,
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    const expectedSeenAt = new Date(Date.parse(usageFetchedAt) - usageAgeSeconds * 1000).toISOString();
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...usage, seenAt: expectedSeenAt });
  });

  // Maestro review round 2, MINOR 4: a pct outside [0, 100] must be rejected
  // -- the pre-existing isValidUsageField check only tested "finite number",
  // never a real range, so a garbage pct like 150 slipped through.
  it("a usage pct of 150 (outside [0, 100]) is rejected entirely", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const usage = { fiveHourPct: 150, sevenDayPct: 40, scopedMaxPct: 20 };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid usage" }]);
    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in usageRows).toBe(false);
  });

  it("a usage pct of -5 (outside [0, 100]) is rejected entirely", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const usage = { fiveHourPct: -5, sevenDayPct: 40, scopedMaxPct: 20 };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid usage" }]);
    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in usageRows).toBe(false);
  });

  it("a scopedMaxPct that is neither a number nor null (\"high\") is rejected entirely", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const usage = { fiveHourPct: 10, sevenDayPct: 40, scopedMaxPct: "high" };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "invalid usage" }]);
  });

  // Maestro review round 2, MINOR 4: the write to D1 must build the usage
  // object field-by-field, never a `{ ...usage, seenAt }` spread -- a spread
  // would persist arbitrary extra keys from a client-controlled JSON body
  // straight into D1.
  it("a usage object carrying an extra unexpected key never persists that key to D1", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const seenAt = "2026-10-05T00:00:00.000Z";
    const until = "2026-10-05T05:00:00.000Z";
    const usage = { fiveHourPct: 10, sevenDayPct: 40, scopedMaxPct: 20, evil: "injected" };

    const res = await handleStudio(
      syncReq([{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until, seenAt, usage }]),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    // Asserted on the RAW D1 row, not the parsed/sanitized read API: the
    // guarantee this finding is about is that the extra key never reaches D1
    // in the first place, not merely that the read path happens to filter it
    // back out afterward.
    const raw = await testEnv.DB
      .prepare("SELECT value FROM fleet_state WHERE key = ?")
      .bind("account-usage:CLAUDE_CODE_OAUTH_TOKEN")
      .first<{ value: string }>();
    expect(raw?.value).not.toContain("evil");
    expect(raw?.value).not.toContain("injected");
    expect(JSON.parse(raw!.value)).toEqual({ fiveHourPct: 10, sevenDayPct: 40, scopedMaxPct: 20, seenAt });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({
      fiveHourPct: 10, sevenDayPct: 40, scopedMaxPct: 20, seenAt,
    });
  });

  // Maestro review round 2, MINOR 4: a clock-skewed or malicious client
  // claiming a usageFetchedAt more than 2 minutes in the future must not be
  // trusted -- whole-request 400, same as the existing "must parse" check.
  it("400s the whole request when usageFetchedAt is more than 2 minutes in the future", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const res = await handleStudio(syncReq([], future), testEnv);
    expect(res.status).toBe(400);
  });

  it("does NOT 400 when usageFetchedAt is only slightly in the future (clock skew within tolerance)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const slightlyFuture = new Date(Date.now() + 30_000).toISOString();
    const res = await handleStudio(syncReq([], slightlyFuture), testEnv);
    expect(res.status).toBe(200);
  });

  // Issue #246: the `account-usage:<slot>` row has its OWN freshness race,
  // independent of the account-limit row's own "newer row exists" skip --
  // that skip only ever guarded the account-limit row, never the separate
  // usage store the write lands in a moment earlier. An older batch's
  // "clear" decision must never stomp a newer usage reading already
  // recorded, even though its account-limit clear is itself (correctly)
  // applied, because no account-limit row exists to skip against here.
  it("a clear decision's usage write does NOT stomp a NEWER usage row already recorded (#246)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const newerSnapshot = { fiveHourPct: 99, sevenDayPct: 88, scopedMaxPct: 77, seenAt: "2026-10-05T00:10:00.000Z" };
    await writeFleetAccountUsage(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", newerSnapshot);

    const olderUsage = { fiveHourPct: 1, sevenDayPct: 1, scopedMaxPct: 1 };
    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: "2026-10-05T00:00:00.000Z", usageAgeSeconds: 0, usage: olderUsage }],
        "2026-10-05T00:00:00.000Z", // dataTime == usageFetchedAt here, OLDER than the row's own 00:10:00 seenAt
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual(newerSnapshot);
  });

  // Same bug class, the "limit" branch: it writes account-usage:<slot>
  // unconditionally too (it has no limit-row skip concept at all, since a
  // limit write is never skipped) -- an older "limit" batch landing late
  // must not overwrite a newer usage reading either.
  it("a limit decision's usage write does NOT stomp a NEWER usage row already recorded (#246)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const newerSnapshot = { fiveHourPct: 99, sevenDayPct: 88, scopedMaxPct: 77, seenAt: "2026-10-05T00:10:00.000Z" };
    await writeFleetAccountUsage(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", newerSnapshot);

    const olderUsage = { fiveHourPct: 1, sevenDayPct: 1, scopedMaxPct: 1 };
    const res = await handleStudio(
      syncReq(
        [{
          name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-05T05:00:00.000Z",
          seenAt: "2026-10-05T00:00:00.000Z", usageAgeSeconds: 0, usage: olderUsage,
        }],
        "2026-10-05T00:00:00.000Z",
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual(newerSnapshot);
  });

  // The positive case, not just the regression guard: a genuinely NEWER
  // usage reading arriving after an older one DOES overwrite it -- the
  // store must stay live-updatable, not become write-once/immutable.
  it("a clear decision's usage write DOES overwrite a genuinely OLDER usage row (#246)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const olderSnapshot = { fiveHourPct: 1, sevenDayPct: 1, scopedMaxPct: 1, seenAt: "2026-10-04T23:50:00.000Z" };
    await writeFleetAccountUsage(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", olderSnapshot);

    const newerUsage = { fiveHourPct: 99, sevenDayPct: 88, scopedMaxPct: 77 };
    const usageFetchedAt = "2026-10-05T00:00:00.000Z";
    const res = await handleStudio(
      syncReq(
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", action: "clear", seenAt: usageFetchedAt, usageAgeSeconds: 0, usage: newerUsage }],
        usageFetchedAt,
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...newerUsage, seenAt: usageFetchedAt });
  });

  it("a limit decision's usage write DOES overwrite a genuinely OLDER usage row (#246)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const olderSnapshot = { fiveHourPct: 1, sevenDayPct: 1, scopedMaxPct: 1, seenAt: "2026-10-04T23:50:00.000Z" };
    await writeFleetAccountUsage(testEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN", olderSnapshot);

    const newerUsage = { fiveHourPct: 99, sevenDayPct: 88, scopedMaxPct: 77 };
    const usageFetchedAt = "2026-10-05T00:00:00.000Z";
    const res = await handleStudio(
      syncReq(
        [{
          name: "CLAUDE_CODE_OAUTH_TOKEN", action: "limit", until: "2026-10-05T05:00:00.000Z",
          seenAt: usageFetchedAt, usageAgeSeconds: 0, usage: newerUsage,
        }],
        usageFetchedAt,
      ),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: ["CLAUDE_CODE_OAUTH_TOKEN"], rejected: [], skipped: [] });

    const usageRows = await readFleetAccountUsage(testEnv.DB, resolveClaudeAccounts(testEnv));
    expect(usageRows["CLAUDE_CODE_OAUTH_TOKEN"]).toEqual({ ...newerUsage, seenAt: usageFetchedAt });
  });
});

// Issue #336 — an org MONTHLY spend cap, and the operator's manual hold. A
// held row (kind spend_cap/hold) is never cleared or shortened by the usage
// sync; only `fleet accounts clear` (POST /studio/accounts/clear) or the
// hold's own until ends it. Both operator verbs are audited in `events`.
describe("issue #336 — held account rows", () => {
  const USAGE_FETCHED_AT = "2026-10-05T00:00:00.000Z";
  const FAR = "2099-01-01T00:00:00.000Z";
  const NAME = "CLAUDE_CODE_OAUTH_TOKEN";
  type SyncBody = { applied: string[]; rejected: { name: string; reason: string }[]; skipped: { name: string; reason: string }[] };
  const syncReq = (decisions: unknown[]) => authorizedReq(
    "/studio/accounts/sync",
    { method: "POST", body: JSON.stringify({ decisions, usageFetchedAt: USAGE_FETCHED_AT }) },
  );
  const post = (path: string, body: unknown) => authorizedReq(path, { method: "POST", body: JSON.stringify(body) });
  const auditRows = async (db: D1Database) =>
    (await db.prepare("SELECT from_agent, to_agent, kind, ref, body FROM events WHERE to_agent = 'accounts' ORDER BY ts").all<{
      from_agent: string; to_agent: string; kind: string; ref: string; body: string;
    }>()).results ?? [];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM events").run();
  });

  it("sync clear on an active spend_cap row is skipped — the row survives the 5h reset's low pct", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeAccountHold(testEnv.DB, NAME, { until: FAR, seenAt: "2026-10-01T00:00:00.000Z", kind: "spend_cap" });
    const res = await handleStudio(syncReq([{ name: NAME, action: "clear", seenAt: USAGE_FETCHED_AT }]), testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: [], rejected: [], skipped: [{ name: NAME, reason: "held (spend_cap)" }] } satisfies SyncBody);
    expect((await readOneAccountLimit(testEnv.DB, NAME))?.kind).toBe("spend_cap");
  });

  it("sync limit on an active operator hold is skipped — never shortened to a window reset", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeAccountHold(testEnv.DB, NAME, { until: null, seenAt: "2026-10-01T00:00:00.000Z", kind: "hold", reason: "r" });
    const res = await handleStudio(
      syncReq([{ name: NAME, action: "limit", until: "2026-10-05T05:00:00.000Z", seenAt: USAGE_FETCHED_AT }]), testEnv,
    );
    expect(await res.json()).toEqual({ applied: [], rejected: [], skipped: [{ name: NAME, reason: "held (hold)" }] });
    expect(await readOneAccountLimit(testEnv.DB, NAME)).toEqual({
      until: null, seenAt: "2026-10-01T00:00:00.000Z", kind: "hold", reason: "r",
    });
  });

  it("sync clear on an EXPIRED spend_cap row clears it as before", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeAccountHold(testEnv.DB, NAME, { until: "2026-10-01T00:00:00.000Z", seenAt: "2026-09-20T00:00:00.000Z", kind: "spend_cap" });
    const res = await handleStudio(syncReq([{ name: NAME, action: "clear", seenAt: USAGE_FETCHED_AT }]), testEnv);
    expect(await res.json()).toEqual({ applied: [NAME], rejected: [], skipped: [] });
    expect(await readOneAccountLimit(testEnv.DB, NAME)).toBeNull();
  });

  it("POST /studio/accounts/hold writes an operator hold (until + reason) and audits it", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(post("/studio/accounts/hold", { name: NAME, until: FAR, reason: "org cap" }), testEnv);
    expect(res.status).toBe(200);
    const row = await readOneAccountLimit(testEnv.DB, NAME);
    expect(row).toMatchObject({ until: FAR, kind: "hold", reason: "org cap" });
    expect(await auditRows(testEnv.DB)).toEqual([
      { from_agent: "operator", to_agent: "accounts", kind: "decision", ref: NAME, body: `hold ${NAME} until ${FAR}: org cap` },
    ]);
  });

  it("POST /studio/accounts/hold with no until holds until cleared", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(post("/studio/accounts/hold", { name: NAME }), testEnv);
    expect(res.status).toBe(200);
    expect(await readOneAccountLimit(testEnv.DB, NAME)).toMatchObject({ until: null, kind: "hold" });
    expect((await auditRows(testEnv.DB))[0]?.body).toBe(`hold ${NAME} until cleared`);
  });

  it("POST /studio/accounts/hold rejects an unknown slot, a bad until, a past until, a non-string reason", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    for (const body of [
      { name: "CLAUDE_CODE_OAUTH_TOKEN_9" },
      { name: NAME, until: "not-a-date" },
      { name: NAME, until: "2020-01-01T00:00:00.000Z" },
      { name: NAME, reason: 5 },
    ]) {
      const res = await handleStudio(post("/studio/accounts/hold", body), testEnv);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await readOneAccountLimit(testEnv.DB, NAME)).toBeNull();
    expect(await auditRows(testEnv.DB)).toEqual([]);
  });

  it("POST /studio/accounts/clear deletes a spend_cap row and audits it", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeAccountHold(testEnv.DB, NAME, { until: FAR, seenAt: "2026-10-01T00:00:00.000Z", kind: "spend_cap" });
    const res = await handleStudio(post("/studio/accounts/clear", { name: NAME }), testEnv);
    expect(res.status).toBe(200);
    expect(await readOneAccountLimit(testEnv.DB, NAME)).toBeNull();
    expect(await auditRows(testEnv.DB)).toEqual([
      { from_agent: "operator", to_agent: "accounts", kind: "decision", ref: NAME, body: `clear ${NAME} (was spend_cap)` },
    ]);
  });

  it("POST /studio/accounts/clear rejects an unknown slot; GET on either verb is 405", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    expect((await handleStudio(post("/studio/accounts/clear", { name: "nope" }), testEnv)).status).toBe(400);
    expect((await handleStudio(authorizedReq("/studio/accounts/clear"), testEnv)).status).toBe(405);
    expect((await handleStudio(authorizedReq("/studio/accounts/hold"), testEnv)).status).toBe(405);
  });

  it("GET /studio/accounts reports each row's kind and reason", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    await writeAccountHold(testEnv.DB, NAME, { until: FAR, seenAt: "2026-10-01T00:00:00.000Z", kind: "spend_cap" });
    const res = await handleStudio(authorizedReq("/studio/accounts"), testEnv);
    expect(await res.json()).toEqual([
      { name: NAME, label: null, dead: false, until: FAR, seenAt: "2026-10-01T00:00:00.000Z", kind: "spend_cap", reason: null },
    ]);
  });
});

// #168 sensor 4 (issue #188) — the read-only count that sensor reads.
describe("GET /studio/worker-exceptions/count", () => {
  it("401 without an Access header", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(new Request("https://x/studio/worker-exceptions/count"), testEnv);
    expect(res.status).toBe(401);
  });

  it("answers 0 with an empty table", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq("/studio/worker-exceptions/count"), testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it("answers the real row count", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    for (let i = 0; i < 3; i++) {
      await testEnv.DB.prepare(
        "INSERT INTO worker_exceptions (id, ts, route, name, message, stack_head) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`exc-${i}`, Date.now() + i, "/x", "Error", "boom", null).run();
    }
    const res = await handleStudio(authorizedReq("/studio/worker-exceptions/count"), testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3 });
  });
});

// P4a-2 (brief pickup): POST /studio/:id/provision accepts `{task: <n>}`, the
// same shape runSpawn takes — `ff <role> "<task>"` provisions rather than
// spawns whenever the studio already exists but is not up. Both entry points
// go through ONE resolver (routes.ts's BriefResolve), injected here for the
// same reason fetchBlueprintFile is: the real one mints an installation token.
describe("provision — {task} brief injection", () => {
  const BRIEF = "## Your task — board issue #71";

  function fakes(resolveBrief: Parameters<typeof handleStudio>[4]) {
    const bringupEnvCalls: (Record<string, string> | undefined)[] = [];
    const sbExecFake = vi.fn(async (cmd: string, e?: Record<string, string>) => {
      if (cmd === BRINGUP_CMD) bringupEnvCalls.push(e);
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (_r: string, path: string) => {
      if (path.endsWith("fleet.json")) return FAKE.fleetJson;
      if (path.endsWith("org.json")) return FAKE.orgJson;
      return FAKE.roleMd;
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);
    const call = (body: unknown) => handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST", body: JSON.stringify(body) }),
      testEnv, undefined, async () => ({ reachable: true }), resolveBrief,
    );
    return { call, bringupEnvCalls };
  }

  it("appends the resolved brief to ROLE_PROMPT_B64 — one env var, not a second mechanism", async () => {
    authorized();
    const seen: unknown[] = [];
    const { call, bringupEnvCalls } = fakes(async (studioId, repoSlug, task) => {
      seen.push({ studioId, repoSlug, task });
      return { ok: true, value: BRIEF };
    });
    const res = await call({ task: 71 });
    expect(res.status).toBe(200);
    // The studio id checked against the task's label comes from the PATH.
    expect(seen).toEqual([{ studioId: STUDIO_ID, repoSlug: "acme-org/websites", task: 71 }]);
    const prompt = new TextDecoder().decode(
      Uint8Array.from(atob(bringupEnvCalls[0]?.ROLE_PROMPT_B64 ?? ""), (c) => c.charCodeAt(0)),
    );
    expect(prompt.startsWith(FAKE_ROLE_PROMPT)).toBe(true);
    expect(prompt).toContain(BRIEF);
    expect(Object.keys(bringupEnvCalls[0] ?? {}))
      .toEqual(["ROLE_PROMPT_B64", "ROLE_ALLOWED_TOOLS", "ROLE_EFFORT", "ROLE_MCP"]);
  });

  it("a bodyless provision reads no board and leaves the prompt untouched", async () => {
    authorized();
    const resolveBrief = vi.fn(async () => ({ ok: true as const, value: BRIEF }));
    const { call, bringupEnvCalls } = fakes(resolveBrief);
    expect((await call({})).status).toBe(200);
    expect(resolveBrief).not.toHaveBeenCalled();
    expect(decodeRolePrompt(bringupEnvCalls[0]?.ROLE_PROMPT_B64 ?? ""))
      .toBe(appendHouseRules(FAKE_ROLE_PROMPT));
  });

  it("a task the studio does not own refuses with the board's own status, and never provisions", async () => {
    authorized();
    const { call, bringupEnvCalls } = fakes(async () => ({
      ok: false, status: 404, message: `task #71 is not assigned to ${STUDIO_ID}`,
    }));
    const res = await call({ task: 71 });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not assigned");
    expect(bringupEnvCalls).toHaveLength(0);
  });

  it("400s a non-integer task before the board is read", async () => {
    authorized();
    const resolveBrief = vi.fn(async () => ({ ok: true as const, value: BRIEF }));
    const { call } = fakes(resolveBrief);
    expect((await call({ task: "71" })).status).toBe(400);
    expect((await call({ task: 0 })).status).toBe(400);
    expect(resolveBrief).not.toHaveBeenCalled();
  });
});

/**
 * GET /studio/:id/inspect — board #91. The DO call itself can fail (measured
 * 2026-09-24: DO `internalError` after 737s/182s/50s, each paired 1:1 with a
 * Worker `scriptThrewException` of the same wall time). Uncaught, that turned
 * into Cloudflare's own HTML 500 page — telling the operator nothing about
 * which side broke.
 */
describe("GET /studio/:id/inspect", () => {
  it("#151: returns the container's capture time alongside the tail", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const ns = {
      ...fakeNs,
      get: () => ({
        ...stub,
        inspect: async () => ({
          ok: true,
          snapshot: {
            checkoutExists: true, paneCommand: "claude", incarnationPresent: false, bringupLogTail: "",
            tail: "hi\n", capturedAt: 1790270000,
          },
          observed: emptyObserved(),
        }),
      }),
    };
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/inspect`), { ...testEnv, STUDIO: ns } as unknown as Env);
    const body = await res.json() as { ok: boolean; capturedAt?: number | null };
    expect(body.ok).toBe(true);
    expect(body.capturedAt).toBe(1790270000);
  });

  it("answers 200 with ok:false naming the Durable Object when the DO call itself throws", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const failingNs = {
      ...fakeNs,
      get: () => ({ ...stub, inspect: async () => { throw new Error("Network connection lost."); } }),
    };
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/inspect`),
      { ...testEnv, STUDIO: failingNs } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    // #96: names the Worker->DO call without claiming the container was not reached.
    expect(body.error).toContain("Worker->DO call failed");
    expect(body.error).toContain("Network connection lost.");
  });

  // Issue #228 item 5: sessionForceArmedAt rides the ok:true response body —
  // do.ts's inspect() DO method attaches it from StudioStatus, the route
  // must forward it (the ok:true branch builds its body field-by-field, not
  // by spreading `outcome`).
  it("issue #228 item 5: forwards sessionForceArmedAt on the ok:true branch", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const ns = {
      ...fakeNs,
      get: () => ({
        ...stub,
        inspect: async () => ({
          ok: true,
          snapshot: {
            checkoutExists: true, paneCommand: "claude", incarnationPresent: false, bringupLogTail: "",
            tail: "hi\n", capturedAt: 1790270000,
          },
          observed: emptyObserved(),
          sessionForceArmedAt: "2026-09-24T10:00:00.000Z",
        }),
      }),
    };
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/inspect`), { ...testEnv, STUDIO: ns } as unknown as Env);
    const body = await res.json() as { sessionForceArmedAt?: string | null };
    expect(body.sessionForceArmedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("includes the DO's stored observed record even when the container-side exec fails (issue #85)", async () => {
    // Maestro correction #12: `runInspect`'s own {ok:false} branch (e.g. the
    // exec deadline firing) previously left an operator with only an error
    // string. StudioDO.inspect() (do.ts) now attaches the DO's own stored
    // Observed record on that branch too — reused here the same way the
    // test above stands in for a failing DO call, since this fake
    // namespace's `stub` has no baseline `inspect` wired to a real
    // runInspect/storage round trip.
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const observed: Observed = {
      ...emptyObserved(),
      replacedAt: "2026-09-24T00:00:00.000Z",
    };
    const failingNs = {
      ...fakeNs,
      get: () => ({
        ...stub,
        inspect: async () => ({
          ok: false,
          error: "container did not answer within 15s — the studio is recorded as running, " +
            "but its container is unreachable or wedged. The Worker and Durable Object are " +
            "fine; only the container side failed.",
          observed,
        }),
      }),
    };
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/inspect`),
      { ...testEnv, STUDIO: failingNs } as unknown as Env,
    );
    const body = await res.json() as { ok: boolean; observed?: Observed };
    expect(body.ok).toBe(false);
    expect(body.observed?.replacedAt).not.toBeNull();
  });

  // Code-reviewer finding (issue #85 PR1): observed.session.reason must be
  // redacted on BOTH the ok:false and ok:true branches — previously only
  // ok:true scrubbed it. computeSessionVerdict/computeAdoptedVerdict now
  // scrub at construction, so this covers the DEFENSE-IN-DEPTH pass this
  // route also applies (redactObservedSession), against an already-stored
  // record a fixture pokes into storage directly with no scrub of its own.
  it("ok:false branch: observed.session.reason is redacted, not returned raw (issue #85 PR1)", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const observed: Observed = {
      ...emptyObserved(),
      session: {
        verdict: "unknown", at: "2026-09-24T00:00:00.000Z", via: "heal", restore: "not-attempted",
        snapshotAgeS: null, turnsBefore: 0,
        reason: "no git checkout at /workspace/websites (token fsp_deadbeef00)",
      },
    };
    const failingNs = {
      ...fakeNs,
      get: () => ({
        ...stub,
        inspect: async () => ({ ok: false, error: "container did not answer within 15s", observed }),
      }),
    };
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/inspect`),
      { ...testEnv, STUDIO: failingNs } as unknown as Env,
    );
    const body = await res.text();
    expect(body).not.toContain("fsp_deadbeef00");
    expect(body).toContain(redactSecrets("fsp_deadbeef00"));
  });

  it("ok:true branch: observed.session.reason is redacted, not returned raw", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const observed: Observed = {
      ...emptyObserved(),
      session: {
        verdict: "lost", at: "2026-09-24T00:00:00.000Z", via: "restart", restore: "not-attempted",
        snapshotAgeS: null, turnsBefore: 5,
        reason: "cwd /workspace/fsp_deadbeef00",
      },
    };
    const failingNs = {
      ...fakeNs,
      get: () => ({
        ...stub,
        inspect: async () => ({
          ok: true,
          snapshot: {
            checkoutExists: true, paneCommand: "bash", incarnationPresent: true,
            bringupLogTail: "", tail: "",
          },
          observed,
        }),
      }),
    };
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/inspect`),
      { ...testEnv, STUDIO: failingNs } as unknown as Env,
    );
    const body = await res.text();
    expect(body).not.toContain("fsp_deadbeef00");
    expect(body).toContain(redactSecrets("fsp_deadbeef00"));
  });
});

/**
 * POST /studio/:id/wake — the Worker's only way to give a Claude session a
 * turn. Everything here is route-level; the emitted command itself is proven
 * against a REAL tmux server in test/bun/wake-cmd.test.ts.
 *
 * Board issue #82: this is one of `wakeStudio`'s three callers, and the fake
 * above now runs it through `wakeStudioWith`, the body the DO method itself
 * forwards to (issue #100) — so the probe command lands BEFORE the wake command on every happy
 * path below, and the two gate-refusal tests prove the route can no longer
 * boot a stopped studio or type into a bare shell.
 */
describe("POST /studio/:id/wake", () => {
  it("hands the container the same command the real-tmux test executes", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/wake`, {
        method: "POST",
        body: JSON.stringify({ prompt: "WAKE sweep 3" }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fakeNs.wakeCmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE sweep 3")]);
  });

  it("refuses a STOPPED studio without touching the container at all", async () => {
    // The live leak board issue #82 measured: a webhook/notify/HTTP wake
    // reaching a stopped studio must never start its container.
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      "stopped",
    );
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/wake`, {
        method: "POST",
        body: JSON.stringify({ prompt: "WAKE sweep 3" }),
      }),
      testEnv,
    );
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("stopped");
    expect(fakeNs.wakeCmds).toEqual([]);
  });

  it("sends no keystrokes when the pane is a bare shell, not the claude TUI", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      "running", { code: 0, stdout: "studio:claude bash\n", stderr: "" },
    );
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/wake`, {
        method: "POST",
        body: JSON.stringify({ prompt: "WAKE sweep 3" }),
      }),
      testEnv,
    );
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("bash");
    expect(fakeNs.wakeCmds).toEqual([PANE_PROBE_CMD]);
  });

  it("reports a dead tmux window as a failed wake, not a silent success", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(
      undefined, undefined, undefined, undefined, undefined, undefined,
      { code: 1, stdout: "", stderr: "can't find window: studio:claude" },
    );
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/wake`, {
        method: "POST",
        body: JSON.stringify({ prompt: "WAKE sweep 3" }),
      }),
      testEnv,
    );
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("can't find window");
  });

  it("rejects a request with no prompt before reaching the container", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/wake`, { method: "POST", body: JSON.stringify({}) }),
      testEnv,
    );
    expect(res.status).toBe(400);
    expect(fakeNs.wakeCmds).toEqual([]);
  });
});

/**
 * Issue #96. Every repair verb is a method on the studio's one Durable
 * Object, so when the Worker->DO call itself fails (measured 2026-09-24: the
 * DO received no events for ~16 min) every verb fails identically, and a bare
 * `recycle failed` sent the BETA coordinator round the loop 5 times. The route
 * now names the side and the fallback, and passes the runtime's own
 * retryable/overloaded flags through.
 *
 * Workers RPC marks an error thrown by the DO's OWN code `remote: true`; an
 * error without it never came back from the DO's code at all.
 */
describe("repair verbs name the failing side (#96)", () => {
  function rpcFailure(): Error {
    return Object.assign(new Error("Network connection lost."), { retryable: false, overloaded: false });
  }
  function retryableFailure(): Error {
    return Object.assign(new Error("Network connection lost."), { retryable: true });
  }
  // Review M1: the containers library resets the DO when its container link
  // drops (a deploy resets it too). The DO WAS reached; no `remote`.
  function resetFailure(): Error {
    return Object.assign(new Error("Application called abort() to reset Durable Object."), {
      durableObjectReset: true, retryable: true,
    });
  }
  const VERBS: { action: string; method: string; init: RequestInit }[] = [
    { action: "provision", method: "provision", init: { method: "POST", body: "{}" } },
    { action: "restart", method: "restartStudio", init: { method: "POST" } },
    { action: "recycle", method: "recycle", init: { method: "POST" } },
    { action: "destroy", method: "destroyStudio", init: { method: "POST" } },
    { action: "check", method: "checkNow", init: { method: "POST" } },
    { action: "rescue", method: "rescueNow", init: { method: "POST" } },
    { action: "clear-session-guard", method: "clearSessionGuard", init: { method: "POST" } },
    { action: "wake", method: "wakeStudio", init: { method: "POST", body: JSON.stringify({ prompt: "go" }) } },
  ];

  for (const { action, method, init } of VERBS) {
    it(`${action}: a Worker->DO failure is a 503 naming the DO, the fallback, and the runtime flags`, async () => {
      authorized();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await handleStudio(
        authorizedReq(`/studio/${STUDIO_ID}/${action}`, init), envWithThrowingVerb(method, rpcFailure()),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain(`${action} failed: the Durable Object did not answer`);
      expect(text).toContain("did not answer: Network connection lost (retryable=false");
      expect(text).toContain("Every repair verb goes through it, so retrying cannot help.");
      expect(text).toContain("On 2026-09-24 this self-healed in ~20 min. Watch CHECKED in fleet ls; wait.");
      expect(text).toContain("retryable=false");
      expect(text).toContain("overloaded=false");
      // Review nit: the message's own "." is not doubled before the flags.
      expect(text).not.toContain("..");
    });

    it(`${action}: a DO reset gets its own line — the DO WAS reached, one retry reaches a fresh instance`, async () => {
      authorized();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await handleStudio(
        authorizedReq(`/studio/${STUDIO_ID}/${action}`, init), envWithThrowingVerb(method, resetFailure()),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain("did not answer");
      expect(text).not.toContain("retrying cannot help");
      expect(text).toContain(`${action} failed: the Durable Object reset mid-call — it WAS reached`);
      expect(text).toContain("durableObjectReset=true");
      expect(text).not.toContain("Object..");
      expect(text).toContain("One retry reaches a fresh instance.");
      expect(text).toContain("Watch CHECKED in fleet ls");
    });

    it(`${action}: retryable=true never says retrying cannot help — one retry may land`, async () => {
      authorized();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await handleStudio(
        authorizedReq(`/studio/${STUDIO_ID}/${action}`, init), envWithThrowingVerb(method, retryableFailure()),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain(`${action} failed: the Durable Object did not answer`);
      expect(text).not.toContain("retrying cannot help");
      expect(text).toContain("one retry may land");
      expect(text).toContain("Watch CHECKED in fleet ls");
    });
  }

  it("recycle: an error the DO's own code threw (remote) keeps the 500 and never blames the DO", async () => {
    authorized();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("recycle failed before reprovisioning could start: boom"), { remote: true });
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), envWithThrowingVerb("recycle", err),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("boom");
    expect(text).not.toContain("did not answer");
  });

  it("recycle: a guard refusal is a 409 carrying the whole price, verbatim", async () => {
    authorized();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = `${RECYCLE_REFUSED_PREFIX}the container did not answer an 8s probe. (1h 3m old)`;
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }),
      envWithThrowingVerb("recycle", Object.assign(new Error(refusal), { remote: true })),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(refusal);
  });

  // Issue #62 follow-up: end to end through the real recycleWithSync /
  // runDestroy the fake namespace wires — a KILLED rescue exec (124) is an
  // unconfirmed rescue, and each verb answers 409 naming it.
  for (const verb of ["recycle", "destroy"] as const) {
    it(`#62: ${verb} with a killed rescue exec (124) → 409 "could not confirm", never a teardown`, async () => {
      authorized();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      setFakeRescueAnswer({ code: 124, stdout: "", stderr: "" });
      try {
        const { testEnv } = envWithFakeStudio();
        const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/${verb}`, { method: "POST" }), testEnv);
        expect(res.status).toBe(409);
        const text = await res.text();
        expect(text).toContain("could not confirm");
        expect(text).toContain(`fleet ${verb} ${STUDIO_ID} --discard-unsynced`);
        expect(text).not.toContain("--force");
      } finally {
        resetFakeRescueAnswer();
        errSpy.mockRestore();
      }
    });
  }

  it("recycle: a refusal is a 409 even without `remote`, and is logged as refused, not failed", async () => {
    authorized();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = `${RECYCLE_REFUSED_PREFIX}the container did not answer an 8s probe.`;
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }),
      envWithThrowingVerb("recycle", new Error(refusal)),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(refusal);
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(`studio ${STUDIO_ID} recycle refused`);
    expect(logged).not.toContain("recycle failed");
  });

  it("recycle: ?discard-unsynced=true reaches the DO; absent, it is false", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const recycle = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const ns = { ...fakeNs, get: () => ({ ...stub, recycle }) };
    const e = { ...testEnv, STUDIO: ns } as unknown as Env;
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle?discard-unsynced=true`, { method: "POST" }), e);
    expect((recycle.mock.calls as unknown[][]).map((c) => c[1])).toEqual([false, true]);
  });

  // Issue #28: `--fresh-session` rides a query param on both verbs, same
  // shape as recycle's discard-unsynced, and reaches the DO as
  // cfg.freshSession for that ONE call. Absent = the field is absent.
  it("#28: provision and recycle ?fresh-session=true reach the DO as cfg.freshSession; absent, no field", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const provision = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recycle = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const ns = { ...fakeNs, get: () => ({ ...stub, provision, recycle }) };
    const e = { ...testEnv, STUDIO: ns } as unknown as Env;
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision?fresh-session=true`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle?fresh-session=true&discard-unsynced=true`, { method: "POST" }), e);
    const pcfg = (provision.mock.calls as unknown[][]).map((c) => (c[0] as ProvisionConfig).freshSession);
    const rcfg = (recycle.mock.calls as unknown[][]).map((c) => [(c[0] as ProvisionConfig).freshSession, c[1]]);
    expect(pcfg).toEqual([undefined, true]);
    expect(rcfg).toEqual([[undefined, false], [true, true]]);
  });

  // Issue #115: `--no-fresh-session` rides `?no-fresh-session=true` on the
  // provision route only (recycle's own `--fresh-session` is untouched — see
  // the plan doc's explicit out-of-scope note) and reaches the DO as
  // cfg.cancelFreshSession for that ONE call. Absent = the field is absent.
  // Sending BOTH params at once is refused outright (400), never silently
  // resolved either way.
  it("#115: provision ?no-fresh-session=true reaches the DO as cfg.cancelFreshSession; both at once is a 400", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const provision = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const ns = { ...fakeNs, get: () => ({ ...stub, provision }) };
    const e = { ...testEnv, STUDIO: ns } as unknown as Env;
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision?no-fresh-session=true`, { method: "POST" }), e);
    const pcfg = (provision.mock.calls as unknown[][]).map((c) => (c[0] as ProvisionConfig).cancelFreshSession);
    expect(pcfg).toEqual([undefined, true]);

    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision?fresh-session=true&no-fresh-session=true`, { method: "POST" }), e,
    );
    expect(res.status).toBe(400);
    expect(provision.mock.calls.length).toBe(2);
  });

  // Issue #231: `?discard-session=true` rides a query param on the provision
  // route only, same shape as `?fresh-session=true`, and reaches the DO as
  // cfg.discardSession.
  it("#231: provision ?discard-session=true reaches the DO as cfg.discardSession; absent, no field", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const provision = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const ns = { ...fakeNs, get: () => ({ ...stub, provision }) };
    const e = { ...testEnv, STUDIO: ns } as unknown as Env;
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision?fresh-session=true`, { method: "POST" }), e);
    await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision?fresh-session=true&discard-session=true`, { method: "POST" }), e,
    );
    const pcfg = (provision.mock.calls as unknown[][]).map((c) => (c[0] as ProvisionConfig).discardSession);
    expect(pcfg).toEqual([undefined, true]);
  });

  // Issue #231: the involuntary-stop refusal (provisionWithStorage) is
  // recognised by its message prefix, same "a decision, not a failure"
  // posture recycle's own RECYCLE_REFUSED_PREFIX check already takes.
  it("#231: provision refused (involuntary-stop recovery) is a 409 carrying the whole message, verbatim", async () => {
    authorized();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = `${FRESH_SESSION_REFUSED_PREFIX}studio ${STUDIO_ID}'s last stop was an involuntary platform ` +
      "replacement, and its session has ~40 lines of transcript (a turn-count proxy) -- --fresh-session would " +
      `discard it. Use plain provision to resume, or add --discard-session to force it: fleet provision ${STUDIO_ID} ` +
      "--fresh-session --discard-session";
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision?fresh-session=true`, { method: "POST" }),
      envWithThrowingVerb("provision", Object.assign(new Error(refusal), { remote: true })),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(refusal);
  });

  // Board task #131 ask 2: `fleet recycle <id> --account mapped` rides
  // `?account=mapped`, same query-string convention as `?fresh-session=true`
  // above, and reaches the DO as cfg.forceMappedAccount for that ONE call.
  // Absent, or any other value, leaves the field absent.
  it("#131: recycle ?account=mapped reaches the DO as cfg.forceMappedAccount; absent (or any other value), no field", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const recycle = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const ns = { ...fakeNs, get: () => ({ ...stub, recycle }) };
    const e = { ...testEnv, STUDIO: ns } as unknown as Env;
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle?account=mapped`, { method: "POST" }), e);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle?account=primary`, { method: "POST" }), e);
    const rcfg = (recycle.mock.calls as unknown[][]).map((c) => (c[0] as ProvisionConfig).forceMappedAccount);
    expect(rcfg).toEqual([undefined, true, undefined]);
  });

  it("inspect: a DO failure says only what is known — the container may or may not have been reached", async () => {
    authorized();
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/inspect`), envWithThrowingVerb("inspect", rpcFailure()),
    );
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toContain("Worker->DO call failed; the container may or may not have been reached");
    expect(body.error).not.toContain("before the container was read");
    expect(body.error).toContain("retryable=false");
  });
});

/**
 * Issue #217: a repo mapped to an unlaunchable account (an unset secret, or
 * every account fleet-wide limited — #209/#211) makes do.ts's
 * `launchAccountOrRefuse`/`refuseUnlessMappedAccountLaunchable` throw
 * `LaunchRefusedError` from INSIDE the StudioDO. Before this fix, provision's
 * and restart's catch blocks (routes.ts) checked only
 * `threwInsideDurableObject` and bare-rethrew anything else — a thrown error
 * with NOTHING above it to catch, which Cloudflare renders as an opaque
 * "Worker threw exception" 1101 page, the exact symptom reported. recycle's
 * own catch had a narrower version of the same gap: it checked
 * `RECYCLE_REFUSED_PREFIX` first, but a `LaunchRefusedError`'s message never
 * carries that prefix, so it fell through to the generic 500 path instead —
 * wrong status, though at least a real Response, never a bare throw.
 *
 * `StartRefusedError` (issue #123's start gate) gets the identical fix for
 * provision/restart — `studio.destroy-race.test.ts`'s own T6 coverage proves
 * it reaches `provision()` uncaught the same way (a destroy racing the op's
 * own first container-start attempt). It does NOT need the same fix for
 * recycle: recycleWithSync's own try/catch (do.ts) already intercepts it
 * there and re-throws it already renamed into the SAME "recycle failed before
 * reprovisioning could start: ..." bucket `routes.test.ts`'s own "an error the
 * DO's own code threw (remote) keeps the 500" test (above) already covers —
 * never reaching routes.ts carrying `START_REFUSED_PREFIX` at all, so no new
 * recycle case exists to add for it.
 *
 * Simulates the RPC crossing exactly like every other test in this file:
 * `Object.assign(<err>, { remote: true })` — tagging `remote: true` is the
 * repo's own stand-in for "this error already crossed the Worker<->DO RPC
 * boundary" (Workers RPC sets that flag itself; nothing else survives the
 * boundary intact). `<err>` carries a message computed from the REAL `LaunchRefusedError`/
 * `StartRefusedError` (do.ts), constructed the same way the DO's own code
 * constructs it, never a hand-typed `LAUNCH_REFUSED_PREFIX + "..."` string —
 * a mutation test (maestro review round, issue #217) found that hand-typed
 * version passed green even with the prefix-prepending lines deleted from
 * BOTH constructors, because the fixture already carried the prefix
 * independently of whatever the constructor did. Using the real constructor
 * to compute the message means these tests can only pass if
 * `new LaunchRefusedError(reason).message` genuinely starts with
 * `LAUNCH_REFUSED_PREFIX` (ditto `StartRefusedError`/`START_REFUSED_PREFIX`)
 * — the one property `launchOrStartRefusalResponse` actually depends on,
 * pinned at its real source instead of asserted by construction. The object
 * that actually crosses the simulated RPC boundary, though, is a plain
 * `Error` wrapping that message — never the `LaunchRefusedError`/
 * `StartRefusedError` instance itself — because real Workers RPC strips
 * subclass identity when an error crosses the Worker<->DO boundary; only
 * `.message` (and explicitly-tagged properties like `remote: true`) survive
 * (a follow-up mutation test, issue #225, found that keeping the subclass
 * identity in the fixture let a `constructor === Error` guard mutant survive
 * undetected in `launchOrStartRefusalResponse`, since no fixture ever
 * produced a plain `Error` the way real crossed errors always do).
 */
describe("LaunchRefusedError/StartRefusedError surface as 409, not an uncaught 500 (#217)", () => {
  const EARLIEST_RESET_REASON = "claude account: every account limited; earliest reset 2026-10-03T12:00:00.000Z";

  for (const { action, method, init } of [
    { action: "provision", method: "provision", init: { method: "POST", body: "{}" } },
    { action: "restart", method: "restartStudio", init: { method: "POST" } },
  ] as const) {
    it(`${action}: a LaunchRefusedError (every account fleet-wide limited) is a 409 naming the earliest reset, never an uncaught throw`, async () => {
      authorized();
      const refusal = Object.assign(new Error(new LaunchRefusedError(EARLIEST_RESET_REASON).message), { remote: true });
      const res = await handleStudio(
        authorizedReq(`/studio/${STUDIO_ID}/${action}`, init), envWithThrowingVerb(method, refusal),
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe(EARLIEST_RESET_REASON);
      expect(body.error).toContain("earliest reset");
    });

    it(`${action}: a StartRefusedError (a destroy raced the op's own first start) is also a 409, never an uncaught throw`, async () => {
      authorized();
      const refusal = Object.assign(
        new Error(new StartRefusedError(`studio ${STUDIO_ID} is stopped — \`ff ${STUDIO_ID}\` to start it`).message),
        { remote: true },
      );
      const res = await handleStudio(
        authorizedReq(`/studio/${STUDIO_ID}/${action}`, init), envWithThrowingVerb(method, refusal),
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("is stopped");
    });
  }

  it("recycle: a LaunchRefusedError (recycle()'s own entry-time refusal, before recycleWithSync ever runs) is a 409 naming the reason", async () => {
    authorized();
    const refusal = Object.assign(new Error(new LaunchRefusedError(EARLIEST_RESET_REASON).message), { remote: true });
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), envWithThrowingVerb("recycle", refusal),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(EARLIEST_RESET_REASON);
  });
});
