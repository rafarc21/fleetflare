import { describe, it, expect } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { launchAccountOrRefuse, launchAccountName, recordLaunchedAccount, constructorLaunch } from "../src/studio/do";
import { withAccountDisplay } from "../src/studio/registry";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
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

function envWith(vars: Record<string, string>): Env {
  return vars as unknown as Env;
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
    expect(withAccountDisplay(envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 }), row).claudeAccount).toBe("?");
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
    const paired = doSrc.match(/const launch = await launchAccountOrRefuse\(this\.env, this\.ctx\.storage, id, this\.recordFn\(\)\);\n(    \/\/[^\n]*\n)?    \(\{ envVars: this\.envVars, envAccount: this\.envAccount \} = launchFields\(this\.env, id, spawnToken, launch\.name\)\);/g);
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
    const launchStmt = "const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn());";
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
    const shown = withAccountDisplay(env, row);
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

describe("withAccountDisplay — the column shows the LAUNCHED account (#289)", () => {
  const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });

  it("launched on account 1 before the map: shows account 1, with the next launch's account as a note", () => {
    const shown = withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" }));
    expect(shown.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("launched on the mapped account: no note", () => {
    const shown = withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
    expect(shown.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(shown.claudeAccountNext).toBeUndefined();
  });

  it("the label follows the launched account, not the mapped one", () => {
    const labelled = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: MAP_2, CLAUDE_ACCOUNT_1_LABEL: "first@example.com" });
    expect(withAccountDisplay(labelled, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" })).claudeAccountLabel)
      .toBe("first@example.com");
  });

  it("never carries a token", () => {
    expect(JSON.stringify(withAccountDisplay(env, status({ launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" })))).not.toContain("sk-ant-");
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
    const shown = withAccountDisplay(missing, row);
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
  it("a row main stored (no launch record) renders `?`, the mapped account as the NEXT launch", () => {
    const shown = withAccountDisplay(env, MAIN_ROWS.launched);
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(shown.claudeAccountLabel).toBeUndefined();
  });

  it("a stale failover record with the flag off: `?` too, never TOKEN_3 and never a claimed TOKEN_2", () => {
    const shown = withAccountDisplay(env, MAIN_ROWS.staleFailoverRecord);
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("unmapped, no launch record: `?` with the first account next", () => {
    const shown = withAccountDisplay(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 }), { ...MAIN_ROWS.launched, id: "fleetflare--pilot" });
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("a refused row main stored with a stale name no longer shows that name (#285)", () => {
    const missing = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3, CLAUDE_ACCOUNT_BY_REPO: MAP_2 });
    const shown = withAccountDisplay(missing, MAIN_ROWS.refused);
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
