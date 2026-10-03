import { describe, it, expect } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  launchAccountOrRefuse, launchAccountName, recordLaunchedAccount, constructorLaunch,
  decideAccountClears, applyAccountClears, clearForceMappedAccount, refuseUnlessMappedAccountLaunchable,
} from "../src/studio/do";
import { otherRepoPrimaries, type AccountLimits } from "../src/studio/accounts";
import { withAccountDisplay } from "../src/studio/registry";
import { STATUS_KEY, NEVER_MOVED_CTX, type StudioStorage, type OpCtx } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { MAIN_ROWS } from "./fixtures/account-rows-main";

// ---------------------------------------------------------------------------
// Issue #289 — the ACCOUNT column must show the account a studio's container
// was LAUNCHED on. Measured 2026-09-25 ~13:50Z after deploy 275e05cf
// (CLAUDE_ACCOUNT_BY_REPO {"demosite-life":2}): running demosite-life studios,
// launched earlier on account 1, read CLAUDE_CODE_OAUTH_TOKEN_2 — the map,
// not the launch — and the operator kept burning account 1.
// Issue #285 — a REFUSED launch (failover off, mapped secret missing) kept a
// stale recorded account name in the column while its error named slot 2.
//
// Fake tokens only (redact.ts's `sk-ant-` shape).
// ---------------------------------------------------------------------------

const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
const ALL = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3 };
const MAP_2 = '{"demosite-life":2}';
// #211 review round 3, finding 1 -- decideAccountClears now needs repo/
// reserved to compute the borrow fields, the same way accountClears'
// inline commitOkClears branch always has. Every test below launches a
// "demosite-life--pilot" studio under MAP_2 (a single-repo map, so no
// account is any OTHER repo's reserved primary) -- fixed constants.
const REPO = "demosite-life";
const RESERVED = otherRepoPrimaries({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }, REPO);
// Issue #213: withAccountDisplay now takes the same limits/reserved/now the
// real launch gate consults. `{}` is the "nothing is fleet-wide limited"
// no-op input -- every withAccountDisplay test below is unchanged from
// before the reroute-awareness fix, so it passes this through literally.
const NO_LIMITS: AccountLimits = {};

// Issue #209: launchAccountOrRefuse now reads env.DB (when auto-failover is
// on) to consult the fleet-wide AccountLimits map -- merging in ONLY the real
// (migrated, empty-by-default) cloudflare:test D1 keeps every EXISTING test
// below behaving exactly as before (an empty fleet_state table reads back as
// "no limits recorded", i.e. every account free).
function envWith(vars: Record<string, string>): Env {
  return { ...vars, DB: testEnv.DB } as unknown as Env;
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "demosite-life--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

function fakeStorage(initial?: StudioStatus): StudioStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

describe("launchAccountName — the account a container start's env carries", () => {
  it("names the mapped account, the same one studioEnvVars puts in CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(launchAccountName(envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }), "demosite-life--pilot", null))
      .toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("null when the mapping cannot launch (the start is refused anyway)", () => {
    expect(launchAccountName(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }), "demosite-life--pilot", null))
      .toBeNull();
  });
});

