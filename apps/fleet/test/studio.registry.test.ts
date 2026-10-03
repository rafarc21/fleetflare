import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { listStudios, recordStudio, getStudioRow, getStudioRowLookup } from "../src/studio/registry";
import { writeFleetAccountLimit } from "../src/studio/account-limits-store";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { emptyObserved } from "../src/studio/observed";

// readiness: null (not omitted) — recordStudio (registry.ts's own
// cleanReadiness) normalizes an absent readiness to explicit null on every
// write, so a row read back via listStudios always carries the key. This
// default matches that reality; a test asserting on a specific verdict
// overrides it explicitly.
function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    readiness: null,
    ...overrides,
  };
}

// Same reset src/state.ts's own test/state.test.ts uses: env.DB is isolated
// per test FILE (see test/apply-migrations.ts) but persists across tests
// WITHIN a file, and registry.ts shares the same fleet_state table.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

/** What recordStudio stored: listStudios also stamps the ACCOUNT display
 *  (withAccountDisplay: `?` + next launch for a row with no launch record,
 *  #292 r2), which is a view, not part of the round trip under test here. */
function stored(s: StudioStatus): StudioStatus {
  const { claudeAccount: _a, claudeAccountNext: _n, claudeAccountLabel: _l, ...rest } = s;
  return rest;
}

