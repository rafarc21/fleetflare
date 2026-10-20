// apps/fleet/test/llm.model-store.test.ts
// Persistence layer for #717's model pool (spec 2026-10-13-model-pool-design),
// built on the existing fleet_state flag table — no migration. Same
// cloudflare:test convention as test/llm.anthropic-core.test.ts and
// test/llm.anthropic-stream.test.ts (split from the former llm.anthropic-route.test.ts, #919).
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  getAssignedModel, setAssignedModel, getModelStates, setModelState,
  recordNoFinishReasonFailure, getNoFinishReasonFailures, clearNoFinishReasonFailures,
  NO_FINISH_REASON_WINDOW_MS,
} from "../src/llm/model-store";
import { POOL } from "../src/llm/models";

describe("model store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM fleet_state").run();
  });

  it("assignment round-trips for a pool model", async () => {
    await setAssignedModel(env.DB, "r--web-studio--49", POOL[1].id);
    expect(await getAssignedModel(env.DB, "r--web-studio--49")).toBe(POOL[1].id);
  });

  it("absent assignment reads null", async () => {
    expect(await getAssignedModel(env.DB, "r--web-studio--99")).toBeNull();
  });

  it("unknown stored id reads null (never trusted)", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`,
    ).bind("lead-model:r--x", "@cf/typo/x", Date.now()).run();
    expect(await getAssignedModel(env.DB, "r--x")).toBeNull();
  });

  it("set refuses unknown model", async () => {
    await expect(setAssignedModel(env.DB, "r--y", "@cf/typo/x")).rejects.toThrow(/unknown model/);
  });

  it("states default to active; set persists", async () => {
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("active");
    await setModelState(env.DB, POOL[2].id, "demoted");
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("demoted");
  });

  // Issue #1228: the no_finish_reason streak counter — a `count|expiresAtMs`
  // pair in one fleet_state row, one shared expiry per fingerprint (same
  // shape markRunawayAvoid already uses). Pinned here, not at the route
  // level, so the sliding-window math is proven independently of the route.
  it("no_finish_reason counter counts up per fingerprint and returns the new total", async () => {
    const now = 1_000_000;
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-a", now)).toBe(0);
    expect(await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now)).toBe(1);
    expect(await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now)).toBe(2);
    expect(await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now)).toBe(3);
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-a", now)).toBe(3);
    // A different fingerprint (or studio) has its own streak.
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-b", now)).toBe(0);
    expect(await getNoFinishReasonFailures(env.DB, "s2", "hash-a", now)).toBe(0);
  });

  it("no_finish_reason counter expires as one shared window and resets once stale", async () => {
    const now = 1_000_000;
    await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now);
    await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now);
    // Before the window expires the streak is live.
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-a", now + NO_FINISH_REASON_WINDOW_MS - 1)).toBe(2);
    // At exactly the expiry the streak is dead.
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-a", now + NO_FINISH_REASON_WINDOW_MS)).toBe(0);
    // A new failure after expiry starts a fresh streak of 1, not 3.
    expect(await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now + NO_FINISH_REASON_WINDOW_MS)).toBe(1);
  });

  it("clearNoFinishReasonFailures drops the streak entirely", async () => {
    const now = 1_000_000;
    await recordNoFinishReasonFailure(env.DB, "s", "hash-a", now);
    await clearNoFinishReasonFailures(env.DB, "s", "hash-a");
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-a", now)).toBe(0);
  });

  // Finding 2 (fresh-context review of #1228, PR #1235): recordNoFinishReasonFailure
  // used to be getFlag-then-setFlag -- two non-atomic round trips, the exact
  // shape state.ts's own incrementCounter doc comment (PR #9 review, BLOCKER
  // F1) says let 20 concurrent calls against a cap of 3 all succeed. The
  // retry/failover walk can call this more than once per request across
  // models, plus genuinely concurrent client retries, for the SAME
  // studio+fingerprint -- same atomicity proof as state.test.ts's own
  // incrementCounter race test: N genuinely concurrent calls against the
  // same key must produce N distinct sequential totals (1..N), never two
  // callers seeing (and writing) the same post-increment value.
  it("N concurrent calls against the same studio+fingerprint see N distinct sequential totals (1..N)", async () => {
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, () => recordNoFinishReasonFailure(env.DB, "s", "hash-race", 1_000_000)),
    );
    expect(new Set(results).size).toBe(n);
    expect(Math.max(...results)).toBe(n);
    expect(await getNoFinishReasonFailures(env.DB, "s", "hash-race", 1_000_000)).toBe(n);
  });
});