describe("recordLaunchedAccount — every container start records what it launched on (#289)", () => {
  it("writes launchedAccount onto the stored row", async () => {
    const storage = fakeStorage(status());
    const recorded: StudioStatus[] = [];
    await recordLaunchedAccount(storage, "demosite-life--pilot", "CLAUDE_CODE_OAUTH_TOKEN", async (s) => { recorded.push(s); });
    expect((await storage.get(STATUS_KEY))?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(recorded.at(-1)?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("an unchanged account writes nothing", async () => {
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
    const recorded: StudioStatus[] = [];
    await recordLaunchedAccount(storage, "demosite-life--pilot", "CLAUDE_CODE_OAUTH_TOKEN_2", async (s) => { recorded.push(s); });
    expect(recorded).toHaveLength(0);
  });
});

describe("recordLaunchedAccount(undefined) — an unknown launch clears the record (#292 r2)", () => {
  it("removes launchedAccount, so the column reads `?` rather than a guess", async () => {
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    await recordLaunchedAccount(storage, "demosite-life--pilot", undefined, async () => {});
    const row = (await storage.get(STATUS_KEY))!;
    expect("launchedAccount" in row).toBe(false);
    const shown = await withAccountDisplay(envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }), row, NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("?");
  });
});

describe("constructorLaunch — a DO restart reads the launch back, never re-derives it (#292 r2)", () => {
  const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });

  it("launched on account 1, map now says 2: env carries account 1's token and names account 1", () => {
    const got = constructorLaunch(env, "demosite-life--pilot", "spawn-token", status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    expect(got.envAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(got.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
  });

  it("no launch record: today's mapping for the token, but the account stays UNKNOWN", () => {
    const got = constructorLaunch(env, "demosite-life--pilot", "spawn-token", status());
    expect(got.envAccount).toBeUndefined();
    expect(got.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
  });

  it("a recorded account whose secret is gone: today's mapping, account unknown", () => {
    const two = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const got = constructorLaunch(two, "demosite-life--pilot", "spawn-token", status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    expect(got.envAccount).toBeUndefined();
    expect(got.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
  });

  it("a fresh DO (no row at all): account unknown", () => {
    expect(constructorLaunch(env, "demosite-life--pilot", "spawn-token", undefined).envAccount).toBeUndefined();
  });
});

// The DO itself cannot be constructed under vitest-pool-workers (container-
// backed), so its WIRING is pinned in the source: every start records what it
// launched on, and each envVars assignment carries its account beside it.
describe("StudioDO wiring (source) — #292 r2", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };

  it("onStart records the launched account", () => {
    expect(body("async onStart(): Promise<void> {")).toContain("recordLaunchedAccount(this.ctx.storage, this.selfId(), this.envAccount");
  });

  it("the constructor reads the launch back through constructorLaunch", () => {
    const ctor = body("constructor(...args: ConstructorParameters<typeof Sandbox<Env>>) {");
    expect(ctor).toContain("constructorLaunch(");
    expect(ctor).toContain("this.envAccount = launched.envAccount");
  });

  it("every launch site takes envAccount from the launch launchAccountOrRefuse returned", () => {
    // #354: both fields now land in ONE launchFields assignment from `launch`.
    const site = "({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, id, spawnToken, launch.name));";
    const sites = doSrc.split("\n").filter((l) => l.includes(site));
    expect(sites.length).toBe(2);
    // #134 review round 2: both sites now pass `commitOkClears: false` (a
    // trailing `, false`) — see launchAccountOrRefuse's own doc comment.
    const paired = doSrc.match(/const launch = await launchAccountOrRefuse\(this\.env, this\.ctx\.storage, id, this\.recordFn\(\), false\);\n(    \/\/[^\n]*\n)?    \(\{ envVars: this\.envVars, envAccount: this\.envAccount \} = launchFields\(this\.env, id, spawnToken, launch\.name\)\);/g);
    expect(paired?.length).toBe(2);
  });
});

// Issue #328: recycleWithSync's own order is destroy() -> awaitReady() ->
// provision() (do.ts, recycleWithSync's own doc comment). `awaitReady` is
// wired to `sbAwaitReady(this)`, which is `startAndWaitForPorts` -- confirmed
// from the pinned @cloudflare/containers compiled source
// (node_modules/@cloudflare/sandbox/node_modules/@cloudflare/containers/dist/
// lib/container.js): when the container is not already running (always true
// here, `destroy()` just ran), it STARTS the fresh container and then, still
// inside that same call, runs `await this.state.setHealthy(); await
// this.onStart();` -- BEFORE `startAndWaitForPorts` itself resolves. So
// `onStart()` (launchedAccount's one writer, recordLaunchedAccount) fires
// during recycle's own `awaitReady()` step, reading `this.envAccount`
// wherever it stood BEFORE this recycle call -- provisionCore's fresh
// `this.envAccount = launch.name` (provisionUngated, do.ts) runs later, on
// the SAME container that has already started and already recorded the stale
// value. Exactly the spawn-token shape this file's own Task 6 FIX comment
// already describes ("whichever call first touches the container decides,
// permanently..."), for the account instead of the token.
//
// The DO itself cannot be constructed under vitest-pool-workers, so — same
// convention as the "StudioDO wiring (source)" block above — the fix is
// pinned directly in the source: recycle's own `awaitReady` closure must
// reassign `this.envAccount` (and `this.envVars`) to TODAY's launch BEFORE
// `sbAwaitReady(this)` ever runs, not only inside `provisionCore` afterward.
describe("StudioDO.recycle wiring — the account race (#328)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const recycleBody = body("async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {");

  it("resolves this.envAccount from today's launch before the awaitReady call that actually starts the container", () => {
    const envAccountIdx = recycleBody.indexOf("envAccount: this.envAccount } = launchFields(");
    const awaitReadyIdx = recycleBody.indexOf("await sbAwaitReady(this)");
    expect(envAccountIdx).toBeGreaterThan(-1);
    expect(awaitReadyIdx).toBeGreaterThan(-1);
    expect(envAccountIdx).toBeLessThan(awaitReadyIdx);
  });

  it("resolves this.envVars the same way, before the same call — the container's actual token must match too", () => {
    const envVarsIdx = recycleBody.indexOf("({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(");
    const awaitReadyIdx = recycleBody.indexOf("await sbAwaitReady(this)");
    expect(envVarsIdx).toBeGreaterThan(-1);
    expect(awaitReadyIdx).toBeGreaterThan(-1);
    expect(envVarsIdx).toBeLessThan(awaitReadyIdx);
  });
});

// Issue #328 fix round 2 — a fresh review found the first fix's own gap: the
// awaitReady closure re-derived `envVars` fresh (`claudeAccountName()`, a live
// storage read) but reused `envAccount` from `launch`, captured at recycle()'s
// very ENTRY — before recycleWithSync's own pre-destroy phase
// (containerAnswers/syncSessionTick/rescuePush/harvestLearnings, real async
// work) ran. That phase is NOT covered by OPERATION_KEY (see that key's own
// doc comment: scoped to only "the destroy -> reprovision window"), so a
// concurrent runAccountFailover (failover.ts, driven by this studio's own
// independent syncSessionCycle alarm) can land a real account switch and
// write a NEW launchedAccount while the phase is still running — reusing the
// entry-time `launch` for envAccount then clobbers that write the instant
// onStart's recordLaunchedAccount runs, the same class of bug #328 exists to
// eliminate, reached through a different door.
//
// The DO cannot be constructed under vitest-pool-workers (see the "StudioDO
// wiring (source)" block's own doc comment above), so this is a source
// pin, same convention as that block and the "recycle wiring" block above it:
// it fails against the reused-`launch` shape and passes only once the closure
// resolves its OWN fresh launch, in place, immediately before envAccount is
// set from it.
describe("StudioDO.recycle wiring — envAccount re-derived fresh, not reused from entry (#328 fix round 2)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const recycleBody = body("async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {");
  const closureStart = recycleBody.indexOf("async () => {");
  const closureEnd = recycleBody.indexOf("await sbAwaitReady(this);", closureStart) + "await sbAwaitReady(this);".length;
  const closureBody = recycleBody.slice(closureStart, closureEnd);

  it("recycle() resolves the launch TWICE — once to refuse early, once fresh right before the container starts", () => {
    const calls = recycleBody.match(/launchAccountOrRefuse\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("the awaitReady closure calls launchAccountOrRefuse itself, rather than closing over recycle()'s entry-time result", () => {
    expect(closureBody).toContain("launchAccountOrRefuse(");
  });

  it("that fresh call resolves before envAccount is assigned from it, before the container actually starts", () => {
    const launchIdx = closureBody.indexOf("launchAccountOrRefuse(");
    const envAccountIdx = closureBody.indexOf("envAccount: this.envAccount } = launchFields(");
    const awaitReadyIdx = closureBody.indexOf("await sbAwaitReady(this)");
    expect(launchIdx).toBeGreaterThan(-1);
    expect(envAccountIdx).toBeGreaterThan(-1);
    expect(awaitReadyIdx).toBeGreaterThan(-1);
    expect(launchIdx).toBeLessThan(envAccountIdx);
    expect(envAccountIdx).toBeLessThan(awaitReadyIdx);
  });

  // Issue #328, review round 3, finding 1 — same ORDERING as the test above
  // would still pass if a future edit re-inserted a real await BETWEEN the
  // fresh `launch` resolving and `envVars`/`envAccount` landing (e.g. the
  // `await this.claudeAccountName()` this round removes): the doc comment's
  // "atomically" claim was never actually enforced by a test, only by an
  // unstated "storage-only awaits don't reopen the DO input gate" precondition.
  // This asserts the stronger property directly — no `await` token at all in
  // the window between the fresh launch resolving and BOTH assignments landing
  // — so `envVars`/`envAccount` provably come from the SAME resolved `launch`,
  // not two separate reads that merely happen to agree today.
  it("no await runs between the fresh launch resolving and envVars/envAccount both being set from it", () => {
    // #134 review round 4: this call now passes `false` (5th arg) too — see
    // the round 4 describe blocks further down for why.
    const launchStmt = "const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn(), false);";
    const launchStmtIdx = closureBody.indexOf(launchStmt);
    expect(launchStmtIdx).toBeGreaterThan(-1);
    const afterLaunch = launchStmtIdx + launchStmt.length;
    const envAccountStmt = "({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, this.selfId(), spawnToken, launch.name));";
    const envAccountIdx = closureBody.indexOf(envAccountStmt, afterLaunch);
    expect(envAccountIdx).toBeGreaterThan(-1);
    const between = closureBody.slice(afterLaunch, envAccountIdx + envAccountStmt.length);
    // Both assignments must actually live in this window — a test that only
    // checked "no await" without this would pass vacuously if envVars moved
    // outside it. The full literal call, not just its prefix, is required:
    // a prefix-only check ("this.envVars = studioEnvVars(") is satisfied by
    // ANY 4th argument — including a mutant that swaps `launch.name` for
    // `null` or `await this.claudeAccountName()` — and would say nothing
    // about envVars actually deriving from this SAME resolved `launch`,
    // which is the entire point round 3 exists to guarantee.
    // #354: one statement now sets both fields from launchFields(..., launch.name).
    const envVarsStmt = "({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, this.selfId(), spawnToken, launch.name));";
    expect(between).toContain(envVarsStmt);
    expect(between).toContain(envAccountStmt);
    expect(between).not.toMatch(/\bawait\b/);
  });

  // Issue #328, review round 3 mutant found by the maestro: the assertion
  // above already pins the full literal `envVars` call, but this test names
  // the exact failure mode directly — envVars's 4th argument (the account
  // token this container's onStart-triggered request will actually use) must
  // be `launch.name` SPECIFICALLY, not merely "some argument was passed" —
  // so a mutant that swaps it for `null` (or any other value) turns this red
  // even if a future refactor moved the two assignments apart and broke the
  // "between" window check above.
  it("envVars's 4th argument (the account the container actually launches on) is launch.name, not some other value", () => {
    const envVarsStmt = "({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, this.selfId(), spawnToken, launch.name));";
    expect(closureBody).toContain(envVarsStmt);
  });
});

// Same race, at the primitive level: demonstrates WHY the source pin above
// matters, using the exact real functions recycle() calls
// (launchAccountOrRefuse, recordLaunchedAccount) — composed once in the
// buggy "reuse the entry-time resolution" shape and once in the fixed "resolve
// fresh at the point of use" shape. This does NOT execute do.ts's actual
// closure (the DO cannot be constructed here) and so is not, by itself,
// regression coverage of the real wiring — that is what the source-pinning
// block above is for. It exists to make the mechanism concrete: a
// runAccountFailover write landing in recycle's uncovered pre-destroy window
// really does get clobbered by a stale snapshot, and really does survive a
// fresh re-read.
describe("the race the fix above closes, at the primitive level (#328 fix round 2)", () => {
  // #328 review round 3, finding 4: the two scenarios below used to run
  // sequentially against the SAME mutated storage object — harmless only
  // because the fixed scenario happened to overwrite everything the buggy
  // one had touched, fragile to a future edit that doesn't. Each scenario
  // now gets its own independent fixture.
  const env = envWith({ ...ALL, FLEET_AUTO_FAILOVER: "on" });

  function seeded(): { storage: StudioStorage; recordFn: (s: StudioStatus) => Promise<void> } {
    // Recycle's entry: auto-failover on, the studio already recorded on
    // account 1 (an earlier failover put it there) — launchAccountOrRefuse
    // reads that back and resolves account 1, the same `current` derivation
    // runAccountFailover's own read (failover.ts) uses.
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    return { storage, recordFn };
  }

  // Simulated concurrent runAccountFailover: lands DURING recycle's own
  // pre-destroy phase (the window this fix closes) — a completed switch
  // writes BOTH claudeAccount and launchedAccount to the new account
  // (failover.ts's own `switched` object), exactly as production does.
  async function landConcurrentFailover(storage: StudioStorage): Promise<void> {
    const mid = (await storage.get(STATUS_KEY))!;
    await storage.put(STATUS_KEY, { ...mid, claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" });
  }

  it("the buggy shape: a stale entry-time snapshot clobbers a failover that lands mid-recycle", async () => {
    const { storage, recordFn } = seeded();
    const entryLaunch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn);
    expect(entryLaunch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");

    await landConcurrentFailover(storage);

    // The buggy shape: awaitReady reuses recycle()'s entry-time snapshot.
    await recordLaunchedAccount(storage, "demosite-life--pilot", entryLaunch.name, recordFn);
    expect((await storage.get(STATUS_KEY))?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // wrong: clobbers the failover
  });

  it("the fixed shape: a fresh re-read at the point of use survives the same failover", async () => {
    const { storage, recordFn } = seeded();
    // recycle()'s own entry-time call still runs first (issue #271's early
    // refuse); its resolution is simply never carried forward.
    await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn);

    await landConcurrentFailover(storage);

    // The fixed shape: awaitReady resolves fresh, at the point of use.
    const freshLaunch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn);
    expect(freshLaunch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_3"); // the failover's own write, read back
    await recordLaunchedAccount(storage, "demosite-life--pilot", freshLaunch.name, recordFn);
    expect((await storage.get(STATUS_KEY))?.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3"); // correct: survives it
  });
});

// Issue #328, item 4 (board issue): what the wiring fix above is FOR — once
// `recordLaunchedAccount` receives the account a map-driven `launchAccount`
// call resolved (exactly what the fixed `awaitReady` closure now feeds
// `onStart` via `this.envAccount = launch.name`), the column shows the
// mapped account with no stale "next launch" note. This composes the same
// real primitives (`launchAccountOrRefuse`, `recordLaunchedAccount`,
// `withAccountDisplay`) in the shape the fixed `recycle()` calls them in — it
// does NOT execute do.ts's actual wiring (the DO cannot be constructed here),
// so unlike the source-pinning blocks above, this passes identically against
// an unfixed do.ts and provides no regression protection of its own. It is
// an end-state sanity check only; the wiring/source-pinning blocks above are
// what actually prove the fix.
describe("end-state sanity check (not a regression test): a map change + recycle shows the mapped account (#328)", () => {
  it("account 1 -> map now says 2 -> recycle: launchedAccount becomes 2, no claudeAccountNext", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    const recorded: StudioStatus[] = [];
    // What recycle()'s own top does before destroy — refuse or resolve today's launch.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", async (s) => { recorded.push(s); });
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    // What the FIXED awaitReady closure feeds onStart via this.envAccount.
    await recordLaunchedAccount(storage, "demosite-life--pilot", launch.name, async (s) => { recorded.push(s); });
    const row = (await storage.get(STATUS_KEY))!;
    const shown = await withAccountDisplay(env, row, NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(shown.claudeAccountNext).toBeUndefined();
  });
});

// Issue #134: a studio recycled (or otherwise relaunched through
// launchAccountOrRefuse) onto a DIFFERENT account than the one it was last
// launched on carries a `rateLimited` observation that necessarily describes
// the OLD account — nothing else clears it, so `fleet ls`/`fleet recycle`
// kept printing "rate-limited until <time>" for a studio actually healthy on
// the new account. The fix: launchAccountOrRefuse's own `launch.ok` branch
// clears `rateLimited` too, exactly when the resolved account differs from
// `existing.launchedAccount` and a `rateLimited` observation is present.
describe("launchAccountOrRefuse clears a stale rateLimited on an account change (#134)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const SEEN = new Date().toISOString();

  it("recorded limited on account 1, repo mapped to account 2, failover off: relaunches on 2 and drops rateLimited", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({
      launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN",
      rateLimited: { until: FUTURE, seenAt: SEEN },
    }));
    const recorded: StudioStatus[] = [];
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", async (s) => { recorded.push(s); });
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited ?? null).toBeNull();
  });

  it("no account change (already on the mapped account): rateLimited is left untouched", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({
      launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2",
      rateLimited: observation,
    }));
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", async () => {});
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation);
  });

  it("never launched before (no launchedAccount recorded): rateLimited is left untouched", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({ rateLimited: observation }));
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", async () => {});
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation);
  });
});

// Issue #134 review round 1: recycle() calls launchAccountOrRefuse TWICE —
// once at its own entry, before recycleWithSync has even probed the
// container (let alone destroyed it), and again fresh, immediately before
// the post-destroy container actually starts. recycleWithSync can still
// refuse outright between those two calls (a failed probe, or a confirmed
// rescue-push failure, without --discard-unsynced) — destroy() never runs
// and the studio never moves. A clear committed at the ENTRY call would
// then falsely claim a studio that stayed exactly where it was is no longer
// rate-limited / no longer on its old account. `commitOkClears=false` (the
// 5th, optional param) is how the entry call still does its existing job —
// refuse early on an unlaunchable account — without committing that clear;
// only the second, post-destroy call (which defaults to `commitOkClears:
// true`) may actually commit it.
describe("launchAccountOrRefuse(..., commitOkClears=false) — the entry-time recycle call never commits a clear (#134 review round 1)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const SEEN = new Date().toISOString();

  it("account change + a set rateLimited: still resolves the mapped account, but the row is untouched", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({
      launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN",
      rateLimited: { until: FUTURE, seenAt: SEEN },
    }));
    const recorded: StudioStatus[] = [];
    const launch = await launchAccountOrRefuse(
      env, storage, "demosite-life--pilot", async (s) => { recorded.push(s); }, false,
    );
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual({ until: FUTURE, seenAt: SEEN }); // NOT cleared
    expect(row.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // untouched too
    expect(recorded).toHaveLength(0); // no write at all on this call
  });

  it("same shape, but the auto-failover-off claudeAccount clear is also suppressed", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", async () => {}, false);
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3"); // NOT cleared
  });

  it("a refusal still writes the degraded row exactly as before — commitOkClears only gates the OK branch", async () => {
    const missing = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
    await expect(launchAccountOrRefuse(missing, storage, "demosite-life--pilot", async () => {}, false)).rejects.toThrow();
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.state).toBe("degraded");
  });

  // The actual recycle() sequence, composed at the primitive level with the
  // real functions (same convention as the "#328 fix round 2" primitive-level
  // describe block above): entry call (commitOkClears=false) resolves the
  // mapped account but writes nothing; recycleWithSync then refuses (probe
  // failed / rescue-push failed, no --discard-unsynced) — destroy() and the
  // second launchAccountOrRefuse call never run. The row must still show the
  // ORIGINAL rateLimited sighting afterward, not a false "healthy" clear.
  it("entry call + a subsequent recycle-path refusal (no destroy, no second call): rateLimited survives", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", rateLimited: observation }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    // recycle()'s own entry-time call.
    const entryLaunch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    expect(entryLaunch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");

    // recycleWithSync refuses here (simulated) — destroy() is never called,
    // so the awaitReady closure's own second launchAccountOrRefuse call never
    // runs either. Nothing further touches storage.

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation); // still set: the studio never moved
    expect(row.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // still the old account too
  });

  // Same sequence, but recycleWithSync does NOT refuse this time — destroy()
  // runs, and the second, post-destroy call resolves fresh and commits the
  // clear via decide/apply (issue #134 review round 4: the closure's own
  // launchAccountOrRefuse call also passes commitOkClears=false and commits
  // only through decideAccountClears -> sbAwaitReady -> applyAccountClears —
  // see the round 4 describe blocks further down for that mechanism's own
  // dedicated coverage, including the throw case this test does not exercise).
  it("entry call + a successful recycle (destroy ran, second call commits via decide/apply): rateLimited is dropped", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", rateLimited: observation }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false); // entry call

    // destroy() ran (simulated); the awaitReady closure's own fresh call.
    const freshLaunch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    expect(freshLaunch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");

    // decide (pre-touch) -> sbAwaitReady's own onStart write (simulated) ->
    // apply (post-success, no concurrent destroy).
    const clears = await decideAccountClears(env, storage, freshLaunch, REPO, RESERVED);
    const existingRow = (await storage.get(STATUS_KEY))!;
    await storage.put(STATUS_KEY, { ...existingRow, launchedAccount: freshLaunch.name });
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited ?? null).toBeNull();
  });
});