describe("studio registry", () => {
  it("listStudios is empty before anything is recorded", async () => {
    expect(await listStudios(env)).toEqual([]);
  });

  it("recordStudio then listStudios returns it", async () => {
    await recordStudio(env, status({ id: "websites--reg1" }));
    const all = await listStudios(env);
    expect(all.map(stored)).toEqual([status({ id: "websites--reg1" })]);
  });

  it("recordStudio twice for the same id overwrites, not duplicates", async () => {
    await recordStudio(env, status({ id: "websites--reg2", state: "provisioning" }));
    await recordStudio(env, status({ id: "websites--reg2", state: "running", tailscaleHost: "reg2.tail" }));
    const all = await listStudios(env);
    const matches = all.filter((s) => s.id === "websites--reg2");
    expect(matches).toHaveLength(1);
    expect(stored(matches[0])).toEqual(status({ id: "websites--reg2", state: "running", tailscaleHost: "reg2.tail" }));
  });

  it("listStudios reflects every distinct recorded id", async () => {
    await recordStudio(env, status({ id: "websites--reg3a" }));
    await recordStudio(env, status({ id: "websites--reg3b" }));
    await recordStudio(env, status({ id: "otherrepo--reg3c" }));
    const ids = (await listStudios(env)).map((s) => s.id).sort();
    expect(ids).toEqual(["otherrepo--reg3c", "websites--reg3a", "websites--reg3b"]);
  });

  it("does not leak non-studio fleet_state rows into listStudios", async () => {
    await env.DB
      .prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`)
      .bind("rearm:some-task", "3", Date.now())
      .run();
    await recordStudio(env, status({ id: "websites--reg4" }));
    const all = await listStudios(env);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("websites--reg4");
  });

  // Review round 2, Spec 5: recordStudio scrubs on write now, not just
  // provision.ts's own catch-time scrub — checked against the RAW stored
  // row (not just listStudios' output), so this actually proves the scrub
  // happens at the WRITE boundary, not merely that the value looks clean by
  // the time something reads it back.
  it("recordStudio scrubs a secret out of the stored row itself", async () => {
    await recordStudio(env, status({
      id: "websites--reg5", state: "degraded",
      error: "refresh failed: ghs_secretsecret and tskey-auth-kABC123CNTRL-xyzxyzxyzxyzxyz rejected",
    }));
    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--reg5")
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_");
    expect(row!.value).not.toContain("tskey-auth-");
  });

  // Task 7 review round 1, C2: lastRefreshError (src/studio/do.ts's own
  // refresh-streak marker) carries the exact same secret-shaped risk
  // `error` does, and is scrubbed at the same write boundary — same "check
  // the RAW stored row" method as the test just above.
  it("recordStudio scrubs a secret out of lastRefreshError too, independent of error", async () => {
    await recordStudio(env, status({
      id: "websites--reg5b", state: "degraded",
      error: "clone failed: permission denied", // unrelated to the refresh secret below
      lastRefreshError: "credential write failed: ghs_refreshsecretvalue rejected",
    }));
    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--reg5b")
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_");
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.error).toBe("clone failed: permission denied"); // untouched
    expect(parsed.lastRefreshError).not.toContain("ghs_");
  });

  it("recordStudio leaves a null error alone (no crash, nothing to scrub)", async () => {
    await recordStudio(env, status({ id: "websites--reg6", error: null }));
    const all = await listStudios(env);
    expect(all.find((s) => s.id === "websites--reg6")?.error).toBeNull();
  });

  // Review round 2, Spec 5: one malformed row (hand-edited D1 data, a
  // future write path that isn't recordStudio) must not fail the whole
  // listing for every other studio.
  it("listStudios skips a malformed row instead of throwing", async () => {
    await env.DB
      .prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`)
      .bind("studio:websites--broken", "{not valid json", Date.now())
      .run();
    await recordStudio(env, status({ id: "websites--reg7" }));

    const all = await listStudios(env);
    expect(all.map((s) => s.id)).toEqual(["websites--reg7"]);
  });

  // Same one-bad-row posture as listStudios above, at N=1: getStudioRow's
  // own malformed-JSON branch (registry.ts) had no direct unit test.
  it("getStudioRow returns null for a malformed row instead of throwing", async () => {
    await env.DB
      .prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`)
      .bind("studio:websites--broken2", "{not valid json", Date.now())
      .run();
    expect(await getStudioRow(env, "websites--broken2")).toBeNull();
  });

  // Issue #136: getStudioRow's own null-for-both contract (test above) is
  // right for its existing callers, but profile.ts's getStudioStub needs to
  // tell "never provisioned" apart from "has a row, can't read it" -- see
  // getStudioRowLookup's own doc comment in registry.ts. Three states, one
  // test per state, same raw-SQL-insert technique the malformed-row test
  // above already uses.
  describe("getStudioRowLookup", () => {
    it("is absent for an id with no row at all", async () => {
      expect(await getStudioRowLookup(env, "websites--neverwritten")).toEqual({ kind: "absent" });
    });

    it("is malformed for a row that fails to parse, distinct from absent", async () => {
      await env.DB
        .prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`)
        .bind("studio:websites--broken3", "{not valid json", Date.now())
        .run();
      expect(await getStudioRowLookup(env, "websites--broken3")).toEqual({ kind: "malformed" });
    });

    it("is found with the parsed row for a real, well-formed row", async () => {
      await recordStudio(env, status({ id: "websites--reg8" }));
      const result = await getStudioRowLookup(env, "websites--reg8");
      expect(result.kind).toBe("found");
      expect(result.kind === "found" && stored(result.row)).toEqual(status({ id: "websites--reg8" }));
    });
  });

  // Fleet ls readiness fix ("a dead studio looks alive"): readiness.reason
  // carries container stdout/stderr verbatim (do.ts's runProvisionedCheck),
  // the same secret-shaped risk error/lastRefreshError already carry above —
  // scrubbed at the same write boundary, same "check the RAW stored row"
  // method those tests use.
  it("recordStudio scrubs a secret out of a bare readiness.reason", async () => {
    await recordStudio(env, status({
      id: "websites--reg8",
      readiness: { kind: "bare", reason: "no checkout: ghs_secretsecret leaked in clone error", checkedAt: "2026-08-28T00:00:00.000Z" },
    }));
    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--reg8")
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_");
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.readiness?.kind).toBe("bare");
    expect(parsed.readiness && "reason" in parsed.readiness ? parsed.readiness.reason : null).not.toContain("ghs_");
  });

  it("recordStudio leaves a provisioned readiness alone (no reason field to scrub)", async () => {
    const readiness = { kind: "provisioned" as const, checkedAt: "2026-08-28T00:00:00.000Z" };
    await recordStudio(env, status({ id: "websites--reg9", readiness }));
    const all = await listStudios(env);
    expect(all.find((s) => s.id === "websites--reg9")?.readiness).toEqual(readiness);
  });

  it("recordStudio scrubs a secret out of observed.session.reason", async () => {
    await recordStudio(env, status({
      id: "websites--reg12",
      observed: {
        ...emptyObserved(),
        session: {
          verdict: "lost", at: "2026-09-24T10:00:00.000Z", via: "restart",
          restore: "not-attempted", snapshotAgeS: null, turnsBefore: 3,
          reason: "pane probe failed: ghs_secretsecret leaked in exec error",
        },
      },
    }));
    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--reg12")
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_");
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.observed?.session?.verdict).toBe("lost");
    expect(parsed.observed?.session?.reason).not.toContain("ghs_");
  });

  it("recordStudio leaves a null session (no reason to scrub) and a missing observed alone", async () => {
    await recordStudio(env, status({ id: "websites--reg13", observed: { ...emptyObserved() } }));
    const withObserved = (await listStudios(env)).find((s) => s.id === "websites--reg13");
    expect(withObserved?.observed).toEqual(emptyObserved());

    await recordStudio(env, status({ id: "websites--reg14" })); // no `observed` key at all
    const withoutObserved = (await listStudios(env)).find((s) => s.id === "websites--reg14");
    expect(withoutObserved?.observed).toBeUndefined();
  });

  it("recordStudio normalizes a TRULY absent readiness (key never set) to null — round-trips through listStudios as null, not undefined", async () => {
    // Deliberately NOT status() here: that helper's own default now sets an
    // explicit `readiness: null` (see its comment above), which would no
    // longer exercise this path. This needs a literal that omits the KEY
    // entirely — the shape every StudioStatus written before this field
    // existed actually has.
    const withoutReadinessKey: StudioStatus = {
      id: "websites--reg10", state: "running", tailscaleHost: null, lastRefresh: null,
      error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    };
    expect("readiness" in withoutReadinessKey).toBe(false); // sanity: genuinely absent, not merely null

    await recordStudio(env, withoutReadinessKey);
    const all = await listStudios(env);
    const found = all.find((s) => s.id === "websites--reg10");
    expect(found?.readiness).toBeNull();
    expect(found && "readiness" in found).toBe(true); // present now, not merely absent-and-undefined
  });

  it("recordStudio then listStudios round-trips an inconclusive readiness verdict, checkedAt included", async () => {
    const readiness = { kind: "inconclusive" as const, reason: "check produced no verdict (exit 1)", checkedAt: "2026-08-28T00:05:00.000Z" };
    await recordStudio(env, status({ id: "websites--reg11", readiness }));
    const all = await listStudios(env);
    expect(all.find((s) => s.id === "websites--reg11")?.readiness).toEqual(readiness);
  });
  // Issue #56: a row the DEPLOYED main Worker wrote carries no
  // `observed.restarts` (and a pre-#85 row no `observed` at all). The new
  // Worker must list both, never skip them as malformed.
  it("#56: rows written by main (no restart count) still list, with restarts absent", async () => {
    const mainRow = JSON.stringify({
      id: "acmeclient--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: "example-org/acmeclient",
      readiness: null,
      observed: {
        incarnation: "11111111-2222-3333-4444-555555555555", replacedAt: null, execFailures: 0, unreachableSince: null,
        lastShipOkAt: "2026-09-29T10:00:00.000Z", lastSnapshotAt: null, session: null, activity: null, memberAlerts: null,
        survivalBriefDeliveredFor: null, survivalBriefPending: null,
      },
    });
    const preObservedRow = JSON.stringify({
      id: "acmeclient--old", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });
    for (const [key, value] of [["studio:acmeclient--lead", mainRow], ["studio:acmeclient--old", preObservedRow]]) {
      await env.DB.prepare("INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, 0)").bind(key, value).run();
    }
    const errors = vi.spyOn(console, "error");
    const all = await listStudios(env);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(all.map((s) => s.id).sort()).toEqual(["acmeclient--lead", "acmeclient--old"]);
    expect(all.find((s) => s.id === "acmeclient--lead")?.observed?.restarts).toBeUndefined();
  });

  // Issue #213 — fleet ls' "next launch" column used to be stamped by the
  // plain, limit-UNAWARE `launchAccount` (withAccountDisplay's old call),
  // which never consulted the fleet-wide AccountLimits map the real launch
  // gate (do.ts's launchAccountOrRefuse, via accounts.ts's own
  // launchAccountOrReroute) already does. A fleet-wide rate-limited mapped
  // account showed as "next" even though a REAL launch would reroute around
  // it via the same three-tier cascade — display-only staleness, but a
  // column that could disagree with where a launch actually lands. Fixture
  // reused from studio.account-by-repo.test.ts's own launchAccountOrReroute
  // suite ("mapped slot fleet-wide limited, another slot free: reroutes to
  // the free one"), exercised here at the listStudios/fleet-ls integration
  // level instead of calling the gate directly, to prove the DISPLAY agrees.
  describe("listStudios' claudeAccountNext reroutes around a fleet-wide limited account (#213)", () => {
    const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
    const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
    const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
    const MAP = '{"demosite-life":2}';
    const RESET_SOON = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const SEEN_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    function envWith(vars: Record<string, string>): Env {
      return { ...env, ...vars } as unknown as Env;
    }

    it("mapped account fleet-wide limited, auto-failover on: shows the rerouted account, never the limited mapped one", async () => {
      const limitedEnv = envWith({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
        CLAUDE_ACCOUNT_BY_REPO: MAP, FLEET_AUTO_FAILOVER: "on",
      });
      await recordStudio(limitedEnv, status({ id: "demosite-life--lead" }));
      await writeFleetAccountLimit(limitedEnv.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", RESET_SOON, SEEN_AT);

      const rows = await listStudios(limitedEnv);
      const row = rows.find((r) => r.id === "demosite-life--lead");
      // The plain, limit-unaware launchAccount would answer the mapped slot
      // (CLAUDE_CODE_OAUTH_TOKEN_2) unconditionally; the real gate reroutes
      // to the next free account in this repo's own scoped chain (slot 3).
      expect(row?.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    });

    it("auto-failover off: a fleet-wide limited mapped account still shows unchanged — no reroute, same as before #213", async () => {
      const env2 = envWith({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
        CLAUDE_ACCOUNT_BY_REPO: MAP,
        // FLEET_AUTO_FAILOVER left unset -> off.
      });
      await recordStudio(env2, status({ id: "demosite-life--lead2" }));
      await writeFleetAccountLimit(env2.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", RESET_SOON, SEEN_AT);

      const rows = await listStudios(env2);
      const row = rows.find((r) => r.id === "demosite-life--lead2");
      expect(row?.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2"); // mapped slot, unchanged despite the limit
    });

    // Fresh-context review of #213, finding 2 — listStudios' own fail-open
    // try/catch around readFleetAccountLimits (mirroring do.ts's established
    // "env.DB.prepare throws" pattern, which DOES have a direct test — see
    // studio.account-by-repo.test.ts's "env.DB.prepare throws: the
    // fleet-wide limits read is caught..." test) had no equivalent test of
    // its own here, only a comment asserting the behavior. Poisons only the
    // `account-limit:` prefixed key (same scoped-poisoning shape as that
    // file's "readFleetAccountBurn throws" test, which poisons only
    // `account-burn:`), leaving the row's own SELECT untouched, so the
    // listing itself must still succeed with limits treated as `{}`.
    it("D1 read failure in readFleetAccountLimits: listing still succeeds, next-launch falls back as if nothing were limited (fail open)", async () => {
      const workingEnv = envWith({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2,
        CLAUDE_ACCOUNT_BY_REPO: MAP, FLEET_AUTO_FAILOVER: "on",
      });
      await recordStudio(workingEnv, status({ id: "demosite-life--failopen" }));

      const realPrepare = env.DB.prepare.bind(env.DB);
      const poisonedDb = {
        prepare(sql: string) {
          const stmt = realPrepare(sql);
          return {
            bind(...args: unknown[]) {
              if (typeof args[0] === "string" && args[0].startsWith("account-limit:")) {
                return { first: async () => { throw new Error("D1 account-limit read unavailable"); } };
              }
              return stmt.bind(...args);
            },
          };
        },
      } as unknown as D1Database;
      const poisoned = { ...workingEnv, DB: poisonedDb } as unknown as Env;

      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const rows = await listStudios(poisoned);
        const row = rows.find((r) => r.id === "demosite-life--failopen");
        expect(row).toBeDefined();
        // Fail-open: limits treated as {} -- next launch is the plain mapped
        // account, same as if nothing were fleet-wide limited (equivalent to
        // the account display falling back to the mapped/recorded account).
        expect(row?.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
        expect(warns).toHaveBeenCalled();
        expect(warns.mock.calls.some((c) => c.join(" ").includes("readFleetAccountLimits"))).toBe(true);
      } finally {
        warns.mockRestore();
      }
    });
  });
});
