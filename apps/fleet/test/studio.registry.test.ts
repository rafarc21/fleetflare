import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { listStudios, recordStudio, getStudioRow, getStudioRowLookup } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
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
});