// Issue #134 review round 1: pins the wiring itself, the same source-pinning
// convention the "#328" blocks above use (the DO cannot be constructed under
// vitest-pool-workers) — the primitive-level tests above prove the MECHANISM
// works; this proves recycle() actually calls it that way.
describe("StudioDO.recycle wiring — the entry-time launchAccountOrRefuse call never commits a clear (#134 review round 1)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const recycleBody = body("async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {");

  it("the entry-time call (before recycleWithSync) passes commitOkClears=false", () => {
    // Pinned to the slice BEFORE `recycleWithSync(` specifically, not
    // `recycleBody` as a whole: the post-destroy closure's own call below
    // (`const launch = await launchAccountOrRefuse(...)`) also ends in the
    // exact same `, false);` text (it's a superstring of this literal, since
    // "const launch = " is just a prefix) — and, more importantly,
    // provisionUngated/restartUngated's own `false)` call sites live outside
    // `recycleBody` entirely but a plain `doSrc`-wide check would still have
    // caught them. Slicing to this call specifically (it's the only
    // `launchAccountOrRefuse` in recycle() before `recycleWithSync(` even
    // appears) is what actually proves THIS call site still passes `false`,
    // rather than "this text exists somewhere in recycle()'s body".
    const entrySlice = recycleBody.slice(0, recycleBody.indexOf("recycleWithSync("));
    expect(entrySlice).toContain(
      "await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn(), false);",
    );
  });

  // #134 review round 4: this test's own original claim — "keeps the
  // default, it DOES commit [inline]" — is no longer true: round 4 found
  // `sbAwaitReady` can itself throw after the closure's `launchAccountOrRefuse`
  // resolves, so this call now ALSO passes `false` and commits via the
  // decide/apply split instead (see the round 4 describe blocks further
  // down for that mechanism and its own wiring proof). What is still true,
  // and still worth pinning here: this closure remains the only place a
  // clear can ever actually land for a recycle, now via `applyAccountClears`
  // rather than an inline commit.
  it("the post-destroy call (inside the awaitReady closure) also resolves with commitOkClears=false — it commits via decide/apply, not inline", () => {
    const closureStart = recycleBody.indexOf("async () => {");
    const closureEnd = recycleBody.indexOf("await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);", closureStart)
      + "await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);".length;
    const closureBody = recycleBody.slice(closureStart, closureEnd);
    expect(closureBody).toContain(
      "const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn(), false);",
    );
    expect(closureBody).toContain("await decideAccountClears(this.env, this.ctx.storage, launch, repo, reserved);");
    expect(closureBody).toContain("await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);");
  });
});

// Issue #134 review round 2: `provisionUngated`/`restartUngated` are BOTH
// idempotent (studio.routes.test.ts's "provision idempotent" coverage;
// restartStudio is likewise callable on a live container) and, on an
// already-`running` container, skip the actual container start entirely
// (`if (!this.ctx.container?.running) await sbAwaitReady(this)`) — the live
// tmux session keeps running on whatever token it booted with. Committing
// launchAccountOrRefuse's ok-branch clear unconditionally on these two paths
// (round 1's fix, before this round) reopened exactly #134's own bug through
// provision/restart instead of recycle: a rate-limited, still-running studio
// whose repo gets remapped would have its row falsely cleared the moment
// `fleet provision`/`fleet restart` resolved the new account, even though
// the container never moved.
//
// Review round 3 found that a single "read fresh, decide, write" step,
// placed BEFORE `sbAwaitReady` to dodge onStart's own launchedAccount write
// (`sbAwaitReady` wraps `startAndWaitForPorts`, which — per
// @cloudflare/containers' pinned compiled source — runs `await
// this.state.setHealthy(); await this.onStart();` itself, before resolving,
// and this file's own `onStart` unconditionally calls
// `recordLaunchedAccount`, writing `launchedAccount: this.envAccount` into
// the SAME row), committed the clear too EARLY: `sbAwaitReady` is
// documented to throw on a genuine cold-start failure (timeout, bad image,
// a rollout killing the container mid-boot — see `healDiedInRollout`/
// `ROLLOUT_EXIT_MARKER` for a measured instance), and nothing undid an
// already-persisted clear if it did.
//
// Round 4's fix splits DECIDE (reads the pre-touch snapshot, computes the
// patch — must run before `sbAwaitReady`, for round 3's reason) from APPLY
// (writes the patch — must run only in `sbAwaitReady`'s own SUCCESS
// continuation, never from a catch, never unconditionally). `decide` can
// safely run early because it's pure computation carried in a local
// variable, not a write; the throw-safety comes entirely from `apply` never
// running unless `sbAwaitReady` actually returned.
//
// Three scenarios below, composed at the primitive level (same convention
// as the #328 "race the fix closes" block): the guard skips the start
// entirely (decide/apply never run at all); the cold start succeeds
// (decide, then the onStart-equivalent write, then apply — clears
// correctly); and the cold start THROWS (decide ran, but apply never does —
// nothing persists). `mutateToLaunchedAccount` stands in for exactly what
// onStart's `recordLaunchedAccount` does to the row.
describe("decideAccountClears/applyAccountClears — decided before the container touch, applied only once it succeeds (#134 review round 4)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const SEEN = new Date().toISOString();

  // Stands in for onStart's recordLaunchedAccount, which runs INSIDE
  // sbAwaitReady itself, before it resolves.
  async function mutateToLaunchedAccount(storage: StudioStorage, name: string): Promise<void> {
    const existing = (await storage.get(STATUS_KEY))!;
    await storage.put(STATUS_KEY, { ...existing, launchedAccount: name });
  }

  function seeded(): { env: Env; storage: StudioStorage; recordFn: (s: StudioStatus) => Promise<void>; observation: { until: string; seenAt: string } } {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", rateLimited: observation }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    return { env, storage, recordFn, observation };
  }

  it("outcome 1 — container already running (guard skips the start entirely): rateLimited survives untouched", async () => {
    const { env, storage, recordFn, observation } = seeded();

    // provisionUngated's/restartUngated's own entry call.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");

    // The container-running guard is true: the whole `!running` branch —
    // decideAccountClears, sbAwaitReady, AND applyAccountClears — is
    // SKIPPED, exactly as production does. Nothing further touches storage.

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation); // still set: the container never moved
    expect(row.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // still the old account too
  });

  it("outcome 2 — cold start SUCCEEDS: decide, then onStart's write, then apply — rateLimited clears correctly", async () => {
    const { env, storage, recordFn, observation: _observation } = seeded();
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);

    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED); // pre-touch snapshot
    await mutateToLaunchedAccount(storage, launch.name); // sbAwaitReady -> onStart, simulated
    // sbAwaitReady resolved successfully: its success continuation runs.
    // No concurrent destroy landed either (NEVER_MOVED_CTX).
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited ?? null).toBeNull(); // cleared, as #134 requires
    expect(row.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2"); // onStart's own write still lands
  });

  it("outcome 3 — cold start THROWS: decide ran, apply never does — rateLimited is NOT cleared (#134 review round 4)", async () => {
    const { env, storage, recordFn, observation } = seeded();
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);

    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED); // pre-touch snapshot, decided
    expect(clears).not.toBeNull(); // there WAS something to clear
    // sbAwaitReady throws here (a genuine cold-start failure) — production
    // code never reaches the `applyAccountClears` line below it; this test
    // proves that by simply never calling it.

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation); // never persisted: the row is untouched
    expect(row.launchedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN"); // onStart never got to run either
  });

  // Issue #134 review round 5: sbAwaitReady resolving SUCCESSFULLY is not,
  // by itself, proof no concurrent destroy landed while it was running — a
  // `fleet destroy` racing this exact window can finish after this studio's
  // own operation started, and applyAccountClears's fresh read could
  // otherwise land AFTER destroy's own final write and clobber it. Same
  // `ctx.moved()` guard every other post-container-touch write in this file
  // already uses (do.ts:1505/5963/6195's own `if (await ctx.moved())`
  // checks) — applied here too.
  it("outcome 4 — sbAwaitReady succeeds, but a concurrent destroy landed first: apply skips the write entirely (#134 review round 5)", async () => {
    const { env, storage, recordFn, observation } = seeded();
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);

    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED); // pre-touch snapshot, decided
    expect(clears).not.toBeNull();
    await mutateToLaunchedAccount(storage, launch.name); // sbAwaitReady -> onStart, simulated
    // A concurrent destroy landed (its own epoch bump) sometime during
    // sbAwaitReady — same shape test/studio.replacement.test.ts's own
    // `ctx: OpCtx = { epoch: 0, moved: async () => moved }` fixture uses.
    const movedCtx: OpCtx = { epoch: 0, moved: async () => true };
    await applyAccountClears(storage, recordFn, clears, movedCtx);

    const row = (await storage.get(STATUS_KEY))!;
    // The write never happened at all: rateLimited is exactly whatever it
    // was the instant before this function ran (here: still the stale
    // observation) — NOT "correctly cleared" and NOT the pre-touch value
    // either, simply untouched, so a real destroy's own later write (which
    // this test does not simulate, since applyAccountClears returning
    // early is the whole point) is never at risk of being clobbered.
    expect(row.rateLimited).toEqual(observation);
  });

  it("no stale fields on the row at all: decide returns null, apply is a no-op", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
    const recorded: StudioStatus[] = [];
    const recordFn = async (s: StudioStatus) => { recorded.push(s); await storage.put(STATUS_KEY, s); };
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED);
    expect(clears).toBeNull();
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);
    expect(recorded).toHaveLength(0);
  });

  // PR #147 merge fix (maestro review, 2026-09-30): merging #131/#135's
  // "borrowedAccount/borrowedFromRepo clear alongside the #273 r2 flag-off
  // stale-clear" fix (review round 2 finding 2, originally landed ONLY in
  // launchAccountOrRefuse's own inline commitOkClears=true branch — see the
  // "clearForceMappedAccount / launchAccountOrRefuse — the borrow flags
  // clear too" describe block far below) widened `accountClears` itself so
  // EVERY caller shares it, including this decide/apply path —
  // provisionUngated/restartUngated/recycle's post-destroy closure. Until
  // this test, nothing drove decideAccountClears/applyAccountClears with
  // claudeAccount/borrowedAccount/borrowedFromRepo all seeded, so the
  // widened branch was never exercised through this path at all.
  it("decide/apply also clears borrowedAccount/borrowedFromRepo (not just claudeAccount/rateLimited) when the #273 r2 flag-off clear fires", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }); // FLEET_AUTO_FAILOVER unset -> off
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      rateLimited: observation,
      borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      borrowedFromRepo: "repo-b",
    }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    // provisionUngated's/restartUngated's/recycle's post-destroy closure's
    // own entry call — flag off, so this resolves the mapped slot, not the
    // recorded (stale) account.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");

    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED); // pre-touch snapshot
    await mutateToLaunchedAccount(storage, launch.name); // sbAwaitReady -> onStart, simulated
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.claudeAccount ?? null).toBeNull();
    expect(row.rateLimited ?? null).toBeNull();
    expect(row.borrowedAccount ?? null).toBeNull();
    expect(row.borrowedFromRepo ?? null).toBeNull();
  });
});

// Issue #134 review round 4: the identical decide-before/apply-after-success
// split, applied to recycle()'s post-destroy closure too — its own
// `launchAccountOrRefuse` + `sbAwaitReady` pair had the textually-identical
// exposure (commit immediately on resolve, before `sbAwaitReady`, which can
// itself throw) even though destroy() had already unconditionally run.
// Pre-existing across rounds 1-3 (not a round-4 regression), fixed in the
// same pass since the restructuring was already in flight.
describe("recycle's post-destroy closure — decide/apply around a throwing start (#134 review round 4)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const SEEN = new Date().toISOString();

  it("sbAwaitReady throws: decide ran, apply never does — rateLimited is NOT cleared, even though destroy() already happened", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const observation = { until: FUTURE, seenAt: SEEN };
    const storage = fakeStorage(status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN", rateLimited: observation }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    // recycle()'s own entry call (decides nothing, per round 1).
    await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    // destroy() ran (simulated) — the closure's own fresh call.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn, false);
    const clears = await decideAccountClears(env, storage, launch, REPO, RESERVED);
    expect(clears).not.toBeNull();
    // sbAwaitReady throws here — recycleWithSync's own catch reads the row
    // next; applyAccountClears is never reached.

    const row = (await storage.get(STATUS_KEY))!;
    expect(row.rateLimited).toEqual(observation); // still set: the row is exactly as it was before this closure ran
  });
});

// Issue #134 review round 4: pins the wiring itself (the DO cannot be
// constructed under vitest-pool-workers, same convention as every other
// source-pinning block in this file) — the primitive-level tests above
// prove the MECHANISM (decide/apply, split around a possibly-throwing
// call); this proves provisionUngated/restartUngated actually call it that
// way, in that order.
describe("StudioDO.provisionUngated/restartUngated wiring — decide before sbAwaitReady, apply only after it succeeds (#134 review round 4)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const coldStartBlock = (fnBody: string): string => {
    const guardStart = fnBody.indexOf("if (!this.ctx.container?.running) {");
    if (guardStart === -1) throw new Error("cold-start guard not found");
    const guardEnd = fnBody.indexOf("\n    }\n", guardStart);
    return fnBody.slice(guardStart, guardEnd);
  };

  for (const [name, sig] of [
    ["provisionUngated", "private async provisionUngated(cfg: ProvisionConfig, via: BringupVia, ctx: OpCtx): Promise<StudioStatus> {"],
    ["restartUngated", "private async restartUngated(via: BringupVia, ctx: OpCtx): Promise<StudioStatus> {"],
  ] as const) {
    describe(name, () => {
      const fnBody = body(sig);

      it("the launchAccountOrRefuse call passes commitOkClears=false", () => {
        expect(fnBody).toContain("this.recordFn(), false);");
      });

      it("decideAccountClears, sbAwaitReady, applyAccountClears run in that exact order, inside the cold-start guard", () => {
        const block = coldStartBlock(fnBody);
        const decideIdx = block.indexOf("const clears = await decideAccountClears(this.env, this.ctx.storage, launch, repo, reserved);");
        const awaitReadyIdx = block.indexOf("await sbAwaitReady(this);");
        const applyIdx = block.indexOf("await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);");
        expect(decideIdx).toBeGreaterThan(-1);
        expect(awaitReadyIdx).toBeGreaterThan(-1);
        expect(applyIdx).toBeGreaterThan(-1);
        expect(decideIdx).toBeLessThan(awaitReadyIdx);
        expect(awaitReadyIdx).toBeLessThan(applyIdx);
      });

      it("applyAccountClears does NOT run outside the cold-start guard (unconditionally)", () => {
        const outside = fnBody.slice(0, fnBody.indexOf("if (!this.ctx.container?.running) {"))
          + fnBody.slice(fnBody.indexOf("\n    }\n", fnBody.indexOf("if (!this.ctx.container?.running) {")));
        expect(outside).not.toContain("applyAccountClears(");
      });
    });
  }
});

// Issue #134 review round 4: the same wiring proof for recycle()'s
// post-destroy closure — its `launchAccountOrRefuse` call now also passes
// `false`, and `decideAccountClears`/`sbAwaitReady`/`applyAccountClears` run
// in the same strict order, with no `!running` guard needed (destroy() has
// already unconditionally run by the time this closure executes).
describe("StudioDO.recycle wiring — decide before sbAwaitReady, apply only after it succeeds (#134 review round 4)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const recycleBody = body("async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {");
  const closureStart = recycleBody.indexOf("async () => {");
  const closureEnd = recycleBody.indexOf("await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);", closureStart)
    + "await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);".length;
  const closureBody = recycleBody.slice(closureStart, closureEnd);

  it("the closure's own launchAccountOrRefuse call passes commitOkClears=false", () => {
    expect(closureBody).toContain(
      "const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn(), false);",
    );
  });

  it("decideAccountClears, sbAwaitReady, applyAccountClears run in that exact order", () => {
    const decideIdx = closureBody.indexOf("const clears = await decideAccountClears(this.env, this.ctx.storage, launch, repo, reserved);");
    const awaitReadyIdx = closureBody.indexOf("await sbAwaitReady(this);");
    const applyIdx = closureBody.indexOf("await applyAccountClears(this.ctx.storage, this.recordFn(), clears, ctx);");
    expect(decideIdx).toBeGreaterThan(-1);
    expect(awaitReadyIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(decideIdx).toBeLessThan(awaitReadyIdx);
    expect(awaitReadyIdx).toBeLessThan(applyIdx);
  });
});

// Board task #131 ask 2: `fleet recycle <id> --account mapped`. See the
// header on the #328 wiring block above for why a source pin is the only way
// to regression-cover recycle()'s actual statement ordering — the DO cannot
// be constructed under vitest-pool-workers.
describe("StudioDO.recycle wiring — forced-mapped clear runs BEFORE either launchAccountOrRefuse call (#131 ask 2)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const body = (sig: string): string => {
    const start = doSrc.indexOf(sig);
    if (start === -1) throw new Error(`not found: ${sig}`);
    return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
  };
  const recycleBody = body("async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {");

  it("cfg.forceMappedAccount is checked before recycle's first launchAccountOrRefuse call", () => {
    const clearIdx = recycleBody.indexOf("cfg.forceMappedAccount");
    const firstLaunchIdx = recycleBody.indexOf("launchAccountOrRefuse(");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(firstLaunchIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(firstLaunchIdx);
  });

  it("the clear calls clearForceMappedAccount, not a hand-rolled inline write", () => {
    const clearIdx = recycleBody.indexOf("cfg.forceMappedAccount");
    // Review round 2 (maestro review of PR #135), Minor finding: widened
    // from 200 — refuseUnlessMappedAccountLaunchable's own call (and its
    // one-line comment) now sits between the `if` and this clear.
    const nextLines = recycleBody.slice(clearIdx, clearIdx + 500);
    expect(nextLines).toContain("clearForceMappedAccount(this.ctx.storage, this.recordFn())");
  });

  it("refuseUnlessMappedAccountLaunchable is checked before the clear (Minor finding, review round 2)", () => {
    const clearIdx = recycleBody.indexOf("cfg.forceMappedAccount");
    const refuseIdx = recycleBody.indexOf("refuseUnlessMappedAccountLaunchable(");
    const clearCallIdx = recycleBody.indexOf("clearForceMappedAccount(this.ctx.storage, this.recordFn())");
    expect(refuseIdx).toBeGreaterThan(clearIdx);
    expect(refuseIdx).toBeLessThan(clearCallIdx);
  });
});

// Same race, at the primitive level — composing the real
// clearForceMappedAccount + launchAccountOrRefuse the way recycle() itself
// does, rather than executing do.ts's actual closure (the DO cannot be
// constructed here — see the #328 block above for the same caveat). Proves
// the MECHANISM: a studio recorded on a failed-over account, with
// FLEET_AUTO_FAILOVER=on (the exact case launchAccount's own doc comment
// says never consults the map), still resolves the mapped slot once
// clearForceMappedAccount has run — and is completely unaffected when it has
// not (a plain recycle).
describe("clearForceMappedAccount — the primitive recycle()'s forced-mapped clear composes (#131 ask 2)", () => {
  const env = envWith({ ...ALL, FLEET_AUTO_FAILOVER: "on" });

  it("clears claudeAccount and the moved-audit trail, so the VERY NEXT launchAccountOrRefuse call already sees the cleared state and falls through to the mapped slot", async () => {
    const storage = fakeStorage(status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      claudeAccountMovedAt: "2026-09-29T00:00:00Z", claudeAccountMovedVia: "inline", claudeAccountMovedBlock: "rate-limit",
    }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    // recycle()'s own entry-time act, before its first launchAccountOrRefuse.
    await clearForceMappedAccount(storage, recordFn);
    const cleared = (await storage.get(STATUS_KEY))!;
    expect(cleared.claudeAccount).toBeNull();
    expect(cleared.claudeAccountMovedAt).toBeNull();
    expect(cleared.claudeAccountMovedVia).toBeNull();
    expect(cleared.claudeAccountMovedBlock).toBeNull();

    // recycle()'s own entry-time launchAccountOrRefuse (issue #271's early
    // refuse) — without the clear above this would resolve
    // CLAUDE_CODE_OAUTH_TOKEN_3 again, unconditionally (launchAccount's own
    // doc comment: auto-failover on + a recorded account never consults the
    // map at all). No repo mapping is set, so the mapped slot is the first
    // configured account.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn);
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("a plain recycle never calls this — claudeAccount (and the moved-audit trail) is preserved exactly as before", async () => {
    const storage = fakeStorage(status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      claudeAccountMovedVia: "inline",
    }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    // forceMappedAccount not set: recycle()'s own `if (cfg.forceMappedAccount)`
    // gate (do.ts) means clearForceMappedAccount is never called at all.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--pilot", recordFn);
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_3"); // unaffected: still the recorded (failed-over) account
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(row.claudeAccountMovedVia).toBe("inline");
  });

  it("no-op on a row already clear (nothing to write, nothing recorded)", async () => {
    const storage = fakeStorage(status());
    const recorded: StudioStatus[] = [];
    await clearForceMappedAccount(storage, async (s) => { recorded.push(s); });
    expect(recorded).toHaveLength(0);
  });
});

// Review round 2 (maestro review of PR #135), finding 2 — clearForceMappedAccount
// left borrowedAccount/borrowedFromRepo set, and so did the sibling #273 r2
// stale-clear in launchAccountOrRefuse. A stale borrow flag surviving either
// one makes the NEXT hand-back check (failover.ts, gated on exactly that
// field) fire against a studio that is not actually borrowing anything any
// more, killing the fresh lead the clear just launched out from under it.
describe("clearForceMappedAccount / launchAccountOrRefuse — the borrow flags clear too (review round 2 finding 2)", () => {
  it("clearForceMappedAccount clears borrowedAccount/borrowedFromRepo alongside the moved-audit trail", async () => {
    const storage = fakeStorage(status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4",
      borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_4", borrowedFromRepo: "repo-b",
    }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    await clearForceMappedAccount(storage, recordFn);
    const cleared = (await storage.get(STATUS_KEY))!;
    expect(cleared.borrowedAccount).toBeNull();
    expect(cleared.borrowedFromRepo).toBeNull();
  });

  it("the #273 r2 flag-off stale-clear in launchAccountOrRefuse also clears borrowedAccount/borrowedFromRepo", async () => {
    const off = envWith(ALL); // FLEET_AUTO_FAILOVER unset -> off
    const storage = fakeStorage(status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", borrowedFromRepo: "repo-b",
    }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    await launchAccountOrRefuse(off, storage, "demosite-life--pilot", recordFn);
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.claudeAccount).toBeNull();
    expect(row.borrowedAccount).toBeNull();
    expect(row.borrowedFromRepo).toBeNull();
  });
});

// Review round 2 (maestro review of PR #135), Minor finding — a missing
// mapped secret used to refuse AFTER clearForceMappedAccount already wiped
// the record: no container was ever touched (correct), but the row lost
// claudeAccount/the moved-audit trail/the borrow flags on what was,
// underneath, still a no-op refusal.
describe("refuseUnlessMappedAccountLaunchable — refuses BEFORE the clear when the mapped slot's secret is missing (Minor finding, review round 2)", () => {
  it("throws, and leaves claudeAccount/the moved-audit trail/the borrow flags completely untouched", async () => {
    // MAP_2 maps demosite-life -> slot 2, and CLAUDE_CODE_OAUTH_TOKEN_2 is
    // deliberately NOT set here — the mapped slot's own secret is missing.
    const missingMapped = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: MAP_2, FLEET_AUTO_FAILOVER: "on" });
    const before = status({
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3",
      claudeAccountMovedAt: "2026-09-29T00:00:00Z", claudeAccountMovedVia: "inline", claudeAccountMovedBlock: "rate-limit",
      borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", borrowedFromRepo: "repo-b",
    });
    const storage = fakeStorage(before);
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };

    // recycle()'s own new pre-clear check, called BEFORE clearForceMappedAccount.
    await expect(
      refuseUnlessMappedAccountLaunchable(missingMapped, "demosite-life--pilot", storage, recordFn),
    ).rejects.toThrow(/refusing to launch/);

    const row = (await storage.get(STATUS_KEY))!;
    // Everything clearForceMappedAccount would have cleared stays exactly as
    // it was before this call — the whole point of checking first.
    expect(row.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(row.claudeAccountMovedAt).toBe("2026-09-29T00:00:00Z");
    expect(row.claudeAccountMovedVia).toBe("inline");
    expect(row.claudeAccountMovedBlock).toBe("rate-limit");
    expect(row.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(row.borrowedFromRepo).toBe("repo-b");
    // Same refusal shape an ordinary launchAccountOrRefuse refusal writes,
    // so `fleet ls` shows why — a refusal nobody can see is a refusal
    // nobody can audit.
    expect(row.state).toBe("degraded");
    expect(row.error).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("a launchable mapped slot: a no-op, nothing written, nothing thrown", async () => {
    const mapped = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2, FLEET_AUTO_FAILOVER: "on" });
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    const recorded: StudioStatus[] = [];
    await refuseUnlessMappedAccountLaunchable(mapped, "demosite-life--pilot", storage, async (s) => { recorded.push(s); });
    expect(recorded).toHaveLength(0);
    expect((await storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
  });
});

describe("withAccountDisplay — the column shows the LAUNCHED account (#289)", () => {
  const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });

  it("launched on account 1 before the map: shows account 1, with the next launch's account as a note", async () => {
    const shown = await withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("launched on the mapped account: no note", async () => {
    const shown = await withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }), NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(shown.claudeAccountNext).toBeUndefined();
  });

  it("the label follows the launched account, not the mapped one", async () => {
    const labelled = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2, CLAUDE_ACCOUNT_1_LABEL: "first@example.com" });
    const shown = await withAccountDisplay(labelled, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccountLabel).toBe("first@example.com");
  });

  it("never carries a token", async () => {
    const shown = await withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }), NO_LIMITS, RESERVED, new Date());
    expect(JSON.stringify(shown)).not.toContain("sk-ant-");
  });
});

describe("a refused launch leaves no stale account name (#285)", () => {
  const missing = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });

  it("failover off: the refused row drops the old failover record and the launched account", async () => {
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    await expect(launchAccountOrRefuse(missing, storage, "demosite-life--pilot", async () => {})).rejects.toThrow("refusing to launch");
    const row = (await storage.get(STATUS_KEY))!;
    expect(row.state).toBe("degraded");
    expect(row.claudeAccount ?? null).toBeNull();
    expect(row.launchedAccount).toBeNull();
    const shown = await withAccountDisplay(missing, row, NO_LIMITS, RESERVED, new Date());
    expect(JSON.stringify(shown)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(shown.launchedAccount).toBeNull(); // fleet ls prints "-"; the ERROR column names slot 2
  });

  it("failover on: the recorded account is what launches next, so it is kept", async () => {
    const on = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: MAP_2, FLEET_AUTO_FAILOVER: "on" });
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
    await expect(launchAccountOrRefuse(on, storage, "demosite-life--pilot", async () => {})).rejects.toThrow();
    expect((await storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });
});

describe("rows stored by origin/main (no launchedAccount) still load and render", () => {
  const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });

  // #292 r2: main rendered these as CLAUDE_CODE_OAUTH_TOKEN_2 -- the #289 lie
  // itself, for every studio still running after a Worker-only deploy. With no
  // launch record the account is unknown, and the column says so.
  it("a row main stored (no launch record) renders `?`, the mapped account as the NEXT launch", async () => {
    const shown = await withAccountDisplay(env, MAIN_ROWS.launched, NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(shown.claudeAccountLabel).toBeUndefined();
  });

  it("a stale failover record with the flag off: `?` too, never TOKEN_3 and never a claimed TOKEN_2", async () => {
    const shown = await withAccountDisplay(env, MAIN_ROWS.staleFailoverRecord, NO_LIMITS, RESERVED, new Date());
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("unmapped, no launch record: `?` with the first account next", async () => {
    const shown = await withAccountDisplay(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 }), { ...MAIN_ROWS.launched, id: "fleetflare--pilot" }, NO_LIMITS, new Set<string>(), new Date());
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("a refused row main stored with a stale name no longer shows that name (#285)", async () => {
    const missing = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const shown = await withAccountDisplay(missing, MAIN_ROWS.refused, NO_LIMITS, RESERVED, new Date());
    expect(JSON.stringify({ ...shown, error: null })).not.toContain("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(shown.launchedAccount).toBeNull();
  });

  it("a main row survives a JSON round trip and a new launch record on top of it", async () => {
    const storage = fakeStorage(JSON.parse(JSON.stringify(MAIN_ROWS.launched)) as StudioStatus);
    await recordLaunchedAccount(storage, MAIN_ROWS.launched.id, "CLAUDE_CODE_OAUTH_TOKEN_2", async () => {});
    const row = (await storage.get(STATUS_KEY))!;
    expect(row).toEqual({ ...MAIN_ROWS.launched, launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });
});

// Issue #354: every place that sets the DO's in-memory start config sets
// BOTH fields from ONE account name, in ONE assignment (launchFields) — and a
// completed failover is one of those places.
describe("StudioDO start config — one derivation everywhere, failover included (#354)", () => {
  const doSrc: string = (testEnv as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
  const ASSIGN = "({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(";

  it("failoverDeps hands the new account to the DO, which re-derives both fields from it", () => {
    const start = doSrc.indexOf("private failoverDeps(): FailoverDeps {");
    const end = doSrc.indexOf("\n  }\n", start);
    const block = doSrc.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("onSwitched: async (name: string) =>");
    expect(block).toContain(ASSIGN);
  });

  it("provision, restart and recycle set the start config through the same one assignment, from launch.name", () => {
    const uses = doSrc.split(ASSIGN).length - 1;
    // failover + provisionUngated + restartUngated + recycle's awaitReady closure
    expect(uses).toBe(4);
    expect(doSrc.split(`${ASSIGN}this.env, id, spawnToken, launch.name))`).length - 1).toBe(2);
    expect(doSrc).toContain(`${ASSIGN}this.env, this.selfId(), spawnToken, launch.name))`);
  });

  it("no site sets envVars from a second, separate account read any more", () => {
    expect(doSrc).not.toContain("studioEnvVars(this.env, id, spawnToken, await this.claudeAccountName())");
    expect(doSrc).not.toMatch(/this\.envAccount = launch\.name;/);
  });
});
