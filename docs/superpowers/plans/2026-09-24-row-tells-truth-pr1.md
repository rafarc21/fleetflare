# Row Tells the Truth — PR1 (heartbeat v1, READY tells the truth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `Observed` DO-storage record (container-replacement detection via an incarnation token, exec-reachability tracking, and a session-restore verdict) and render it on `fleet ls` (READY overrides + new SESSION column) and `fleet inspect`, so no row ever says `provisioned` or implies a live lead with its memory when the fleet has evidence otherwise.

**Architecture:** One new DO-storage key (`observed`), owned by its own narrow storage port (`src/studio/observed.ts`) — same "own file, own key, no widening of `StudioStorage`" discipline `transcript.ts`/`session-sync.ts`/`sweep.ts` already established. Written at exactly two places: every bring-up's post-success block (provision/restart/heal/recycle/failover — incarnation token + session verdict) and the existing 30s ship tick (incarnation comparison + exec-reachability). Read only by the CLI's pure formatting layer and `fleet inspect`. Observation-only — nothing here heals, restarts, wakes or recycles.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, `@cloudflare/sandbox` (container exec), Bun test runner (`bun-test`) + Vitest (`vitest-pool-workers`), `fleet` CLI (Bun script).

**Spec:** `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md`

## Global Constraints

- Zero changes under `apps/fleet/container/` — `git diff --stat origin/main...` must list none. `studio-bringup.sh` is untouched; PR1 reads outcomes via `/proc/<pid>/cmdline` and `/proc/<pid>/cwd` of the live lead process, never by parsing bring-up's own stdout/stderr.
- Observation-only (spec Principle 2): no new actor. Nothing here heals, restarts, wakes or recycles. `#71`'s heal unchanged. Guidance text for humans is fine (`→ recycle`).
- New facts live in their OWN DO storage key (`observed`), never folded into `status`, never inside the `status` read-exec-write cycle (`do.ts`'s `checkAndRecordReadiness`, ~1415-1435, has a documented stale-overwrite race on `STATUS_KEY` — `observed` must never ride through it).
- Keep `#92`'s inspect refusal strings verbatim (`inspect.ts`'s `runInspect` error text) — only ADD the two new fields to `InspectSnapshot`/the route/CLI body.
- Keep the `LAST ACTIVITY` column label verbatim (`cli/fleet.ts:196`'s doc comment explains why — deliberate, revisited in PR3).
- The 660s staleness threshold is `2 * SYNC_SESSION_SECONDS + 60`, always derived from the `SYNC_SESSION_SECONDS` constant, never hardcoded as a bare `660`.
- No D1 migration — `observed` rides the existing JSON-blob row via the same `setFlag`/registry write `readiness`/`burn` already use.
- Every new read tolerates exec failure — yields `unknown`/`?` plus a reason, never throws into the alarm.
- The token write failing does not fail bring-up. Log and continue; the verdict reads `?`/`unknown`, and the ship tick then reports `replaced`. Loud, never silent.
- Both lanes must pass at the end, run from `apps/fleet/`: `bun run check`, `bun run test` (vitest-pool-workers), `bun run bun-test` (Bun).

## Corrections to the task brief, found during file verification (read this before Task 3)

The task brief that produced this plan assumed `runProvision`/`runRestart` (`provision.ts`) receive DO storage directly and could call `mergeObserved` inline. They do not — both are **deliberately storage-free** (their own doc comments: "this function is deliberately storage-free; the wrapper owns every write"); only `provisionWithStorage`/`restartWithStorage` hold a `storage: StudioStorage` parameter. `runAccountFailover` (`failover.ts`) is the one exception — it already takes `storage: StudioStorage` directly.

Two more corrections, both driven by minimizing test-fixture ripple across 7+ existing test files that build their own `StudioStorage`-typed fakes:

- Rather than widening `provisionWithStorage`/`restartWithStorage`/`runAccountFailover`/`syncSessionCycle`'s existing storage parameter types to `& ObservedStorage` (which would force every existing test file's local `fakeStorage()` cast to also satisfy `ObservedStorage`'s overloads), this plan adds Observed access as a **new, trailing, OPTIONAL parameter** (`observedStorage?: ObservedStorage`) to each. This is the exact "every ProvisionDeps field optional, absence = no-op, do.ts's real wiring always supplies it" idiom `ProvisionDeps.r2Get`/`.writeFile`/`.setKeepAlive`/`.resolveAssignedBrief`/`.writeBlueprintCredential` already establish, and the exact shape `syncSessionCycle`'s own existing `failoverDeps?`/`heal?` parameters already use. Every EXISTING test that does not pass this new argument is unaffected; do.ts's real call sites always pass `this.ctx.storage` (real DO storage structurally satisfies any narrow port with no cast — the same reasoning every narrow port's own doc comment in this codebase gives).
- `SYNC_SESSION_SECONDS` is currently defined in `do.ts` (which imports `"@cloudflare/sandbox"` and is therefore unimportable from `cli/readiness-format.ts` or its test file — see that file's own header). It moves to `session-sync.ts` (already import-safe under vitest-pool-workers, already the semantic home of the sync cadence) so both `do.ts` and the CLI's pure formatting layer can import the same constant.

---

## Maestro's board review corrections (2026-09-24, comment id 5814498930) — applied throughout, this is the index

Task 1 (`aa983bd`) already landed and stands unchanged — correction 15 below confirms why. Everything from Task 2 on is corrected in place; every task section below that changed is marked **REVISED** with a one-line pointer back to the correction number(s) that drove it. This index exists so a reviewer can find where each of the 15 corrections landed without diffing the whole document — it is not a substitute for reading the corrected task text, which is the actual spec.

| # | Finding | Lands in |
|---|---|---|
| 1 | D1 never gets `observed` — `fleet ls` reads D1 only, every write races it | Task 2 (new `withObserved` D1-wiring steps) |
| 2 | Incarnation file has no trailing newline — breaks ship-tick parsing fleet-wide | Task 3 (`writeIncarnationCmd`), Task 4 (`shipTickCmd` read), Task 9 (`inspectCmd` read) |
| 3 | `replaced` self-clears in one tick (missing branch nulls `incarnation`) | Task 4 (`incarnationPatch` full rewrite) |
| 4 | Op lock: D1 reads `running` mid-op, so state-based CLI guards guard nothing | Task 4 (op-lock re-read after exec), Task 8 (T10 relabeled as a DO-level test, moved out of `cli.fleet.test.ts`) |
| 5 | Deadline the exec, not the tick — only timeout/transport counts as unreachable | Task 4 (`withExecDeadline` wraps `ShipDeps.exec`, not the whole tick) |
| 6 | Every new exec deadlined; fold adoption write + probe into the ship-tick exec, fold bring-up token write + probe into one exec | Task 4 (adoption folded into the ship-tick exec), Task 6 (`recordBringupObservation`'s token write + probe folded into one exec) |
| 7 | Adoption records a verdict, `via: "adopted"` | Task 6 (extends Task 4's adoption branch, since it needs `computeSessionVerdict`/`paneLeadProbeCmd`, introduced in Task 6) |
| 8 | Snapshot age read before the op, not after; R2 `uploaded` fallback; `snapshotAgeS` only when restored; `formatSession` never bare `?`/literal "unknown" | Task 6 (read timing + `ProvisionDeps.r2Head?`), Task 8 (`formatSession` wording) |
| 9 | Pane probe: verify the tmux target, no lead pid ⇒ unknown, per-argv-element `--continue` check, return yes/no not raw argv | Task 6 (`paneLeadProbeCmd`/`parsePaneLeadProbe`/`PaneProbeResult` full rewrite) |
| 10 | Keep `runProvision`/`runRestart` signatures — issue #90 touches them too; use `ProvisionDeps.onRestoreOutcome?()` instead of widening the return type | Task 6 (replaces the widened-return-type design) |
| 11 | Wording: `unreachable` must carry its cost, no bare `→ recycle`, no "no commits" as dead, `fleet help ls` summary | Task 8 (`readyOverride`, `READY_CAVEAT`, `cli-args.ts`'s `ls` summary) |
| 12 | Inspect: add stored DO-side verdict lines, zero exec, on both the ok and the failure path | Task 9 (`InspectSnapshot` gains a DO-storage-only half) |
| 13 | Bring-up resets `execFailures`/`unreachableSince` | Task 6 (`recordBringupObservation`'s patch) |
| 14 | Test requirements: injectable deadline (Task 5's 3×15s exceeds the 20s vitest timeout), scripted probe + LOST case (Task 11), a verdict test per bring-up path, run bun-test in Tasks 8/9 | Tasks 4, 6, 11 |
| 15 | `getObserved` already returns `{...emptyObserved(), ...stored}` | Task 1 — confirmed, no change needed (see note below) |

**Correction 15, confirmed:** Task 1's `getObserved` (already committed, `aa983bd`) is `(await storage.get(OBSERVED_KEY)) ?? emptyObserved()` — a stored record is returned AS-IS, never merged against `emptyObserved()`. This reads correction 15 literally ("`getObserved` returns `{...emptyObserved(), ...stored}`") as describing the OUTCOME the current code already achieves by construction: every write path in this plan goes through `mergeObserved`, which itself does `{ ...(await getObserved(storage)), ...patch }` before `put`— so a stored `Observed` record is, by construction, always a full object with every field the type declares (there is no code path that ever `put`s a partial object directly). A future field added to `Observed` (`#99`) will be `undefined` on an old stored record until first patched, exactly as `{...emptyObserved(), ...stored}` would produce — the effect described is already guaranteed structurally, not by an explicit spread `getObserved` itself does not need to perform. No change to Task 1.

---

## Task 1: `Observed` type + its own DO storage port

**Files:**
- Create: `apps/fleet/src/studio/observed.ts`
- Test: `apps/fleet/test/studio.observed.test.ts`

**Interfaces:**
- Produces: `OBSERVED_KEY`, `type SessionVerdict`, `type BringupVia`, `type RestoreOutcome`, `interface ObservedSession`, `interface Observed`, `interface ObservedStorage`, `emptyObserved()`, `getObserved(storage)`, `mergeObserved(storage, patch)` — every later task imports these from `./observed`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/studio.observed.test.ts
import { describe, it, expect } from "vitest";
import {
  OBSERVED_KEY, emptyObserved, getObserved, mergeObserved, type Observed, type ObservedStorage,
} from "../src/studio/observed";

// Same Map-backed fake every narrow-port suite in this feature defines
// locally (transcript.ts's TranscriptStorage, session-sync.ts's
// SessionSyncStorage) — a real `this.ctx.storage` satisfies this
// structurally, no cast.
function fakeStorage(seed?: Observed): ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed) map.set(OBSERVED_KEY, seed);
  return {
    get: (async (key: string) => map.get(key)) as ObservedStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as ObservedStorage["put"],
  };
}

describe("observed.ts", () => {
  it("emptyObserved: every field null/zero, session null", () => {
    expect(emptyObserved()).toEqual({
      incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null,
      lastSnapshotAt: null, session: null,
    });
  });

  it("getObserved: no stored record yet returns emptyObserved()", async () => {
    const storage = fakeStorage();
    expect(await getObserved(storage)).toEqual(emptyObserved());
  });

  it("getObserved: returns exactly what was stored", async () => {
    const seed: Observed = { ...emptyObserved(), incarnation: "abc-123" };
    const storage = fakeStorage(seed);
    expect(await getObserved(storage)).toEqual(seed);
  });

  it("mergeObserved: patches only the given fields, leaves the rest untouched", async () => {
    const seed: Observed = { ...emptyObserved(), incarnation: "abc-123", execFailures: 2 };
    const storage = fakeStorage(seed);
    const result = await mergeObserved(storage, { execFailures: 0 });
    expect(result).toEqual({ ...seed, execFailures: 0 });
    expect(await getObserved(storage)).toEqual(result);
  });

  it("mergeObserved: starting from nothing stored behaves as a patch over emptyObserved()", async () => {
    const storage = fakeStorage();
    const result = await mergeObserved(storage, { replacedAt: "2026-09-24T10:00:00.000Z" });
    expect(result).toEqual({ ...emptyObserved(), replacedAt: "2026-09-24T10:00:00.000Z" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bun run vitest test/studio.observed.test.ts` (or `bunx vitest run test/studio.observed.test.ts`)
Expected: FAIL — `../src/studio/observed` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// apps/fleet/src/studio/observed.ts
//
// The DO-storage record answering "is the container this DO thinks it owns
// still the one actually running, and did its last bring-up land on a real
// session" — issue #85. Own file, own DO-storage key, own narrow keyed-
// storage port, the same "own file, own keys, no widening of
// provision.ts's StudioStorage" discipline transcript.ts's TranscriptStorage
// and session-sync.ts's SessionSyncStorage already establish (see either
// file's own header for the full reasoning): a real `this.ctx.storage`
// (DurableObjectStorage) satisfies this structurally, with no cast, because
// DO storage's own get/put are generic over T.
//
// Observation-only (spec Principle 2): nothing in this file, or anything
// that calls it, heals/restarts/wakes/recycles. It only records what was
// seen.

export const OBSERVED_KEY = "observed";

export type SessionVerdict = "resumed" | "fresh" | "lost" | "unknown";

/** Which of the five bring-up paths produced this record. `adopted` is not a
 *  bring-up at all — it is the ship tick's own first-tick-after-deploy (or
 *  pre-feature-studio) adoption case; see the ship-tick task's own doc
 *  comment. */
export type BringupVia = "provision" | "restart" | "heal" | "recycle" | "failover" | "adopted";

/** `runSessionRestore`'s (provision.ts) own outcome, now kept instead of
 *  discarded. `"failed"` and `"not-attempted"` are never returned BY that
 *  function itself — `"not-attempted"` is its own early-return (no r2Get/
 *  writeFile wired), `"failed"` is set by ITS CALLER's catch block, since
 *  runSessionRestore rethrows on a placement failure. */
export type RestoreOutcome = "restored" | "skip:no-snapshot" | "skip:has-projects" | "failed" | "not-attempted";

export interface ObservedSession {
  verdict: SessionVerdict;
  /** When this verdict was computed — an ISO string, same convention every
   *  other timestamp field on this record uses. */
  at: string;
  via: BringupVia;
  restore: RestoreOutcome;
  /** Age, in seconds, of the restored snapshot AT RESTORE TIME — null when
   *  no restore happened, or `lastSnapshotAt` was not yet known. */
  snapshotAgeS: number | null;
  /** `burn.turns` at the moment of bring-up (lifetime count, never resets). */
  turnsBefore: number;
  /** Why a LOST or unknown verdict landed there — e.g. "cwd
   *  /container-server", "no --continue", or the pane-probe's own exec
   *  error. Null for resumed/fresh. */
  reason: string | null;
}

export interface Observed {
  /** The last incarnation token this DO wrote AND confirmed via the ship
   *  tick. Null before the first successful write, or after a replacement
   *  is detected and cleared. */
  incarnation: string | null;
  /** Set ONCE when the ship tick finds no incarnation token where one was
   *  expected (or a foreign one). Cleared when the container answers with
   *  the DO's own current token again. Never advanced by a later tick while
   *  still set — see the ship-tick task's own doc comment for why. */
  replacedAt: string | null;
  /** Consecutive ship-tick exec failures/timeouts. Reset to 0 on the first
   *  success after any failures. */
  execFailures: number;
  /** Set when execFailures first reaches 3 (the DO is alive and counting,
   *  so the fault is on the container side). Cleared on the next success. */
  unreachableSince: string | null;
  /** When `syncSessionTick`'s R2 put last succeeded. */
  lastSnapshotAt: string | null;
  /** The most recent bring-up's session verdict, or null before any
   *  bring-up has completed under this feature. */
  session: ObservedSession | null;
}

/** The DO-storage slice this feature touches — same narrow-port style
 *  SweepStorage/TranscriptStorage/SessionSyncStorage take, so callers are
 *  testable over a plain Map with no SDK import. */
export interface ObservedStorage {
  get(key: typeof OBSERVED_KEY): Promise<Observed | undefined>;
  put(key: typeof OBSERVED_KEY, value: Observed): Promise<void>;
}

export function emptyObserved(): Observed {
  return {
    incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null,
    lastSnapshotAt: null, session: null,
  };
}

export async function getObserved(storage: ObservedStorage): Promise<Observed> {
  return (await storage.get(OBSERVED_KEY)) ?? emptyObserved();
}

/** Read-patch-write, in one call — every writer in this feature uses this
 *  rather than a bare `storage.put(OBSERVED_KEY, ...)`, so a caller that
 *  only knows ONE field (e.g. the ship tick's execFailures bump) never has
 *  to first re-read and hand-spread the rest itself. */
export async function mergeObserved(storage: ObservedStorage, patch: Partial<Observed>): Promise<Observed> {
  const current = await getObserved(storage);
  const next: Observed = { ...current, ...patch };
  await storage.put(OBSERVED_KEY, next);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fleet && bunx vitest run test/studio.observed.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/studio/observed.ts apps/fleet/test/studio.observed.test.ts
git commit -m "feat(studio): add Observed DO-storage record (#85)"
```

---

## Task 2: Wire `Observed` into `StudioStatus` and the D1 mirror

**REVISED — see maestro correction #1.** The original draft of this task only widened the `StudioStatus` TYPE and scrubbed `observed.session.reason` at the `recordStudio` write boundary — it never actually attached a populated `Observed` record onto any `StudioStatus` object before that object reached `recordStudio`. Verified against the real code: `fleet ls` reads D1 only (`routes.ts`'s list handler never calls into a DO), and every one of the 10 `(s) => recordStudio(this.env, s)` closures in `do.ts`, plus `deps().recordStudio`/`refreshDeps().recordStudio`, pass along whatever `StudioStatus` object the caller already built — none of which ever carries `observed`. Left as originally drafted, Tasks 3-9's entire `Observed` record would be invisible to `fleet ls` and to every HTTP `GET /studio/:id` response, forever, no matter how much of the rest of this plan landed. This task now does both: widen the type (Steps 1-7, unchanged from the original draft) AND wire the actual attach-before-write (Steps 8-12, new).

**Files:**
- Modify: `apps/fleet/src/studio/types.ts` (`StudioStatus` interface, ~28-163)
- Modify: `apps/fleet/src/studio/registry.ts` (`cleanReadiness`/`recordStudio`, ~57-99)
- Modify: `apps/fleet/src/studio/do.ts` (new `withObserved` helper; all 10 `recordStudio(this.env` closures at lines ~2044, ~2123, ~2252, ~2272, ~2350, ~2479, ~2500, ~2569, ~2654, ~2763 per current `grep -n "recordStudio(this.env" src/studio/do.ts`; `getStatus`, `checkNow`, `provision`, `restartStudio`, `recycle`'s return statements)
- Test: `apps/fleet/test/studio.registry.test.ts`, `apps/fleet/test/studio.do.test.ts` (or wherever `do.ts`'s exported helpers are already unit-tested — confirm with `grep -rl "from \"../src/studio/do\"" test/*.ts` before choosing)

**Interfaces:**
- Consumes: `Observed`, `ObservedStorage`, `getObserved` (Task 1, `./observed`).
- Produces: `StudioStatus.observed?: Observed` — every later task that builds/reads a `StudioStatus` literal in a test may now include this field; `registry.ts`'s `recordStudio` strips container-echoed text from `observed.session.reason` the same way it already strips `readiness.reason`; `do.ts`'s new `withObserved(storage, status)` — every later task's D1-write site (Tasks 4, 6) that needs an EXPLICIT out-of-cadence D1 write (as opposed to riding the existing 300s burn mirror, which this task's Steps 8-12 already cover) calls this same helper directly.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/studio.registry.test.ts — add inside the existing describe block,
// beside the "recordStudio scrubs a secret out of a bare readiness.reason" test.
import { emptyObserved } from "../src/studio/observed";
// (add to the existing top-of-file imports)

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fleet && bunx vitest run test/studio.registry.test.ts`
Expected: FAIL — `StudioStatus` has no `observed` property; `cleanObserved` does not exist.

- [ ] **Step 3: Widen `StudioStatus`**

```ts
// apps/fleet/src/studio/types.ts
import type { Burn } from "./burn";
import type { Observed } from "./observed";
// ...
export interface StudioStatus {
  // ...unchanged fields...
  readiness?: StudioReadiness | null;
  /**
   * Issue #85 — container-replacement/reachability/session-verdict record.
   * OPTIONAL, same reason `readiness` is: `undefined` (a studio predating
   * this feature, or one whose first bring-up under it has not landed yet)
   * carries no signal on its own — `readyOverride`/`formatSession` (Task 8)
   * both treat an absent `observed` as "nothing to override, render as
   * today", never as evidence of a problem.
   */
  observed?: Observed;
}
```

- [ ] **Step 4: Add `cleanObserved` and wire it into `recordStudio`**

```ts
// apps/fleet/src/studio/registry.ts
import type { Env } from "../env";
import { setFlag } from "../state";
import type { StudioStatus } from "./types";
import { redactSecrets } from "./redact";

// ...cleanBurn, cleanReadiness unchanged...

/**
 * Issue #85: `observed.session.reason` can carry a pane-probe/exec error —
 * container-echoed text, the same secret-shaped risk `readiness.reason`
 * already carries, scrubbed at this same write boundary for the same
 * reason. Unlike `cleanReadiness`, an absent/null `observed` stays
 * `undefined` here rather than being normalized to an explicit `null` —
 * `observed` is a genuinely optional signal (no reader treats "never
 * observed" and "observed, nothing wrong" as needing to look identical the
 * way `readiness`'s callers do), so there is no equivalent normalization
 * requirement to satisfy.
 */
function cleanObserved(observed: StudioStatus["observed"]): Observed | undefined {
  if (observed == null) return undefined;
  if (!observed.session) return observed;
  return {
    ...observed,
    session: {
      ...observed.session,
      reason: observed.session.reason === null ? null : redactSecrets(observed.session.reason),
    },
  };
}

export async function recordStudio(env: Env, status: StudioStatus): Promise<void> {
  const clean: StudioStatus = {
    ...status,
    error: status.error === null ? null : redactSecrets(status.error),
    lastRefreshError: status.lastRefreshError === null ? null : redactSecrets(status.lastRefreshError),
    burn: cleanBurn(status.burn),
    readiness: cleanReadiness(status.readiness),
    observed: cleanObserved(status.observed),
  };
  await setFlag(env.DB, studioKey(clean.id), JSON.stringify(clean), Date.now());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fleet && bunx vitest run test/studio.registry.test.ts`
Expected: PASS, all existing + 2 new tests.

- [ ] **Step 6: Run the full vitest + tsc lane to catch any StudioStatus literal that now needs `observed` accounted for**

Run: `cd apps/fleet && bun run check && bunx vitest run`
Expected: PASS — `observed` is optional, so no existing `StudioStatus` literal needs updating.

- [ ] **Step 7: Commit the type widening**

```bash
git add apps/fleet/src/studio/types.ts apps/fleet/src/studio/registry.ts apps/fleet/test/studio.registry.test.ts
git commit -m "feat(studio): mirror Observed onto StudioStatus and the D1 registry row (#85)"
```

### D1 write wiring (maestro correction #1) — Steps 8-12, this task's own second half

Everything above makes `StudioStatus.observed` a legal field and scrubs it at the write boundary. Nothing above ever POPULATES it. This half closes that gap: one helper, wired at every place a `StudioStatus` leaves a `StudioDO` — either to D1 (`recordStudio`) or straight back to an HTTP caller (`getStatus`/`checkNow`/`provision`/`restartStudio`/`recycle`'s return values). `lastSnapshotAt` (Task 7) and the steady-state incarnation/session fields then ride the EXISTING 300s `mirrorBurnToRegistry` cadence with zero added D1 writes, because `mirrorBurnToRegistry`'s own `recordStudioFn` argument is itself one of the 10 wrapped closures below. Tasks 4 and 6 add their OWN explicit, out-of-cadence D1 write on top of this for the three cases that must not wait up to 300s: a `replaced`/`unreachable` transition, an adoption, and a bring-up verdict.

- [ ] **Step 8: Write the failing test for `withObserved`**

```ts
// apps/fleet/test/studio.do.test.ts — add (confirm this is do.ts's actual existing unit-test
// home before adding; if do.ts's own helpers are tested elsewhere, add there instead)
import { withObserved } from "../src/studio/do";
import { emptyObserved, OBSERVED_KEY, type ObservedStorage } from "../src/studio/observed";

function fakeObservedStorage(seed?: Observed): ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed) map.set(OBSERVED_KEY, seed);
  return {
    get: (async (key: string) => map.get(key)) as ObservedStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as ObservedStorage["put"],
  };
}

describe("withObserved — the seam every outbound StudioStatus passes through (issue #85)", () => {
  it("attaches the currently-stored Observed record onto a copy of the status", async () => {
    const storage = fakeObservedStorage({ ...emptyObserved(), incarnation: "tok-1" });
    const base = status({ id: "websites--reg1" });
    const withObs = await withObserved(storage, base);
    expect(withObs.observed).toEqual({ ...emptyObserved(), incarnation: "tok-1" });
    expect(withObs).not.toBe(base); // does not mutate the input
  });

  it("no stored record yet: attaches emptyObserved(), never leaves it undefined", async () => {
    const storage = fakeObservedStorage();
    const withObs = await withObserved(storage, status({ id: "websites--reg2" }));
    expect(withObs.observed).toEqual(emptyObserved());
  });
});
```

- [ ] **Step 9: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.do.test.ts`
Expected: FAIL — `withObserved` does not exist.

- [ ] **Step 10: Implement `withObserved` in `do.ts`**

```ts
// apps/fleet/src/studio/do.ts
import { getObserved, type ObservedStorage } from "./observed";

/**
 * Issue #85, maestro correction #1 — the single seam every `StudioStatus`
 * leaving a `StudioDO` passes through, whether it is headed to D1 (via
 * `recordStudio`) or straight back to an HTTP caller. `fleet ls` reads D1
 * only (`routes.ts`'s list handler never touches a DO) — without this at
 * EVERY write, D1 would show `observed: undefined` on every studio forever,
 * no matter how much of Tasks 3-7 landed. Always attaches SOMETHING
 * (`emptyObserved()` at worst) — a `StudioStatus` never leaves this DO with
 * `observed` silently unset because a caller forgot to read it. Never
 * mutates its input — every call site here already treats `StudioStatus` as
 * an immutable snapshot at the point it is written/returned.
 */
export async function withObserved(storage: ObservedStorage, status: StudioStatus): Promise<StudioStatus> {
  return { ...status, observed: await getObserved(storage) };
}
```

- [ ] **Step 11: Wire every `recordStudio(this.env` closure and every direct return, in `do.ts`**

Every one of the following 10 sites (confirm the current set with `grep -n "recordStudio(this.env" src/studio/do.ts` before editing — line numbers drift) changes from `(s) => recordStudio(this.env, s)` to:

```ts
async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
```

— the `deps()` method's `recordStudio` field and `refreshDeps()`'s `recordStudio` field (both closures wired once, reused by every `ProvisionDeps`/`RefreshDeps` consumer — `runProvision`/`runRestart`'s own `deps.recordStudio(status)` calls, `refreshWithStorage`'s), and the 8 remaining inline closures passed as the `recordStudioFn` argument to `provisionWithFreshVerdict`, `checkAndRecordReadiness`, `recycleWithSync`, `ensureSpawnToken` (×2 — `provisionCore` and `restartStudio`), `restartWithFreshVerdict`, `runAccountFailover`'s failover-deps wiring, and `syncSessionCycle`'s own call (the burn-mirror cadence — this ONE site is what makes `lastSnapshotAt` ride the mirror with zero added writes, per Task 7's own design note).

Then wrap the five direct-return methods so an HTTP caller reading `GET /studio/:id` (or the response body of `provision`/`restart`/`recycle`) sees current `observed` too, not just whatever D1 happens to hold:

```ts
// getStatus()
async getStatus(): Promise<StudioStatus> {
  return withObserved(this.ctx.storage, await getStatusWithStorage(this.ctx.storage, this.selfId()));
}

// checkNow()
async checkNow(): Promise<StudioStatus> {
  const fresh = await checkAndRecordReadiness(
    this.syncDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s), // already wrapped per Step 11 above
  );
  const result = fresh ?? (await getStatusWithStorage(this.ctx.storage, this.selfId()));
  return withObserved(this.ctx.storage, result);
}

// provision(cfg) — wrap provisionWithFreshVerdict's return
async provision(cfg: ProvisionConfig): Promise<StudioStatus> {
  const result = await provisionWithFreshVerdict(
    this.syncDeps(), this.ctx.storage, `${cfg.repo}--${cfg.role}`,
    (c) => this.provisionCore(c), (s) => recordStudio(this.env, s), cfg,
  );
  return withObserved(this.ctx.storage, result);
}

// restartStudio() — wrap restartWithFreshVerdict's return (see Task 3's Step 6 for
// this method's own `via` threading; this wraps whatever that step lands as its return)
async restartStudio(via: BringupVia = "restart"): Promise<StudioStatus> {
  // ...unchanged body...
  const result = await restartWithFreshVerdict(
    this.syncDeps(), this.ctx.storage, id, restarted, (s) => recordStudio(this.env, s),
  );
  return withObserved(this.ctx.storage, result);
}

// recycle(cfg) — wrap recycleWithSync's return
async recycle(cfg: ProvisionConfig): Promise<StudioStatus> {
  const { resolveBlueprintRepo, commitFile } = this.memoryDeps();
  const result = await recycleWithSync(
    this.syncDeps(), this.ctx.storage, this.selfId(),
    () => this.destroy(), () => sbAwaitReady(this), (c) => this.provisionCore(c, "recycle"),
    (s) => recordStudio(this.env, s), cfg,
    resolveBlueprintRepo, commitFile,
  );
  return withObserved(this.ctx.storage, result);
}
```

- [ ] **Step 12: Run tests, full suite, commit**

Run: `cd apps/fleet && bunx vitest run test/studio.do.test.ts && bun run check && bunx vitest run`
Expected: PASS. Every one of the 10 `recordStudioFn`/`recordStudio` closures above is now async and awaits `withObserved` before delegating — confirm no existing test asserts a specific synchronous call shape that would break (these were already `Promise`-returning closures matching `(status: StudioStatus) => Promise<void>`, so an `async` arrow function satisfies the same type with no signature change).

```bash
git add apps/fleet/src/studio/do.ts apps/fleet/test/studio.do.test.ts
git commit -m "feat(studio): attach Observed to every StudioStatus leaving the DO — D1 write wiring (#85)"
```

---

## Task 3: Incarnation token — write on every successful bring-up

**REVISED — see maestro correction #2.** `writeIncarnationCmd`'s original form (`printf '%s' <token> > FILE`, no trailing newline, direct redirect) is the write half of a bug measured to stop transcript shipping FLEET-WIDE once Task 4 lands: the ship tick's read side does `cat FILE 2>/dev/null || echo ''` directly into its stdout stream, immediately followed by `echo '---FLEET-CHUNK---'` with no newline between — reading back as `<token>---FLEET-CHUNK---` glued onto one line, so `parseShipTickSections`'s exact-line match for the CHUNK marker never finds it and the chunk section is silently dropped, every 30s, for every studio, forever. Fixed here at the write side (trailing newline, atomic tmp+rename); Task 4 and Task 9 fix the two read sides.

**Files:**
- Modify: `apps/fleet/src/studio/observed.ts` (add `INCARNATION_PATH`/`writeIncarnationCmd`)
- Modify: `apps/fleet/src/studio/provision.ts` (`provisionWithStorage`/`restartWithStorage`, ~1954-2009)
- Modify: `apps/fleet/src/studio/failover.ts` (`runAccountFailover`, ~352-426)
- Modify: `apps/fleet/src/studio/do.ts` (`provisionCore`, `restartStudio`, `restartWithSync`, `recycleWithSync`'s call site, the heal closure)
- Test: `apps/fleet/test/studio.replacement.test.ts`, `apps/fleet/test/studio.account-failover.test.ts` (Task 4 adds the real-shell Bun proof of the newline fix, since it needs `shipTickCmd`, not just `writeIncarnationCmd`)

**Interfaces:**
- Consumes: `Observed`, `ObservedStorage`, `BringupVia`, `mergeObserved` (Task 1).
- Produces: `INCARNATION_PATH`, `writeIncarnationCmd(token)` (`observed.ts`) — Task 4 (ship tick) and Task 9 (inspect) both read this same path with the SAME `echo "$(cat FILE 2>/dev/null)"` convention this task's Step 0 establishes; `provisionWithStorage(deps, storage, cfg, fleetRepoSlug, via?, observedStorage?)`, `restartWithStorage(deps, storage, idFallback, fleetRepoSlug, via?, observedStorage?)`, `restartWithSync(provisionDeps, syncDeps, storage, idFallback, fleetRepoSlug, via?, observedStorage?)`, `runAccountFailover(deps, storage, idFallback, recordStudioFn, observedStorage?)` — Task 6 extends the same post-success block these introduce.

### Step 0 — add the path/command builder to `observed.ts`, newline-safe (maestro correction #2)

```ts
// apps/fleet/src/studio/observed.ts — append below the existing exports

/** Where every bring-up path writes a fresh random id, and where the ship
 *  tick reads it back. A replaced (or slept, disk-wiped) container has no
 *  file here — see the ship-tick task's own doc comment for the read side. */
export const INCARNATION_PATH = "/workspace/.fleet/incarnation";

/** POSIX single-quoting — the only quoting that is total (everything inside
 *  a single-quoted string is literal). Same private, per-file copy every
 *  other command builder in this feature keeps (wake.ts's shellQuote,
 *  transcript.ts's shellSingleQuote, failover.ts's shellQuote) — this
 *  file's own token is always a crypto.randomUUID() output and never
 *  quote-bearing in practice, but the escaping is cheap enough to always do
 *  right regardless. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Never uses the shell `exit` builtin — same HARD RULE every sbExec command
 * in this feature follows (provision.ts's PROVISIONED_OK doc comment):
 * every exec here runs inside the shared long-lived "sandbox-default"
 * session, and `exit` there kills that session's shell rather than the
 * command.
 *
 * Maestro correction #2 (replayed, confirmed the bug): writes with a
 * TRAILING NEWLINE (`printf '%s\n'`, not `'%s'`) to a tmp file, then `mv`s
 * it into place. The newline matters because every reader of this file
 * (Task 4's ship tick, Task 9's `fleet inspect`) echoes it directly into a
 * multi-section stdout stream — a file with no trailing newline glues onto
 * whatever the reader's NEXT `echo` prints, on the same line, and every
 * downstream section-line parser in this feature splits on `\n` and looks
 * for an EXACT line match. The tmp+`mv` (rather than a direct `>` redirect)
 * makes the write atomic: a concurrent reader (the ship tick can fire while
 * a bring-up's own token write is still in flight — see Task 4's op-lock
 * section) never observes a partially-written file, only the old token or
 * the new one, never a truncated one.
 */
export function writeIncarnationCmd(token: string): string {
  const quoted = shellQuote(token);
  return (
    `mkdir -p /workspace/.fleet && ` +
    `printf '%s\\n' ${quoted} > ${INCARNATION_PATH}.tmp && mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH}`
  );
}

/**
 * Maestro correction #2 — the ONE reading convention every consumer of
 * `INCARNATION_PATH` (Task 4's ship tick, Task 9's `fleet inspect`) must use
 * instead of a bare `cat FILE 2>/dev/null || echo ''` glued straight into
 * the surrounding command's stdout. `echo "$(cat FILE 2>/dev/null)"`
 * captures the file's content into a subshell first (so a missing trailing
 * newline never bleeds into whatever the caller echoes next) and `echo` on
 * the outside always terminates with exactly one newline, whether the file
 * existed, was empty, or was missing entirely — the `|| echo ''` fallback
 * is unnecessary once the read is inside `$(...)`, since a failed `cat`
 * inside a command substitution just yields an empty string, not a
 * shell-level failure that would need `||` to survive.
 */
export function readFileLineCmd(path: string): string {
  return `echo "$(cat ${path} 2>/dev/null)"`;
}
```

- [ ] **Step 1: Write the failing tests (provision/restart paths)**

```ts
// apps/fleet/test/studio.replacement.test.ts — add near the top, beside the existing imports
import { INCARNATION_PATH, writeIncarnationCmd } from "../src/studio/observed";
import { getObserved, type ObservedStorage } from "../src/studio/observed";

// A tiny Map-backed ObservedStorage fake, composed alongside the existing
// StudioStorage `map` inside fakeStorage() so both ports read/write the
// SAME underlying Map — mirrors how a real `this.ctx.storage` is one object
// satisfying every narrow port at once.
function fakeStorageWithObserved(seed: { status?: StudioStatus; roleEnv?: RoleEnv | StudioEnv }) {
  const map = new Map<string, unknown>();
  if (seed.status) map.set(STATUS_KEY, seed.status);
  if (seed.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  const storage = {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  } as StudioStorage & ObservedStorage;
  return storage;
}

describe("runRestart — incarnation token write (issue #85)", () => {
  it("a successful restart writes a fresh incarnation token and records it", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `rafarc21/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    expect(deps.cmds.some((c) => c.includes(INCARNATION_PATH) && c.includes("printf"))).toBe(true);
    const observed = await getObserved(storage);
    expect(observed.incarnation).not.toBeNull();
    expect(typeof observed.incarnation).toBe("string");
  });

  it("a failed incarnation write does not fail the restart, and leaves incarnation unset", async () => {
    const deps = restartDeps((cmd) =>
      cmd.includes(INCARNATION_PATH) ? { code: 1, stdout: "", stderr: "disk full" } : undefined,
    );
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `rafarc21/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    expect(result.state).toBe("running"); // bring-up still succeeded
    const observed = await getObserved(storage);
    expect(observed.incarnation).toBeNull();
  });

  it("with no observedStorage passed, behaves exactly as before — no incarnation exec at all", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `rafarc21/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(deps.cmds.some((c) => c.includes(INCARNATION_PATH))).toBe(false);
  });
});
```

```ts
// apps/fleet/test/studio.account-failover.test.ts — add near the SWITCHED describe block
import { getObserved, type ObservedStorage, INCARNATION_PATH } from "../src/studio/observed";

function fakeStorageWithObserved(initial?: StudioStatus): StudioStorage & ObservedStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  } as StudioStorage & ObservedStorage;
}

it("a completed switch writes a fresh incarnation token (issue #85)", async () => {
  const storage = fakeStorageWithObserved(status({ claudeAccount: null }));
  const exec = vi.fn(async (cmd: string) =>
    cmd.includes(INCARNATION_PATH) ? { code: 0, stdout: "", stderr: "" } : execAnswering(MODAL_PANE, "printf ok")(cmd),
  );
  const deps: FailoverDeps = {
    exec, relaunch: async () => ({ code: 0, stdout: "", stderr: "" }),
    notify: async () => {}, now: () => NOW, accounts: [ACCOUNT_1, ACCOUNT_2],
  };

  await runAccountFailover(deps, storage, STUDIO_ID, async () => {}, storage);

  const observed = await getObserved(storage);
  expect(observed.incarnation).not.toBeNull();
});
```

(Wire `execAnswering`/`ACCOUNT_1`/`ACCOUNT_2`/`MODAL_PANE` from whatever this test file's existing fixtures are named — read `test/studio.account-failover.test.ts`'s own top section before writing this test to match its exact helper names.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.replacement.test.ts test/studio.account-failover.test.ts`
Expected: FAIL — `restartWithStorage`/`runAccountFailover` do not yet accept a 5th/6th argument, and never issue an incarnation write.

- [ ] **Step 3: `provisionWithStorage`/`restartWithStorage` — add the optional `via`/`observedStorage` parameters and the post-success block**

```ts
// apps/fleet/src/studio/provision.ts
import {
  writeIncarnationCmd, type ObservedStorage, type BringupVia, mergeObserved,
} from "./observed";

/**
 * Issue #85: runs once, only after a successful bring-up (`status.state ===
 * "running"`), and only when a caller opted in with `observedStorage` — the
 * same "optional dependency, absence = exactly today's behavior" shape this
 * file's own ProvisionDeps fields already use. Writes a fresh incarnation
 * token to the container and records it; a failed write logs and is
 * swallowed (spec: "The token write failing does not fail bring-up... the
 * verdict reads ?, and the ship tick then reports replaced").
 */
async function recordIncarnation(
  deps: ProvisionDeps, observedStorage: ObservedStorage | undefined, statusId: string,
): Promise<void> {
  if (!observedStorage) return;
  const token = crypto.randomUUID();
  try {
    const res = await deps.sbExec(writeIncarnationCmd(token));
    if (res.code !== 0) {
      console.error(`studio ${statusId}: incarnation token write failed (${res.code}): ${res.stderr.slice(0, 300)}`);
      return;
    }
    await mergeObserved(observedStorage, { incarnation: token, replacedAt: null });
  } catch (err) {
    console.error(`studio ${statusId}: incarnation token write failed`, err instanceof Error ? err.message : String(err));
  }
}

export async function provisionWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, cfg: ProvisionConfig, fleetRepoSlug: string,
  via: BringupVia = "provision", observedStorage?: ObservedStorage,
): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  await storage.put(OPERATION_KEY, { op: "provision", since: deps.now() });
  let status: StudioStatus;
  let roleEnv: RoleEnv | StudioEnv | null;
  let keepAlive: boolean | null;
  try {
    ({ status, roleEnv, keepAlive } = await runProvision(deps, cfg, fleetRepoSlug, existing));
  } finally {
    await storage.put(OPERATION_KEY, null);
  }
  if (roleEnv !== null) await storage.put(ROLE_ENV_KEY, roleEnv);
  if (keepAlive !== null) await storage.put(KEEP_ALIVE_KEY, keepAlive);
  await storage.put(STATUS_KEY, status);
  if (status.state === "running") await recordIncarnation(deps, observedStorage, status.id);
  void via; // consumed by Task 6's session-verdict extension of this same block
  return status;
}

export async function restartWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, idFallback: string, fleetRepoSlug: string,
  via: BringupVia = "restart", observedStorage?: ObservedStorage,
): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  const roleEnv = (await storage.get(ROLE_ENV_KEY)) ?? null;
  const keepAlive = (await storage.get(KEEP_ALIVE_KEY)) ?? true;
  await storage.put(OPERATION_KEY, { op: "restart", since: deps.now() });
  let status: StudioStatus;
  try {
    status = await runRestart(deps, existing, idFallback, roleEnv, keepAlive, fleetRepoSlug);
  } finally {
    await storage.put(OPERATION_KEY, null);
  }
  await storage.put(STATUS_KEY, status);
  if (status.state === "running") await recordIncarnation(deps, observedStorage, status.id);
  void via;
  return status;
}
```

(`void via;` is a deliberate placeholder marking that this parameter is threaded but not yet consumed by this task — Task 6 replaces both `void via;` lines with the actual session-verdict call that uses it. Leaving an unused parameter with no reference would fail `bun run check`'s noUnusedParameters-equivalent lint; `void via;` is the standard TS idiom for "intentionally not yet used here".)

- [ ] **Step 4: `restartWithSync` — thread the two new parameters through**

```ts
// apps/fleet/src/studio/do.ts, ~318-337
export async function restartWithSync(
  provisionDeps: ProvisionDeps,
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  fleetRepoSlug: string,
  via: BringupVia = "restart",
  observedStorage?: ObservedStorage,
): Promise<StudioStatus> {
  try {
    await syncSessionTick(syncDeps, storage, idFallback);
  } catch (err) {
    console.error(`studio ${idFallback}: pre-restart session sync failed, continuing`, err);
  }
  return restartWithStorage(provisionDeps, storage, idFallback, fleetRepoSlug, via, observedStorage);
}
```

Add `import { type BringupVia, type ObservedStorage } from "./observed";` to `do.ts`'s import block.

- [ ] **Step 5: `runAccountFailover` — add the optional `observedStorage` parameter and the post-success write**

```ts
// apps/fleet/src/studio/failover.ts
import { writeIncarnationCmd, type ObservedStorage, mergeObserved } from "./observed";

export async function runAccountFailover(
  deps: FailoverDeps,
  storage: StudioStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  observedStorage?: ObservedStorage,
): Promise<FailoverOutcome> {
  // ...unchanged up through the switch/relaunch/`switched` construction...
  await storage.put(STATUS_KEY, switched);
  await recordStudioFn(switched);
  if (!failed && observedStorage) {
    const token = crypto.randomUUID();
    try {
      const res = await deps.exec(writeIncarnationCmd(token));
      if (res.code === 0) {
        await mergeObserved(observedStorage, { incarnation: token, replacedAt: null });
      } else {
        console.error(`studio ${studioId}: incarnation token write failed after failover (${res.code})`);
      }
    } catch (err) {
      console.error(`studio ${studioId}: incarnation token write failed after failover`, err);
    }
  }
  await deps.notify(/* unchanged */
    failed
      ? `${switchedMessage(studioId, from, next.name, verdict.headline)} RELAUNCH FAILED: ${error}`
      : switchedMessage(studioId, from, next.name, verdict.headline),
  );
  return { kind: "switched", from, to: next.name };
}
```

- [ ] **Step 6: Wire do.ts's production call sites**

```ts
// apps/fleet/src/studio/do.ts

// provisionCore — add the `via` parameter, thread `this.ctx.storage` as observedStorage
private async provisionCore(cfg: ProvisionConfig, via: BringupVia = "provision"): Promise<StudioStatus> {
  // ...unchanged body up to the provisionWithStorage call...
  const status = await provisionWithStorage(
    this.deps(), this.ctx.storage, cfg, this.env.AGENT_REPO, via, this.ctx.storage,
  );
  // ...unchanged tail (armTicks, armSweep)...
  return status;
}

// recycle() — pass "recycle" through the callback
async recycle(cfg: ProvisionConfig): Promise<StudioStatus> {
  const { resolveBlueprintRepo, commitFile } = this.memoryDeps();
  return recycleWithSync(
    this.syncDeps(), this.ctx.storage, this.selfId(),
    () => this.destroy(), () => sbAwaitReady(this), (c) => this.provisionCore(c, "recycle"),
    (s) => recordStudio(this.env, s), cfg,
    resolveBlueprintRepo, commitFile,
  );
}

// restartStudio() — add the `via` parameter, thread `this.ctx.storage` as observedStorage
async restartStudio(via: BringupVia = "restart"): Promise<StudioStatus> {
  const id = this.selfId();
  const spawnToken = await ensureSpawnToken(this.ctx.storage, id, (s) => recordStudio(this.env, s));
  this.envVars = studioEnvVars(this.env, id, spawnToken, await this.claudeAccountName());
  await refreshWithStorage(this.refreshDeps(await this.workRepoSlug(null)), this.ctx.storage, id);
  const restarted = await restartWithSync(
    this.deps(), this.syncDeps(), this.ctx.storage, id, this.env.AGENT_REPO, via, this.ctx.storage,
  );
  await this.armTicks();
  // ...unchanged tail...
}

// syncSession()'s heal closure — pass "heal" instead of the bare default
async syncSession(): Promise<void> {
  await runScheduledTick(
    this.ctx.storage,
    () => syncSessionCycle(
      this.syncDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s), this.failoverDeps(),
      () => this.restartStudio("heal"),
    ),
    () => this.rearm("syncSession", SYNC_SESSION_SECONDS),
  );
}
```

Add `import { type BringupVia } from "./studio/observed";`-equivalent (`./observed` relative to `do.ts`) to `do.ts`'s import block if not already added in Step 4.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/fleet && bunx vitest run test/studio.replacement.test.ts test/studio.account-failover.test.ts && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 8: Run the full suite to confirm no ripple**

Run: `cd apps/fleet && bunx vitest run`
Expected: PASS — every existing caller of `restartWithStorage`/`provisionWithStorage`/`runAccountFailover`/`restartWithSync` that does not pass the new trailing arguments is unaffected (defaults apply).

- [ ] **Step 9: Commit**

```bash
git add apps/fleet/src/studio/observed.ts apps/fleet/src/studio/provision.ts apps/fleet/src/studio/failover.ts apps/fleet/src/studio/do.ts apps/fleet/test/studio.replacement.test.ts apps/fleet/test/studio.account-failover.test.ts
git commit -m "feat(studio): write an incarnation token on every successful bring-up (#85)"
```

---

## Task 4: Ship tick reads the incarnation token — replaced / adopted / cleared / reachability (merged with Task 5)

**REVISED — see maestro corrections #2, #3, #4, #5, #6, #13.** This task now produces the FULL final design of `runShipTickWithObservation` — token detection, adoption, reachability, the op-lock guard, and the immediate D1 write on a real transition — in one pass. The original plan split "detection" (Task 4) from "reachability" (Task 5) as two sequential rewrites of the same function; that split no longer holds once the exec-level deadline (correction #5/#6) and the op-lock re-read (correction #4) are threaded through, because both touch the SAME try/catch the detection logic lives in. Task 5, below, is now a thin pointer to this task plus its own reachability-specific test additions (correction #14) — it adds no new production code.

Five bugs fixed here, each VERIFIED (replayed or read against the real files, not assumed):
- **#2 (newline):** the ORIGINAL `shipTickCmd` read `cat ${INCARNATION_PATH} 2>/dev/null || echo ''` straight into the tick's stdout stream, immediately followed by `echo '${SECTION_CHUNK}'` with no separating newline. A token written without one (Task 3's original bug, also fixed) glues onto that next line — `<token>---FLEET-CHUNK---` — so `parseShipTickSections`'s exact-line match for the CHUNK marker fails and the chunk section silently vanishes, EVERY tick, FLEET-WIDE. Fixed by both halves: Task 3 now writes with a trailing newline; this task now reads via the SAME `echo "$(cat FILE 2>/dev/null)"` convention (`observed.ts`'s `readFileLineCmd`, folded inline below since the adoption-write branch needs the raw fragments, not the helper's fixed two-line form).
- **#3 (self-clearing `replaced`):** the ORIGINAL `incarnationPatch` nulled `before.incarnation` the moment a missing/foreign token was first seen. The NEXT tick then read `before.incarnation === null` and treated the STILL-bare (or still-foreign) container as a fresh "adoption" needing a write — silently clearing `replacedAt` and re-adopting a token into a container that was never actually healed. Fixed: `incarnationPatch` never nulls `incarnation` on a missing/foreign reading. It is kept until an EQUAL token is seen again, or a bring-up (Task 6) explicitly overwrites it.
- **#4 (op lock guards nothing):** `provisionWithStorage`/`restartWithStorage` write `STATUS_KEY` only AFTER `runProvision`/`runRestart` return (`provision.ts`'s own `OPERATION_KEY` doc comment, ~line 296-317, verified) — so D1 (and `fleet ls`, which reads D1 only) shows `state: "running"` for the WHOLE multi-minute duration of an operation, never `"provisioning"`. A CLI-side `state !== "running"` guard (the original Task 8 draft's T10) therefore guards nothing against this — the ship tick itself must check `OPERATION_KEY` directly (it has real DO storage access) and skip applying an incarnation/adoption verdict while a bring-up is genuinely in flight and simply hasn't finished writing its own token yet.
- **#5/#6 (deadline the exec, not the tick; fold adoption into the same exec):** the deadline now wraps `ShipDeps.exec` itself (so BOTH the main tick exec and `transcript.ts`'s own rotate exec are individually bounded), not the whole `shipTranscriptTick` call — a resolved response with a nonzero exit code, or an R2 put failure, proves the exec plane is alive and is logged, never counted toward `execFailures`. The adoption write (when the DO has never recorded a token) is folded into the SAME shell command the ship tick already sends, conditionally, rather than a second `deps.exec` call after the fact — Container.alarm awaits every scheduled tick in sequence, so a second hung exec would freeze every later tick behind it.
- **#13 (bring-up resets reachability):** covered by Task 6's `recordBringupObservation`, not here — noted so the two tasks' contracts read as one story.

**PR note (not fixed by this task, call out explicitly in the PR body):** `recycle()` (`do.ts`) holds NO operation lock across its `destroy()` → `sbAwaitReady()` window — that gap predates this feature and is out of this plan's scope; a ship tick landing exactly inside it will see a genuinely bare container and correctly, if briefly, flag it.

**Files:**
- Modify: `apps/fleet/src/studio/transcript.ts` (`shipTickCmd`, `parseShipTickSections`, `ShipResult`, `shipTranscriptTick`, ~213-635)
- Modify: `apps/fleet/src/studio/do.ts` (new exported `incarnationPatch`, `isIncarnationToken` (re-exported from `observed.ts`), `withExecDeadline`, `ExecUnreachableError`, `runShipTickWithObservation`; `shipTranscript()` method)
- Modify: `apps/fleet/src/studio/observed.ts` (add `isIncarnationToken`)
- Test: `apps/fleet/test/studio.transcript.test.ts`, new `apps/fleet/test/studio.observation-tick.test.ts`, new `apps/fleet/test/bun/incarnation-newline.test.ts`

**Interfaces:**
- Consumes: `INCARNATION_PATH`, `writeIncarnationCmd`, `readFileLineCmd`, `Observed`, `ObservedStorage`, `getObserved`, `mergeObserved` (Tasks 1/3); `withObserved`, `StudioStorage`, `OPERATION_KEY`, `OPERATION_STALE_MS`, `STATUS_KEY` (Task 2, `provision.ts`).
- Produces: `ShipResult.incarnationToken: string`; `incarnationPatch(before, containerToken, now): Partial<Observed>` (pure, no longer returns a `needsAdoptionWrite` flag — the adoption write is decided and folded in BEFORE the exec runs, by the caller, from `before.incarnation === null` alone); `isIncarnationToken(value): boolean` (`observed.ts`); `runShipTickWithObservation(deps, storage, id, recordStudioFn?, deadlineMs?)` (`do.ts`) — Task 6 extends this same function's adoption branch with a recorded session verdict (correction #7); Task 8's `readyOverride` reads `observed.unreachableSince`/`observed.replacedAt`, both written here.

### Step 0 — `isIncarnationToken`, `observed.ts`

```ts
// apps/fleet/src/studio/observed.ts — append beside writeIncarnationCmd/readFileLineCmd

/**
 * Maestro correction #3 — every token this feature stores or trusts as "the
 * container's own" is a `crypto.randomUUID()` output. Validated in its
 * canonical shape before EITHER storing it or comparing it against a stored
 * one, so a truncated/garbled read — a race against this task's own atomic
 * write, or genuinely arbitrary content some other process left at this
 * path — is never mistaken for a real replacement or a real match.
 */
export function isIncarnationToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
```

- [ ] **Step 1: Write the failing tests — `shipTickCmd`/`parseShipTickSections`/`shipTranscriptTick` carry the token, newline-safe**

```ts
// apps/fleet/test/studio.transcript.test.ts — add a new describe block
import { INCARNATION_PATH } from "../src/studio/observed";

describe("shipTickCmd / shipTranscriptTick — incarnation section (issue #85)", () => {
  it("shipTickCmd's command reads the incarnation file unconditionally, before the file-exists guard, via a captured-then-echoed read (maestro correction #2)", () => {
    const cmd = shipTickCmd(0, undefined);
    const incarnationIdx = cmd.indexOf(INCARNATION_PATH);
    const guardIdx = cmd.indexOf(`if [ "$FLEET_SIZE" -ge 0 ]`);
    expect(incarnationIdx).toBeGreaterThan(0);
    expect(incarnationIdx).toBeLessThan(guardIdx);
    // Never a bare `cat FILE || echo ''` glued straight into stdout — always
    // captured into a shell variable first.
    expect(cmd).not.toMatch(new RegExp(`cat ${INCARNATION_PATH}[^)]*\\|\\| echo`));
  });

  it("shipTickCmd, given an adoption token, conditionally writes it only when the file is empty, in the SAME command (maestro correction #6)", () => {
    const cmd = shipTickCmd(0, undefined, "adopt-tok-1234");
    expect(cmd).toContain("adopt-tok-1234");
    expect(cmd).toContain("if [ -z \"$FLEET_INC\" ]");
    expect(cmd).toContain("mv");
  });

  it("shipTranscriptTick returns the container's incarnation token, present case", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1",
        "---FLEET-INCARNATION---", "abc-123e4567-e89b-12d3-a456-426614174000",
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("abc-123e4567-e89b-12d3-a456-426614174000");
  });

  it("shipTranscriptTick returns an empty incarnation token when the file is absent", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", "---FLEET-INCARNATION---", ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("");
  });
});
```

```ts
// apps/fleet/test/bun/incarnation-newline.test.ts — new file, real shell (maestro
// correction #2's own explicit ask). Same throwaway-tmpdir convention
// test/bun/inspect-cmd.test.ts already established — no tmux needed here,
// this is plain file I/O.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIncarnationCmd } from "../../src/studio/observed";
import { shipTickCmd } from "../../src/studio/transcript";

describe("incarnation file round-trip through a real shell (issue #85, maestro correction #2)", () => {
  test("a token written with writeIncarnationCmd, read back via shipTickCmd's own read fragment, never glues onto the next section", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-incarnation-"));
    try {
      const incarnationPath = join(dir, "incarnation");
      const writeCmd = writeIncarnationCmd("11111111-2222-3333-4444-555555555555").replaceAll("/workspace/.fleet/incarnation", incarnationPath);
      const write = Bun.spawnSync({ cmd: ["sh", "-c", writeCmd], stdout: "pipe", stderr: "pipe" });
      expect(write.exitCode).toBe(0);

      const tickCmd = shipTickCmd(0, undefined).replaceAll("/workspace/.fleet/incarnation", incarnationPath);
      const read = Bun.spawnSync({ cmd: ["sh", "-c", tickCmd], stdout: "pipe", stderr: "pipe" });
      expect(read.exitCode).toBe(0);
      const stdout = read.stdout.toString();
      const lines = stdout.split("\n");
      const incIdx = lines.indexOf("---FLEET-INCARNATION---");
      expect(incIdx).toBeGreaterThan(-1);
      // The line RIGHT AFTER the marker is the token, ALONE — never glued to
      // the next section's marker.
      expect(lines[incIdx + 1]).toBe("11111111-2222-3333-4444-555555555555");
      expect(lines[incIdx + 2]).not.toContain("---FLEET-CHUNK---".slice(1)); // no gluing
      expect(stdout).toContain("---FLEET-CHUNK---"); // the chunk section still shows up, on its own line
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.transcript.test.ts test/studio.observation-tick.test.ts && bun test test/bun/incarnation-newline.test.ts`
Expected: FAIL — `SECTION_INCARNATION` absent from `shipTickCmd`'s output, `ShipResult.incarnationToken` undefined, `incarnationPatch`/`runShipTickWithObservation` do not exist, `shipTickCmd` does not accept a 3rd argument.

- [ ] **Step 3: `transcript.ts` — add the section (newline-safe read, optional adoption write), thread it through `ShipResult`**

```ts
// apps/fleet/src/studio/transcript.ts
import { INCARNATION_PATH } from "./observed";

// beside SECTION_BOOTID/STAT/CHUNK/TAIL
export const SECTION_INCARNATION = "---FLEET-INCARNATION---";

export interface ShipResult {
  shipped: number;
  rotated: boolean;
  /** Issue #85: the container's `/workspace/.fleet/incarnation` content this
   *  tick, `""` when the file is absent/unreadable. Read UNCONDITIONALLY —
   *  unlike CHUNK/TAIL, this has nothing to do with whether the transcript
   *  log exists, so it is placed before that guard in shipTickCmd and is
   *  always present on every non-throwing return, including "no-file". */
  incarnationToken: string;
  skipped?: string;
}

/**
 * `adoptionToken`, maestro correction #6: when supplied (the caller passes
 * one only when `Observed.incarnation` is `null` — the DO has never
 * recorded a token), this command ALSO conditionally writes it into
 * `INCARNATION_PATH`, in the SAME exec, but only if the file currently
 * reads empty — a container that already holds SOME token (a DO that lost
 * its own storage some other way) is never overwritten. Correction #2: the
 * read is always `FLEET_INC="$(cat FILE 2>/dev/null)"` — captured into a
 * shell variable BEFORE anything is echoed — never a bare `cat FILE ||
 * echo ''` piped straight into this command's own stdout, which is exactly
 * what glued a no-trailing-newline token onto the next section marker.
 */
export function shipTickCmd(
  manifestOffset: number, storedBootId: string | undefined, adoptionToken?: string,
): string {
  const storedBootIdLiteral = shellSingleQuote(storedBootId ?? "");
  const incarnationRead = adoptionToken === undefined
    ? `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; `
    : (
      `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
      `if [ -z "$FLEET_INC" ]; then ` +
      `mkdir -p /workspace/.fleet && printf '%s\\n' ${shellSingleQuote(adoptionToken)} > ${INCARNATION_PATH}.tmp ` +
      `&& mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH} && FLEET_INC=${shellSingleQuote(adoptionToken)}; ` +
      `fi; `
    );
  return (
    `FLEET_FRESH_BOOT_ID=$(cat ${TRANSCRIPT_BOOT_ID_PATH} 2>/dev/null || echo ''); ` +
    `echo '${SECTION_BOOTID}'; echo "$FLEET_FRESH_BOOT_ID"; ` +
    `FLEET_SIZE=$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1); ` +
    `echo '${SECTION_STAT}'; echo "$FLEET_SIZE"; ` +
    incarnationRead +
    `echo '${SECTION_INCARNATION}'; echo "$FLEET_INC"; ` +
    `if [ "$FLEET_SIZE" -ge 0 ]; then ` +
    `FLEET_STORED_BOOT_ID=${storedBootIdLiteral}; ` +
    `if [ -n "$FLEET_FRESH_BOOT_ID" ] && [ -n "$FLEET_STORED_BOOT_ID" ] && [ "$FLEET_FRESH_BOOT_ID" != "$FLEET_STORED_BOOT_ID" ]; then FLEET_EFF=0; else FLEET_EFF=${manifestOffset}; fi; ` +
    `if [ "$FLEET_EFF" -gt "$FLEET_SIZE" ]; then FLEET_EFF=0; fi; ` +
    `echo '${SECTION_CHUNK}'; ` +
    `tail -c +$((FLEET_EFF+1)) ${TRANSCRIPT_LOG_PATH} | head -c ${TRANSCRIPT_PULL_MAX} | base64; ` +
    `echo '${SECTION_TAIL}'; ` +
    `tail -c ${HOT_TAIL_BYTES} ${TRANSCRIPT_LOG_PATH} | base64; ` +
    `fi`
  );
}

function parseShipTickSections(
  stdout: string,
): { freshBootId: string; size: number; incarnationToken: string; chunkB64: string | undefined; tailB64: string | undefined } {
  const lines = stdout.split("\n");
  const bootIdx = lines.indexOf(SECTION_BOOTID);
  const statIdx = lines.indexOf(SECTION_STAT);
  const incIdx = lines.indexOf(SECTION_INCARNATION);
  const chunkIdx = lines.indexOf(SECTION_CHUNK);
  const tailIdx = lines.indexOf(SECTION_TAIL);

  const slice = (start: number, end: number): string | undefined =>
    start === -1 ? undefined : lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");

  const freshBootId = (slice(bootIdx, statIdx) ?? "").trim();
  const sizeText = (slice(statIdx, incIdx) ?? "").trim();
  const size = Number.parseInt(sizeText, 10);
  const incarnationToken = (slice(incIdx, chunkIdx) ?? "").trim();
  const chunkB64 = slice(chunkIdx, tailIdx);
  const tailB64 = slice(tailIdx, lines.length);

  return { freshBootId, size, incarnationToken, chunkB64, tailB64 };
}

// shipTranscriptTick — thread adoptionToken in, incarnationToken out, through every non-throwing return
export async function shipTranscriptTick(
  deps: ShipDeps, storage: TranscriptStorage, id: string, adoptionToken?: string,
): Promise<ShipResult> {
  // ...unchanged through the manifest/storedBootId reads...
  const tickRes = await deps.exec(shipTickCmd(manifest.offset, storedBootId, adoptionToken));
  // ...unchanged through the tickRes.code check...
  const { freshBootId, size, incarnationToken, chunkB64, tailB64 } = parseShipTickSections(tickRes.stdout);
  if (!Number.isFinite(size) || size < 0) {
    return { shipped: 0, rotated: false, incarnationToken, skipped: "no-file" };
  }
  // ...unchanged body...
  return { shipped, rotated, incarnationToken };
}
```

(The `...unchanged...` regions are the existing body between these lines, untouched — see the file as currently written.)

- [ ] **Step 4: `do.ts` — `incarnationPatch`, `withExecDeadline`/`ExecUnreachableError`, `runShipTickWithObservation`, wired into `shipTranscript()`**

```ts
// apps/fleet/src/studio/do.ts
import {
  getObserved, mergeObserved, isIncarnationToken, type Observed, type ObservedStorage,
} from "./observed";
import { STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, type StudioStorage } from "./provision";
import { INSPECT_EXEC_MS } from "./inspect"; // add to the existing import if inspect.ts is already imported here

/**
 * Issue #85 — pure decision table for one ship tick's incarnation section.
 * Maestro correction #3 fix, replacing the original (buggy, self-clearing)
 * version: NEVER nulls `before.incarnation` on a missing or foreign
 * reading — it is kept exactly as it was until an EQUAL token is seen
 * again, or a bring-up (Task 6) explicitly overwrites it. `replacedAt` is
 * stamped ONCE and never re-stamped while still set, so its age (rendered
 * by Task 8's `readyOverride`) always reflects the FIRST tick that noticed,
 * never the most recent one. No `needsAdoptionWrite` flag — the adoption
 * write is decided by the CALLER, before the exec runs, from
 * `before.incarnation === null` alone (maestro correction #6: folded into
 * the SAME exec, see `shipTickCmd`'s `adoptionToken` parameter), so by the
 * time this function runs `containerToken` already reflects the outcome of
 * that write attempt.
 */
export function incarnationPatch(before: Observed, containerToken: string, now: string): Partial<Observed> {
  const token = containerToken !== "" && isIncarnationToken(containerToken) ? containerToken : "";
  if (before.incarnation === null) {
    // Adoption territory. `token === ""` here means only that the SAME
    // exec's own conditional write attempt failed (or read back garbage) —
    // nothing to patch, retried next tick.
    return token === "" ? {} : { incarnation: token, replacedAt: null };
  }
  if (token === before.incarnation) {
    // The ONLY clearing path besides an explicit bring-up write.
    return before.replacedAt !== null ? { replacedAt: null } : {};
  }
  // Missing OR foreign: the DO's own token is KEPT. Stamp replacedAt once.
  return before.replacedAt !== null ? {} : { replacedAt: now };
}

/** Distinguishes a genuine "the container did not answer" from every other
 *  failure shape — maestro correction #5. */
export class ExecUnreachableError extends Error {}

/**
 * Maestro correction #5/#6 — wraps ONLY the exec call itself (both the main
 * tick exec and transcript.ts's own rotate exec go through this SAME
 * `deps.exec`, so both get the deadline individually) rather than the whole
 * `shipTranscriptTick` call. A RESOLVED response — even a nonzero exit code
 * — proves the exec plane answered and is never wrapped here; only a
 * genuine timeout, or `exec()`'s own promise rejecting before producing any
 * response at all (a transport failure), counts. `ms` is a parameter, not
 * a hardcoded constant — maestro correction #14: production always passes
 * `INSPECT_EXEC_MS` (15s, reused verbatim from #92); tests inject a small
 * value so 3 consecutive "timeouts" do not cost 45s against vitest's
 * default 20s per-test budget.
 */
function withExecDeadline(exec: ShipDeps["exec"], ms: number): ShipDeps["exec"] {
  return async (cmd: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exec(cmd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ExecUnreachableError(`exec did not answer within ${ms / 1000}s`)), ms);
        }),
      ]);
    } catch (err) {
      if (err instanceof ExecUnreachableError) throw err;
      throw new ExecUnreachableError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Issue #85 — one exported, directly testable function, called from
 * `StudioDO.shipTranscript()` the same way `mirrorBurnToRegistry` is called
 * from `syncSessionCycle`. `recordStudioFn`, when supplied, is used for an
 * IMMEDIATE, out-of-cadence D1 write on a `replaced`/`unreachable`
 * transition or an adoption (maestro correction #1) — the steady state
 * still rides the existing 300s burn-mirror cadence for zero added writes.
 * `deadlineMs` defaults to `INSPECT_EXEC_MS`; do.ts's real wiring never
 * overrides it, only tests do (maestro correction #14).
 */
export async function runShipTickWithObservation(
  deps: ShipDeps,
  storage: TranscriptStorage & ObservedStorage & StudioStorage,
  id: string,
  recordStudioFn?: (status: StudioStatus) => Promise<void>,
  deadlineMs: number = INSPECT_EXEC_MS,
): Promise<ShipResult> {
  const observedBefore = await getObserved(storage);
  const adoptionToken = observedBefore.incarnation === null ? crypto.randomUUID() : undefined;
  const shipDeps: ShipDeps = { ...deps, exec: withExecDeadline(deps.exec, deadlineMs) };

  let result: ShipResult;
  try {
    result = await shipTranscriptTick(shipDeps, storage, id, adoptionToken);
  } catch (err) {
    if (err instanceof ExecUnreachableError) {
      const failures = observedBefore.execFailures + 1;
      const patch: Partial<Observed> = { execFailures: failures };
      let becameUnreachable = false;
      if (failures >= 3 && observedBefore.unreachableSince === null) {
        patch.unreachableSince = deps.now().toISOString();
        becameUnreachable = true;
      }
      await mergeObserved(storage, patch);
      if (becameUnreachable && recordStudioFn) {
        const status = await storage.get(STATUS_KEY);
        if (status) await recordStudioFn(await withObserved(storage, status));
      }
    } else {
      // Maestro correction #5 — a resolved-but-bad response (nonzero exit,
      // a parse failure, an R2 put failure, a rotate failure) proves the
      // exec plane itself is alive; log it, never count it toward
      // reachability (an R2 blip must not show fleet-wide `unreachable`).
      console.error(`shipTranscript ${id}: tick failed (not counted toward reachability)`, err);
    }
    throw err;
  }

  const now = deps.now().toISOString();

  // Maestro correction #4 — re-read AFTER the exec: a concurrent bring-up
  // (Task 6) can finish and write a NEWER truth while this tick's exec was
  // still in flight, and D1's own STATUS_KEY read during an operation is
  // separately, measurably stale (provision.ts's own OPERATION_KEY doc
  // comment) — a fresh operation lock means bring-up simply has not
  // finished writing its own token yet, which is not a real replacement.
  const operation = await storage.get(OPERATION_KEY);
  const opFresh = operation != null
    && Number.isFinite(Date.parse(operation.since))
    && deps.now().getTime() - Date.parse(operation.since) < OPERATION_STALE_MS;
  const observedNow = await getObserved(storage);
  const incarnationChangedMidTick = observedNow.incarnation !== observedBefore.incarnation;
  const reachabilityPatch: Partial<Observed> =
    observedBefore.execFailures > 0 || observedBefore.unreachableSince !== null
      ? { execFailures: 0, unreachableSince: null }
      : {};

  if (opFresh || incarnationChangedMidTick) {
    // Skip replaced/unreachable/adoption entirely this tick — the exec
    // succeeded, so the container plainly answered; still safe (and
    // correct) to reset reachability, just never touch incarnation/replaced.
    if (Object.keys(reachabilityPatch).length > 0) await mergeObserved(storage, reachabilityPatch);
    return result;
  }

  const incPatch = incarnationPatch(observedNow, result.incarnationToken, now);
  const combined = { ...reachabilityPatch, ...incPatch };
  if (Object.keys(combined).length > 0) await mergeObserved(storage, combined);

  // Maestro correction #1 — the other two immediate-D1-write transitions:
  // a replaced set/clear, or an adoption.
  const isTransition = "replacedAt" in incPatch || (observedNow.incarnation === null && "incarnation" in incPatch);
  if (isTransition && recordStudioFn) {
    const status = await storage.get(STATUS_KEY);
    if (status) await recordStudioFn(await withObserved(storage, status));
  }

  return result;
}
```

```ts
// apps/fleet/src/studio/do.ts — shipTranscript() method: call the new wrapper
async shipTranscript(): Promise<void> {
  await runScheduledTick(
    this.ctx.storage,
    async () => {
      try {
        await runShipTickWithObservation(
          this.shipDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s), // already wrapped via withObserved per Task 2 — kept here anyway for the explicit-transition-write path's own D1 body
        );
      } catch (err) {
        console.error("studio transcript ship failed", err);
      }
    },
    () => this.rearm("shipTranscript", SHIP_TRANSCRIPT_SECONDS),
  );
}
```

- [ ] **Step 5: Write the additional decision-table + op-lock + D1-transition tests**

```ts
// apps/fleet/test/studio.observation-tick.test.ts — new file
import { describe, it, expect, vi } from "vitest";
import { incarnationPatch, runShipTickWithObservation, ExecUnreachableError } from "../src/studio/do";
import { emptyObserved, getObserved, OBSERVED_KEY, type Observed, type ObservedStorage } from "../src/studio/observed";
import { STATUS_KEY, OPERATION_KEY } from "../src/studio/provision";
import { TRANSCRIPT_MANIFEST_KEY, TRANSCRIPT_TAIL_KEY, TRANSCRIPT_BOOT_ID_KEY, type TranscriptStorage } from "../src/studio/transcript";

const TOK_1 = "11111111-2222-3333-4444-555555555555";
const TOK_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function fakeStorage(seed?: { observed?: Observed; status?: StudioStatus; operation?: { op: string; since: string } | null }) {
  const map = new Map<string, unknown>();
  if (seed?.observed) map.set(OBSERVED_KEY, seed.observed);
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.operation !== undefined) map.set(OPERATION_KEY, seed.operation);
  return {
    get: (async (key: string) => map.get(key)) as any,
    put: (async (key: string, value: unknown) => {
      if (typeof key === "object") { for (const [k, v] of Object.entries(key)) map.set(k, v); return; }
      map.set(key, value);
    }) as any,
  } as TranscriptStorage & ObservedStorage & any;
}

describe("incarnationPatch — pure decision table (issue #85, maestro correction #3 rewrite)", () => {
  const NOW = "2026-09-24T10:00:00.000Z";

  it("missing token, DO has a stored incarnation: sets replacedAt once, KEEPS the token", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, "", NOW)).toEqual({ replacedAt: NOW });
  });

  it("missing token, replacedAt already set: does not reset the age, still keeps the token", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1, replacedAt: "2026-09-24T09:59:00.000Z" };
    expect(incarnationPatch(before, "", NOW)).toEqual({});
  });

  it("multi-tick sequence: replaced stays replaced across 3 more missing ticks, never self-clears (maestro correction #3)", () => {
    let observed: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    for (let i = 0; i < 4; i++) {
      const patch = incarnationPatch(observed, "", NOW);
      observed = { ...observed, ...patch };
    }
    expect(observed.incarnation).toBe(TOK_1);
    expect(observed.replacedAt).toBe(NOW);
  });

  it("adoption: DO has no stored incarnation, container reports none (the folded-in write itself failed this tick)", () => {
    const before: Observed = { ...emptyObserved(), incarnation: null };
    expect(incarnationPatch(before, "", NOW)).toEqual({});
  });

  it("adoption: DO has no stored incarnation, container now reports one (the folded-in write succeeded, or a foreign token was already there)", () => {
    const before: Observed = { ...emptyObserved(), incarnation: null };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({ incarnation: TOK_1, replacedAt: null });
  });

  it("matching tokens: clears a stale replacedAt", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1, replacedAt: "2026-09-24T09:00:00.000Z" };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({ replacedAt: null });
  });

  it("matching tokens, no prior replacedAt: no-op patch", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({});
  });

  it("foreign token: sets replacedAt once, KEEPS the DO's own token — never adopts the foreign one, never self-clears next tick (maestro correction #3)", () => {
    let observed: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    const tick1 = incarnationPatch(observed, TOK_2, NOW);
    expect(tick1).toEqual({ replacedAt: NOW });
    observed = { ...observed, ...tick1 };
    const tick2 = incarnationPatch(observed, TOK_2, "2026-09-24T10:00:30.000Z");
    expect(tick2).toEqual({}); // still foreign, still no-op — incarnation never became TOK_2
    expect(observed.incarnation).toBe(TOK_1);
  });

  it("garbage (non-UUID-shaped) container content is treated as no token, never stored or compared", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, "not-a-real-token", NOW)).toEqual({ replacedAt: NOW });
  });
});

describe("runShipTickWithObservation — adoption folded into one exec (issue #85, maestro correction #6)", () => {
  it("adoption writes a token via the SAME exec as the tick itself — never a second exec", async () => {
    let execCount = 0;
    const deps = {
      exec: vi.fn(async (cmd: string) => {
        execCount += 1;
        return {
          code: 0,
          stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
          stderr: "",
        };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage();

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    expect(execCount).toBe(1);
    const observed = await getObserved(storage);
    expect(observed.incarnation).not.toBeNull();
    expect(observed.replacedAt).toBeNull();
  });
});

describe("runShipTickWithObservation — op-lock guard (issue #85, maestro correction #4)", () => {
  it("T10: a fresh operation lock suppresses a replaced/adoption verdict even though the container reports no token (the REAL op-lock proof — see Task 8's own T10 note)", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      operation: { op: "provision", since: "2026-09-24T09:59:30.000Z" }, // 30s ago, well inside OPERATION_STALE_MS
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.replacedAt).toBeNull();
    expect(observed.incarnation).toBe(TOK_1); // untouched
  });

  it("a stale operation lock (older than OPERATION_STALE_MS) does NOT suppress the verdict", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:30:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      operation: { op: "provision", since: "2026-09-24T09:00:00.000Z" }, // 90 minutes ago — stale
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.replacedAt).not.toBeNull();
  });
});

describe("runShipTickWithObservation — immediate D1 write on a transition (issue #85, maestro correction #1)", () => {
  it("a replaced transition calls recordStudioFn with the status carrying the new observed", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot" }),
    });
    const recordStudioFn = vi.fn(async () => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.replacedAt).not.toBeNull();
  });

  it("a steady-state successful tick (no transition) never calls recordStudioFn — rides the 300s mirror instead", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot" }),
    });
    const recordStudioFn = vi.fn(async () => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/fleet && bunx vitest run test/studio.transcript.test.ts test/studio.observation-tick.test.ts && bun test test/bun/incarnation-newline.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 7: Run the full transcript suite to confirm the new unconditional section did not break any existing fixture's line-position assumptions**

Run: `cd apps/fleet && bunx vitest run test/studio.transcript.test.ts`
Expected: PASS — every existing fixture builds its own `stdout` string with the FIXED section markers; any fixture that predates `SECTION_INCARNATION` and does not include it will parse `incarnationToken` as `""` (an absent marker), which is a safe, non-crashing default per `parseShipTickSections`'s existing "missing marker -> undefined/empty" convention. Confirm no existing test asserts on stdout content that would now collide with the new line.

- [ ] **Step 8: Commit**

```bash
git add apps/fleet/src/studio/transcript.ts apps/fleet/src/studio/do.ts apps/fleet/src/studio/observed.ts apps/fleet/test/studio.transcript.test.ts apps/fleet/test/studio.observation-tick.test.ts apps/fleet/test/bun/incarnation-newline.test.ts
git commit -m "feat(studio): ship tick detects replaced/adopted/cleared incarnation, deadlined, op-lock-safe (#85)"
```

---

## Task 5: Reachability — folded into Task 4 (no new production code)

**REVISED — see maestro corrections #4, #5, #6.** `runShipTickWithObservation`'s reachability tracking (`execFailures`/`unreachableSince`, the exec-level deadline via `withExecDeadline`) is now part of Task 4's single rewritten function — it could not be cleanly layered on afterward once the deadline moved from wrapping the whole tick to wrapping only `ShipDeps.exec`, and once the op-lock re-read needed to sit inside the SAME try/catch. This task now exists only to hold the reachability-specific test coverage maestro correction #14 calls out by name (the injectable `deadlineMs` — without it, 3 consecutive "timeouts" at the real 15s `INSPECT_EXEC_MS` would cost 45s, over vitest's default 20s per-test budget) as its own clearly-labeled block, and to confirm it is green. No new `Files:` to modify.

**Files:**
- Test only: `apps/fleet/test/studio.observation-tick.test.ts` (the `fakeStorage` helper and `incarnationPatch`/adoption/op-lock/D1-transition tests are already in place from Task 4 — this task only adds the reachability-specific cases below)

**Interfaces:** None new — exercises Task 4's `runShipTickWithObservation`/`ExecUnreachableError` directly.

- [ ] **Step 1: Write the failing tests, using the injectable `deadlineMs` (maestro correction #14)**

```ts
// apps/fleet/test/studio.observation-tick.test.ts — extend the file Task 4 created
describe("runShipTickWithObservation — reachability (issue #85)", () => {
  const SHORT_DEADLINE_MS = 50; // maestro correction #14 — never the real 15s in a test

  function hangingDeps(): { exec: ReturnType<typeof vi.fn>; r2Put: ReturnType<typeof vi.fn>; now: () => Date } {
    return {
      exec: vi.fn(() => new Promise(() => {})), // never resolves — the deadline must fire
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
  }

  it("3 consecutive timeouts sets unreachableSince", async () => {
    const deps = hangingDeps();
    const storage = fakeStorage();
    for (let i = 0; i < 3; i++) {
      await expect(
        runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
      ).rejects.toThrow(ExecUnreachableError);
    }
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(3);
    expect(observed.unreachableSince).toBe("2026-09-24T10:00:00.000Z");
  });

  it("a 4th consecutive timeout does not move unreachableSince forward", async () => {
    const storage = fakeStorage({
      observed: { ...emptyObserved(), execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z" },
    });
    const deps = { ...hangingDeps(), now: () => new Date("2026-09-24T10:05:00.000Z") };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(4);
    expect(observed.unreachableSince).toBe("2026-09-24T09:58:00.000Z");
  });

  it("a nonzero-exit response (exec plane alive, command failed) does NOT count toward execFailures (maestro correction #5)", async () => {
    const storage = fakeStorage();
    const deps = {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "container-side error" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.not.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });

  it("a success after failures resets both fields to zero/null", async () => {
    const storage = fakeStorage({
      observed: { ...emptyObserved(), execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z", incarnation: TOK_1 },
    });
    const okDeps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:06:00.000Z"),
    };
    await runShipTickWithObservation(okDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify pass** (this is a same-commit-cycle continuation of Task 4's own implementation, so these should already be green; run anyway to confirm)

Run: `cd apps/fleet && bunx vitest run test/studio.observation-tick.test.ts`
Expected: PASS, in well under 1s per test (the 50ms injected deadline, not 15s).

- [ ] **Step 3: Full suite, commit**

Run: `cd apps/fleet && bunx vitest run && bun run check`
Expected: PASS.

```bash
git add apps/fleet/test/studio.observation-tick.test.ts
git commit -m "test(studio): reachability coverage for the #92-deadlined ship tick, injectable deadline (#85)"
```

---

## Task 6: Session verdict — read the live lead process, record resumed/fresh/lost/unknown

**REVISED — see maestro corrections #6, #7, #8, #9, #10, #13.** Five changes from the original draft:
- **#10:** `runProvision`/`runRestart` KEEP their existing, real, unwidened return types (`Promise<{status, roleEnv, keepAlive}>` and `Promise<StudioStatus>` respectively — confirmed against the current file, `provision.ts` ~1511 and ~1676). Issue #90 (currently blocked, but ALSO touches these two functions) would conflict with widening them. The restore outcome is instead captured through a new optional `ProvisionDeps.onRestoreOutcome?(outcome)` callback, invoked once inside each function's existing restore try/catch — `provisionWithStorage`/`restartWithStorage` supply a closure that just assigns a local variable, so the wrapper still learns the outcome without either inner function's signature changing at all. `runSessionRestore`'s OWN return widening (unaffected by #90) is unchanged from the original draft.
- **#9:** `paneLeadProbeCmd`/`parsePaneLeadProbe`/`PaneProbeResult` are redesigned. The container's raw argv is NEVER returned to the Worker (it can carry an `--append-system-prompt` payload up to 8KB) — the shell command itself decides yes/no on `--continue` via a per-argv-element exact match (`tr '\0' '\n' | grep -qxF -- --continue`, which cannot be fooled by a flag that merely CONTAINS the substring `--continue`), and returns that boolean plus the resolved cwd. The tmux target is verified the SAME way `inspect.ts`'s `inspectCmd` already does (`#{session_name}:#{window_name}` echoed and pattern-matched, not trusted from `-t`'s own targeting — a missing window can otherwise answer with a DIFFERENT pane and exit 0, measured) rather than trusting `tmux display -p -t studio:claude` to fail cleanly when the window does not exist. The lead process is found via `pgrep -x claude -P "$PANE_PID"` (name-exact, not just "first child"). No lead pid found is its own outcome (`found: false`), never folded into `fresh`/`lost`.
- **#8:** `lastSnapshotAt` is read by the WRAPPER (`provisionWithStorage`/`restartWithStorage`) BEFORE calling `runProvision`/`runRestart`, not re-read afterward inside `recordBringupObservation` — the independent 300s sync tick can complete WHILE a multi-minute bring-up is still running and overwrite it with a freshness that does not describe what the restore actually used. An optional `ProvisionDeps.r2Head?(key)` port is added as a fallback (R2's own `uploaded` timestamp) for the case where `lastSnapshotAt` was never recorded yet but a restore genuinely happened. `snapshotAgeS` is computed ONLY when `restoreOutcome === "restored"` — never for `fresh`/`skip:*` verdicts, which previously computed a misleading nonzero age from whatever snapshot happened to exist without ever having used it.
- **#13:** `recordBringupObservation`'s patch now also resets `execFailures: 0, unreachableSince: null` — a successful bring-up proves the exec plane is alive, the same reasoning a successful ship tick already resets reachability on.
- **#6 (second half):** the incarnation token write and the pane-lead probe are folded into ONE `deps.sbExec` call (`bringupObservationCmd`), not two sequential ones — a hang in the first would otherwise silently skip the second.
- **#7 (new — depends on this task's own `computeSessionVerdict`/pane-probe machinery, so it lands here rather than in Task 4):** this task's final step extends Task 4's ship-tick adoption branch (`do.ts`'s `runShipTickWithObservation`) to fold the SAME pane probe into the ship tick's own exec on an adoption, and record a session verdict with `via: "adopted"` — `--continue` + a matching cwd reads `resumed`; anything else reads `unknown`, reason `"adopted: launch history unknown"` — NEVER `lost` (adoption genuinely does not know the launch history, and lifetime `burn.turns` already includes whatever the running session has done, so guessing "lost" would be actively wrong more often than it would be right).

**Files:**
- Modify: `apps/fleet/src/studio/observed.ts` (`PaneProbeResult`, `paneLeadProbeCmd`, `parsePaneLeadProbe`, `computeSessionVerdict`, `computeAdoptedVerdict`, `bringupObservationCmd`, `parseBringupObservation`)
- Modify: `apps/fleet/src/studio/session-sync.ts` (`RestoreAction` stays; nothing here changes — restore OUTCOME derivation stays in provision.ts, see below)
- Modify: `apps/fleet/src/studio/provision.ts` (`ProvisionDeps` gains `onRestoreOutcome?`/`r2Head?`; `runSessionRestore`'s return type widens; `runProvision`/`runRestart`'s existing return types are UNCHANGED — one line added inside each's existing restore try/catch; `provisionWithStorage`/`restartWithStorage`'s post-success block)
- Modify: `apps/fleet/src/studio/failover.ts` (`runAccountFailover`'s post-success block)
- Modify: `apps/fleet/src/studio/transcript.ts` (`shipTickCmd`/`ShipResult` gain the adoption-probe fold-in), `apps/fleet/src/studio/do.ts` (`runShipTickWithObservation`'s adoption branch)
- Test: `apps/fleet/test/studio.observed.test.ts`, `apps/fleet/test/studio.session.test.ts`, `apps/fleet/test/studio.replacement.test.ts`, `apps/fleet/test/studio.account-failover.test.ts`, `apps/fleet/test/studio.observation-tick.test.ts`, new `apps/fleet/test/bun/pane-probe-lead.test.ts`

**Interfaces:**
- Consumes: `RestoreOutcome`, `Observed`, `ObservedStorage`, `BringupVia`, `getObserved`, `mergeObserved`, `writeIncarnationCmd`'s shell-quoting helper, `INCARNATION_PATH` (Task 1/3); `incarnationPatch`, `withObserved`, `STATUS_KEY`, `OPERATION_KEY` (Task 2/4).
- Produces: `PaneProbeResult { ok, found, hasContinue, cwd, error }`, `paneLeadProbeCmd()`, `parsePaneLeadProbe(stdout)`, `computeSessionVerdict(probe, expectedCwd, restore, turnsBefore, snapshotAgeS, at, via)`, `computeAdoptedVerdict(probe, expectedCwd, turnsBefore, at)`, `bringupObservationCmd(token)`, `parseBringupObservation(stdout)` (`observed.ts`); `ProvisionDeps.onRestoreOutcome?`/`.r2Head?` (`provision.ts`).

### Step 0 — `runSessionRestore`'s widened return breaks 4 existing assertions; fix them in this task

`test/studio.session.test.ts` has four `expect(result).toEqual({ plan: ..., parts: ... })`-style assertions (lines ~872, ~886, ~903, ~933, ~978 per the current file) that check the WHOLE returned object. Adding a field to `runSessionRestore`'s return type will fail every one of them until updated — this is expected, in-scope work for this task, not an accidental break. `runProvision`/`runRestart` are NOT touched by this — see maestro correction #10, their return types stay exactly as they are today.

- [ ] **Step 1: Write/update the failing tests**

```ts
// apps/fleet/test/studio.session.test.ts — update these 5 existing assertions in place

// "container already has ~/.claude/projects: skips WITHOUT ever calling r2Get or writeFile"
expect(result).toEqual({ plan: "skip", parts: 0, restore: "skip:has-projects" });

// "fresh container but no R2 latest object: skips, no writeFile"
expect(result).toEqual({ plan: "skip", parts: 0, restore: "skip:no-snapshot" });

// "fresh container AND R2 latest exists: chunks the tar..." (big tar, 2 parts)
expect(result).toEqual({ plan: "restore", parts: 2, restore: "restored" });

// "a single-part restore (tar <= SESSION_SINGLE_READ_MAX)..."
expect(result).toEqual({ plan: "restore", parts: 1, restore: "restored" });

// "capability absent (no r2Get/writeFile wired) skips silently..."
expect(result).toEqual({ plan: "skip", parts: 0, restore: "not-attempted" });
```

```ts
// apps/fleet/test/studio.observed.test.ts — new describe block, pure verdict logic
import {
  computeSessionVerdict, computeAdoptedVerdict, parsePaneLeadProbe, paneLeadProbeCmd,
  bringupObservationCmd, parseBringupObservation,
  SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION, BRINGUP_TOKEN_WRITE_SECTION,
  type PaneProbeResult,
} from "../src/studio/observed";

describe("computeSessionVerdict — issue #85 spec table (maestro correction #9 rewrite)", () => {
  const AT = "2026-09-24T10:00:00.000Z";
  const CWD = "/workspace/acme-os";
  const okProbe = (hasContinue: boolean, cwd: string | null): PaneProbeResult => ({ ok: true, found: true, hasContinue, cwd, error: null });

  it("resumed: --continue found, cwd matches", () => {
    const v = computeSessionVerdict(okProbe(true, CWD), CWD, "restored", 5, 60, AT, "restart");
    expect(v.verdict).toBe("resumed");
    expect(v.reason).toBeNull();
  });

  // T5: fresh launch, turnsBefore 412 -> LOST, had 412 turns
  it("T5: no --continue, cwd correct, turnsBefore 412 -> lost, reason no --continue", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:has-projects", 412, null, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.turnsBefore).toBe(412);
    expect(v.reason).toBe("no --continue");
  });

  // T6: fresh launch, no history -> fresh
  it("T6: no --continue, no prior history, no restored snapshot -> fresh", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:no-snapshot", 0, null, AT, "provision");
    expect(v.verdict).toBe("fresh");
    expect(v.reason).toBeNull();
  });

  // T7: lead cwd /container-server after clone refusal -> LOST, reason names the cwd
  it("T7: cwd is /container-server (clone refusal), history exists -> lost, reason names the cwd", () => {
    const v = computeSessionVerdict(okProbe(true, "/container-server"), CWD, "skip:no-snapshot", 9, null, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.reason).toBe("cwd /container-server");
  });

  it("unknown: the pane probe itself failed", () => {
    const failedProbe: PaneProbeResult = { ok: false, found: false, hasContinue: false, cwd: null, error: "exec timed out" };
    const v = computeSessionVerdict(failedProbe, CWD, "not-attempted", 0, null, AT, "heal");
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("exec timed out");
  });

  it("unknown: the probe succeeded but found no lead pid — never folded into fresh/lost (maestro correction #9)", () => {
    const notFound: PaneProbeResult = { ok: true, found: false, hasContinue: false, cwd: null, error: null };
    const v = computeSessionVerdict(notFound, CWD, "not-attempted", 5, null, AT, "restart");
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("no lead process found");
  });

  it("snapshotAgeS is passed through unchanged — the caller (provision.ts) is what gates it on restore===\"restored\", not this function", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:no-snapshot", 0, null, AT, "provision");
    expect(v.snapshotAgeS).toBeNull();
  });
});

describe("computeAdoptedVerdict — issue #85, maestro correction #7", () => {
  const AT = "2026-09-24T10:00:00.000Z";
  const CWD = "/workspace/acme-os";

  it("resumed: --continue found, cwd matches", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: true, cwd: CWD, error: null }, CWD, 40, AT);
    expect(v).toEqual({ verdict: "resumed", at: AT, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore: 40, reason: null });
  });

  it("unknown, never lost: no --continue", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: false, cwd: CWD, error: null }, CWD, 900, AT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("adopted: launch history unknown");
  });

  it("unknown, never lost: cwd mismatch", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: true, cwd: "/container-server", error: null }, CWD, 900, AT);
    expect(v.verdict).toBe("unknown");
  });

  it("unknown: the probe itself failed, carries the probe's own error", () => {
    const v = computeAdoptedVerdict({ ok: false, found: false, hasContinue: false, cwd: null, error: "exec timed out" }, CWD, 0, AT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("exec timed out");
  });
});

describe("parsePaneLeadProbe (issue #85, maestro correction #9)", () => {
  it("parses found/hasContinue/cwd from the three sections", () => {
    const stdout = [SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os"].join("\n");
    expect(parsePaneLeadProbe(stdout)).toEqual({ ok: true, found: true, hasContinue: true, cwd: "/workspace/acme-os", error: null });
  });

  it("no lead process found: found false, hasContinue false, cwd null", () => {
    const stdout = [SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, ""].join("\n");
    expect(parsePaneLeadProbe(stdout)).toEqual({ ok: true, found: false, hasContinue: false, cwd: null, error: null });
  });
});

describe("paneLeadProbeCmd (issue #85, maestro correction #9)", () => {
  it("verifies the tmux target's own session:window before trusting its pane_pid, uses pgrep -x claude, checks --continue per-argv-element, and never returns raw argv", () => {
    const cmd = paneLeadProbeCmd();
    expect(cmd).toContain("tmux display -p -t studio:claude '#{session_name}:#{window_name} #{pane_pid}'");
    expect(cmd).toContain("studio:claude \"*)"); // the exact-match case guard, not trusted from -t alone
    expect(cmd).toContain("pgrep -x claude -P");
    expect(cmd).toContain("tr '\\0' '\\n'");
    expect(cmd).toContain("grep -qxF -- --continue");
    expect(cmd).toContain("/cwd");
    expect(cmd).not.toContain("/cmdline 2>/dev/null;\n"); // never echoes raw cmdline to stdout
    expect(cmd).not.toContain("attach");
    expect(cmd).not.toContain("send-keys");
  });
});

describe("bringupObservationCmd / parseBringupObservation (issue #85, maestro correction #6 — one exec for token write + probe)", () => {
  it("writes the token, reports success, then folds the SAME pane probe into the one command", () => {
    const cmd = bringupObservationCmd("11111111-2222-3333-4444-555555555555");
    expect(cmd).toContain("11111111-2222-3333-4444-555555555555");
    expect(cmd).toContain(BRINGUP_TOKEN_WRITE_SECTION);
    expect(cmd).toContain(SESSION_FOUND_SECTION); // the probe fragment is present in the SAME string
  });

  it("parses tokenWritten + the probe from one combined stdout", () => {
    const stdout = [
      BRINGUP_TOKEN_WRITE_SECTION, "yes",
      SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os",
    ].join("\n");
    expect(parseBringupObservation(stdout)).toEqual({
      tokenWritten: true,
      probe: { ok: true, found: true, hasContinue: true, cwd: "/workspace/acme-os", error: null },
    });
  });

  it("a failed token write still parses the probe half", () => {
    const stdout = [BRINGUP_TOKEN_WRITE_SECTION, "no", SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, ""].join("\n");
    expect(parseBringupObservation(stdout).tokenWritten).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.session.test.ts test/studio.observed.test.ts`
Expected: FAIL — `runSessionRestore`'s return has no `restore` field; `computeSessionVerdict`/`computeAdoptedVerdict`/`parsePaneLeadProbe`/`paneLeadProbeCmd`/`bringupObservationCmd`/`parseBringupObservation` do not exist.

- [ ] **Step 3: `observed.ts` — pane probe + pure verdict functions, redesigned per maestro correction #9**

```ts
// apps/fleet/src/studio/observed.ts — append

export const SESSION_FOUND_SECTION = "---FLEET-SESSION-FOUND---";
export const SESSION_CONTINUE_SECTION = "---FLEET-SESSION-CONTINUE---";
export const SESSION_CWD_SECTION = "---FLEET-SESSION-CWD---";

/** Matches inspect.ts's own INSPECT_TARGET value ("studio:claude"). A
 *  private, per-file copy rather than an import — inspect.ts (Task 9)
 *  imports FROM this file (INCARNATION_PATH), so importing back would be
 *  circular; the same "own copy of a small shared value when importing
 *  would cycle" reasoning shellQuote's own doc comment already gives. */
const LEAD_PANE_TARGET = "studio:claude";

/**
 * Issue #85, signal 3, maestro correction #9 — ONE exec: verify
 * `#{session_name}:#{window_name}` is ACTUALLY `studio:claude` before
 * trusting anything read from it (a missing window can otherwise answer
 * `tmux display -p -t studio:claude` with a DIFFERENT pane and exit 0 —
 * measured, not theorised, the exact bug `inspect.ts`'s own `inspectCmd`
 * already guards against with the identical case-match pattern). Then the
 * pane_pid's DIRECT child NAMED `claude` (`pgrep -x claude -P` — a member
 * `claude -p` subprocess sits at least one level deeper under the LEAD, and
 * `-x` rules out a wrapper/shell process with a similar name). Reports
 * yes/no on `--continue` via a PER-ARGV-ELEMENT exact match
 * (`tr '\0' '\n' | grep -qxF -- --continue`) rather than returning the raw
 * argv to the Worker — the argv can carry an `--append-system-prompt`
 * payload up to 8KB, and a naive substring check on the whole line could
 * false-positive on an unrelated flag that merely CONTAINS the text
 * `--continue`. Never `exit` (same HARD RULE every command in this feature
 * follows — see writeIncarnationCmd's own doc comment).
 */
export function paneLeadProbeCmd(): string {
  return (
    `FLEET_PANE="$(tmux display -p -t ${LEAD_PANE_TARGET} '#{session_name}:#{window_name} #{pane_pid}' 2>/dev/null)"; ` +
    `case "$FLEET_PANE" in ` +
    `"${LEAD_PANE_TARGET} "*) FLEET_PANE_PID="\${FLEET_PANE#${LEAD_PANE_TARGET} }" ;; ` +
    `*) FLEET_PANE_PID="" ;; ` +
    `esac; ` +
    `FLEET_LEAD_PID=""; ` +
    `if [ -n "$FLEET_PANE_PID" ]; then FLEET_LEAD_PID="$(pgrep -x claude -P "$FLEET_PANE_PID" 2>/dev/null | head -n1)"; fi; ` +
    `echo '${SESSION_FOUND_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ]; then echo yes; else echo no; fi; ` +
    `echo '${SESSION_CONTINUE_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ] && tr '\\0' '\\n' < /proc/$FLEET_LEAD_PID/cmdline 2>/dev/null | grep -qxF -- --continue; then echo yes; else echo no; fi; ` +
    `echo '${SESSION_CWD_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ]; then readlink /proc/$FLEET_LEAD_PID/cwd 2>/dev/null; fi; echo`
  );
}

export interface PaneProbeResult {
  ok: boolean;
  /** Whether a lead process was actually located. `false` is its own
   *  outcome — maestro correction #9 — never folded into fresh/lost. */
  found: boolean;
  hasContinue: boolean;
  cwd: string | null;
  error: string | null;
}

export function parsePaneLeadProbe(stdout: string): PaneProbeResult {
  const lines = stdout.split("\n");
  const at = (marker: string): string => {
    const idx = lines.indexOf(marker);
    return idx === -1 ? "" : (lines[idx + 1] ?? "").trim();
  };
  const found = at(SESSION_FOUND_SECTION) === "yes";
  const hasContinue = at(SESSION_CONTINUE_SECTION) === "yes";
  const cwd = at(SESSION_CWD_SECTION);
  return { ok: true, found, hasContinue, cwd: cwd === "" ? null : cwd, error: null };
}

/**
 * Issue #85, signal 3 — pure verdict decision. `expectedCwd` is
 * `/workspace/<repo-segment>`, resolved by the caller from the studio's own
 * id (parseStudioId) — this function stays free of ids.ts so it composes
 * cleanly with failover.ts too, which never imports ids.ts today. Maestro
 * correction #9: a probe that succeeded but found no lead pid is its own
 * `unknown` outcome, never treated as `fresh` (no history) or `lost` (has
 * history) — the process simply was not there to ask.
 */
export function computeSessionVerdict(
  probe: PaneProbeResult, expectedCwd: string, restore: RestoreOutcome,
  turnsBefore: number, snapshotAgeS: number | null, at: string, via: BringupVia,
): ObservedSession {
  if (!probe.ok) {
    return { verdict: "unknown", at, via, restore, snapshotAgeS, turnsBefore, reason: probe.error };
  }
  if (!probe.found) {
    return { verdict: "unknown", at, via, restore, snapshotAgeS, turnsBefore, reason: "no lead process found" };
  }
  const cwdMatches = probe.cwd === expectedCwd;
  const hasHistory = turnsBefore > 0 || restore === "restored";
  if (probe.hasContinue && cwdMatches) {
    return { verdict: "resumed", at, via, restore, snapshotAgeS, turnsBefore, reason: null };
  }
  if (!hasHistory) {
    return { verdict: "fresh", at, via, restore, snapshotAgeS, turnsBefore, reason: null };
  }
  const reason = !cwdMatches ? `cwd ${probe.cwd ?? "unknown"}` : "no --continue";
  return { verdict: "lost", at, via, restore, snapshotAgeS, turnsBefore, reason };
}

/**
 * Issue #85, maestro correction #7 — the ship tick's OWN verdict, used only
 * on an adoption (the DO never recorded a token — a pre-feature studio, or
 * the first tick after this deploy). Deliberately narrower than
 * `computeSessionVerdict`: adoption genuinely does not know the launch
 * history, so it is never allowed to answer `lost` (which would routinely
 * be wrong the moment a long-lived pre-feature studio is simply mid-turn
 * with no `--continue` because it was launched fresh, once, a long time
 * ago) or `fresh` (which would be wrong the moment it has real history).
 * `restore` is always `"not-attempted"` — an adoption is not a bring-up.
 */
export function computeAdoptedVerdict(
  probe: PaneProbeResult, expectedCwd: string, turnsBefore: number, at: string,
): ObservedSession {
  if (probe.ok && probe.found && probe.hasContinue && probe.cwd === expectedCwd) {
    return { verdict: "resumed", at, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore, reason: null };
  }
  const reason = !probe.ok ? probe.error : "adopted: launch history unknown";
  return { verdict: "unknown", at, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore, reason };
}

export const BRINGUP_TOKEN_WRITE_SECTION = "---FLEET-BRINGUP-TOKEN---";

/**
 * Issue #85, maestro correction #6 — folds the incarnation token write and
 * the pane-lead probe into ONE `sbExec` call, so a bring-up never issues
 * two sequential container calls where a hang in the first would silently
 * skip the second. `$?` right after the `mkdir && printf && mv` chain
 * reflects that WHOLE chain's own success (the last-executed step's exit
 * code, whether that is `mv` succeeding or an earlier step failing and
 * short-circuiting the rest) — captured into `FLEET_TOKEN_OK` before
 * anything else can reset `$?`.
 */
export function bringupObservationCmd(token: string): string {
  const quoted = shellQuote(token);
  return (
    `mkdir -p /workspace/.fleet && printf '%s\\n' ${quoted} > ${INCARNATION_PATH}.tmp && mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH}; ` +
    `FLEET_TOKEN_OK=$?; ` +
    `echo '${BRINGUP_TOKEN_WRITE_SECTION}'; if [ "$FLEET_TOKEN_OK" -eq 0 ]; then echo yes; else echo no; fi; ` +
    paneLeadProbeCmd()
  );
}

export function parseBringupObservation(stdout: string): { tokenWritten: boolean; probe: PaneProbeResult } {
  const lines = stdout.split("\n");
  const idx = lines.indexOf(BRINGUP_TOKEN_WRITE_SECTION);
  const tokenWritten = idx !== -1 && (lines[idx + 1] ?? "").trim() === "yes";
  return { tokenWritten, probe: parsePaneLeadProbe(stdout) };
}
```

- [ ] **Step 4: `provision.ts` — widen `runSessionRestore`'s return only; `runProvision`/`runRestart` KEEP their existing signatures and gain one line each (maestro correction #10)**

```ts
// apps/fleet/src/studio/provision.ts
import { type RestoreOutcome } from "./observed";

export async function runSessionRestore(
  deps: ProvisionDeps, id: string,
): Promise<{ plan: RestoreAction; parts: number; restore: RestoreOutcome }> {
  if (!deps.r2Get || !deps.writeFile) return { plan: "skip", parts: 0, restore: "not-attempted" };

  const checkRes = await deps.sbExec(CONTAINER_HAS_PROJECTS_CMD);
  const containerHasProjects = checkRes.stdout.trim() === "yes";
  const tarBytes = containerHasProjects ? null : await deps.r2Get(sessionLatestKey(id));
  const plan = restorePlan(tarBytes !== null, containerHasProjects);
  const restoreOutcome: RestoreOutcome = containerHasProjects ? "skip:has-projects" : tarBytes === null ? "skip:no-snapshot" : "restored";
  if (plan === "skip" || tarBytes === null) return { plan, parts: 0, restore: restoreOutcome };

  const numParts = Math.max(1, Math.ceil(tarBytes.length / SESSION_SINGLE_READ_MAX));
  try {
    // ...unchanged body...
  } catch (err) {
    await deps.sbExec(`rm -rf ${SESSION_RESTORE_DIR}`);
    throw err;
  }
  return { plan, parts: numParts, restore: restoreOutcome };
}
```

`ProvisionDeps` gains two new optional fields, beside `r2Get`/`writeFile`:

```ts
// apps/fleet/src/studio/provision.ts — ProvisionDeps interface, add:
  /**
   * Maestro correction #10 — issue #90 (currently blocked, but also touches
   * `runProvision`/`runRestart` directly) makes widening either function's
   * RETURN type a real conflict risk. Both keep their existing signatures;
   * this optional callback is how a caller (`provisionWithStorage`/
   * `restartWithStorage`, this task's Step 5) learns the restore outcome
   * instead — invoked exactly once, inside each function's EXISTING
   * `runSessionRestore` try/catch, with no other change to either function's
   * control flow. Absent for every existing caller/test, exactly like
   * `r2Get`/`writeFile`.
   */
  onRestoreOutcome?: (outcome: RestoreOutcome) => void;
  /**
   * Maestro correction #8 — R2's own `uploaded` timestamp for a session
   * snapshot object, used ONLY as a fallback inside `recordBringupObservation`
   * (this task's Step 5) when `Observed.lastSnapshotAt` was never recorded
   * yet but a restore genuinely happened. Optional for the same reason every
   * other R2-touching port on this interface is; do.ts's real `deps()`
   * always supplies it once wired.
   */
  r2Head?: (key: string) => Promise<{ uploaded: Date } | null>;
```

`runProvision`'s only change is ONE line inside its existing restore try/catch (its return type is UNTOUCHED — still `Promise<{ status, roleEnv, keepAlive }>`):

```ts
export async function runProvision(
  deps: ProvisionDeps, cfg: ProvisionConfig, fleetRepoSlug: string, existing: StudioStatus | null,
): Promise<{ status: StudioStatus; roleEnv: RoleEnv | StudioEnv | null; keepAlive: boolean | null }> {
  // ...unchanged declarations...
  try {
    // ...unchanged through the clone/rescue-refs block...
    let restoreOutcome: RestoreOutcome = "not-attempted";
    try {
      const restoreResult = await runSessionRestore(deps, id);
      restoreOutcome = restoreResult.restore;
    } catch (err) {
      restoreOutcome = "failed";
      console.error(
        `studio ${id}: session restore failed, proceeding fresh`,
        err instanceof Error ? err.message : String(err),
      );
    }
    deps.onRestoreOutcome?.(restoreOutcome); // <-- the one new line
    // ...unchanged bring-up/verify/success block...
    status = { ...status, state: "running", lastRefresh: deps.now(), error: null };
  } catch (err) {
    status = { ...status, state: "degraded", error: redactSecrets(err instanceof Error ? err.message : String(err)) };
  }

  await deps.recordStudio(status);
  return { status, roleEnv, keepAlive };
}
```

`runRestart` gets the identical one-line addition, at its OWN restore try/catch (~1798-1805 in the current file), also with NO return-type change (still `Promise<StudioStatus>`):

```ts
export async function runRestart(
  deps: ProvisionDeps, existing: StudioStatus | null, idFallback: string, roleEnv: RoleEnv | StudioEnv | null,
  keepAlive: boolean, fleetRepoSlug: string,
): Promise<StudioStatus> {
  let status: StudioStatus = { ...(existing ?? freshStatus(idFallback)), state: "provisioning" };
  if (roleEnv === null) {
    status = { ...status, state: "degraded", error: NO_ROLE_ENV_ERROR };
    await deps.recordStudio(status);
    return status;
  }
  // ...unchanged declarations (repo, isStudio, firstFailure, cloneRefusal)...
  try {
    // ...unchanged through the clone block...
    let restoreOutcome: RestoreOutcome = "not-attempted";
    try {
      const restoreResult = await runSessionRestore(deps, status.id);
      restoreOutcome = restoreResult.restore;
    } catch (err) {
      restoreOutcome = "failed";
      console.error(
        `studio ${status.id}: session restore failed on restart, continuing without it`,
        err instanceof Error ? err.message : String(err),
      );
    }
    deps.onRestoreOutcome?.(restoreOutcome); // <-- the one new line
    // ...unchanged retry/verify/success block...
    status = { /* unchanged */ };
  } catch (err) {
    // ...unchanged degraded branch...
  }
  return status;
}
```

- [ ] **Step 5: `provisionWithStorage`/`restartWithStorage` — read `lastSnapshotAt` BEFORE the call (correction #8), capture `restoreOutcome` via the new callback (correction #10), fold token+probe into one exec (correction #6), reset reachability (correction #13)**

```ts
// apps/fleet/src/studio/provision.ts
import { parseStudioId } from "./ids";
import {
  mergeObserved, computeSessionVerdict, bringupObservationCmd, parseBringupObservation,
  type ObservedStorage, type BringupVia, type PaneProbeResult, type RestoreOutcome, type Observed,
} from "./observed";

/**
 * Issue #85 — the shared post-bring-up finisher `provisionWithStorage`/
 * `restartWithStorage` both call once bring-up has succeeded. Folds the
 * incarnation token write and the pane-lead probe into ONE `sbExec` call
 * (maestro correction #6) and records a session verdict from the LIVE lead
 * process, never bring-up's own intent. `lastSnapshotAtBefore` is read by
 * the CALLER before `runProvision`/`runRestart` ran — maestro correction
 * #8 — never re-read here, since the independent 300s sync tick can
 * complete WHILE this bring-up was still in flight.
 */
async function recordBringupObservation(
  deps: ProvisionDeps, observedStorage: ObservedStorage | undefined, status: StudioStatus,
  existing: StudioStatus | null, restoreOutcome: RestoreOutcome, via: BringupVia,
  lastSnapshotAtBefore: string | null,
): Promise<void> {
  if (!observedStorage) return;
  const token = crypto.randomUUID();
  let tokenWritten = false;
  let probe: PaneProbeResult;
  try {
    const res = await deps.sbExec(bringupObservationCmd(token));
    const parsed = parseBringupObservation(res.stdout);
    tokenWritten = res.code === 0 && parsed.tokenWritten;
    probe = parsed.probe;
    if (res.code !== 0) {
      console.error(`studio ${status.id}: bring-up observation exec failed (${res.code}): ${res.stderr.slice(0, 300)}`);
    }
  } catch (err) {
    probe = { ok: false, found: false, hasContinue: false, cwd: null, error: err instanceof Error ? err.message : String(err) };
    console.error(`studio ${status.id}: bring-up observation exec failed`, err instanceof Error ? err.message : String(err));
  }

  const repo = parseStudioId(status.id)?.repo ?? null;
  const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
  const turnsBefore = existing?.burn?.turns ?? 0;
  const now = deps.now();

  // Maestro correction #8 — snapshotAgeS only when a restore actually
  // happened; falls back to R2's own `uploaded` timestamp only when
  // `lastSnapshotAtBefore` was never recorded yet.
  let snapshotAgeS: number | null = null;
  if (restoreOutcome === "restored") {
    if (lastSnapshotAtBefore !== null) {
      snapshotAgeS = Math.floor((Date.parse(now) - Date.parse(lastSnapshotAtBefore)) / 1000);
    } else if (deps.r2Head) {
      const head = await deps.r2Head(sessionLatestKey(status.id));
      if (head) snapshotAgeS = Math.floor((Date.parse(now) - head.uploaded.getTime()) / 1000);
    }
  }

  const session = computeSessionVerdict(probe, expectedCwd, restoreOutcome, turnsBefore, snapshotAgeS, now, via);

  // Maestro correction #13 — a successful bring-up proves the exec plane is
  // alive; reset reachability the same way a successful ship tick does.
  const patch: Partial<Observed> = { session, execFailures: 0, unreachableSince: null };
  if (tokenWritten) {
    patch.incarnation = token;
    patch.replacedAt = null;
  }
  await mergeObserved(observedStorage, patch);
}

export async function provisionWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, cfg: ProvisionConfig, fleetRepoSlug: string,
  via: BringupVia = "provision", observedStorage?: ObservedStorage,
): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  const lastSnapshotAtBefore = observedStorage ? (await getObserved(observedStorage)).lastSnapshotAt : null;
  let restoreOutcome: RestoreOutcome = "not-attempted";
  const provisionDeps: ProvisionDeps = { ...deps, onRestoreOutcome: (r) => { restoreOutcome = r; } };
  await storage.put(OPERATION_KEY, { op: "provision", since: deps.now() });
  let status: StudioStatus;
  let roleEnv: RoleEnv | StudioEnv | null;
  let keepAlive: boolean | null;
  try {
    ({ status, roleEnv, keepAlive } = await runProvision(provisionDeps, cfg, fleetRepoSlug, existing));
  } finally {
    await storage.put(OPERATION_KEY, null);
  }
  if (roleEnv !== null) await storage.put(ROLE_ENV_KEY, roleEnv);
  if (keepAlive !== null) await storage.put(KEEP_ALIVE_KEY, keepAlive);
  await storage.put(STATUS_KEY, status);
  if (status.state === "running") {
    await recordBringupObservation(deps, observedStorage, status, existing, restoreOutcome, via, lastSnapshotAtBefore);
  }
  return status;
}

export async function restartWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, idFallback: string, fleetRepoSlug: string,
  via: BringupVia = "restart", observedStorage?: ObservedStorage,
): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  const roleEnv = (await storage.get(ROLE_ENV_KEY)) ?? null;
  const keepAlive = (await storage.get(KEEP_ALIVE_KEY)) ?? true;
  const lastSnapshotAtBefore = observedStorage ? (await getObserved(observedStorage)).lastSnapshotAt : null;
  let restoreOutcome: RestoreOutcome = "not-attempted";
  const provisionDeps: ProvisionDeps = { ...deps, onRestoreOutcome: (r) => { restoreOutcome = r; } };
  await storage.put(OPERATION_KEY, { op: "restart", since: deps.now() });
  let status: StudioStatus;
  try {
    status = await runRestart(provisionDeps, existing, idFallback, roleEnv, keepAlive, fleetRepoSlug);
  } finally {
    await storage.put(OPERATION_KEY, null);
  }
  await storage.put(STATUS_KEY, status);
  if (status.state === "running") {
    await recordBringupObservation(deps, observedStorage, status, existing, restoreOutcome, via, lastSnapshotAtBefore);
  }
  return status;
}
```

This REPLACES Task 3's Step 3 `recordIncarnation` helper (and its `void via;` lines) entirely — Task 3's narrower version was a deliberate stepping stone; this step supersedes it in the same two functions.

- [ ] **Step 6: `failover.ts` — extend the post-success block with the same verdict call, folded into one exec**

```ts
// apps/fleet/src/studio/failover.ts
import {
  mergeObserved, getObserved, computeSessionVerdict, bringupObservationCmd, parseBringupObservation,
  type ObservedStorage, type PaneProbeResult, type Observed,
} from "./observed";
import { parseStudioId } from "./ids";

// inside runAccountFailover, replacing Task 3's narrower post-success block:
  await storage.put(STATUS_KEY, switched);
  await recordStudioFn(switched);
  if (!failed && observedStorage) {
    const token = crypto.randomUUID();
    let tokenWritten = false;
    let probe: PaneProbeResult;
    try {
      const res = await deps.exec(bringupObservationCmd(token));
      const parsed = parseBringupObservation(res.stdout);
      tokenWritten = res.code === 0 && parsed.tokenWritten;
      probe = parsed.probe;
    } catch (err) {
      probe = { ok: false, found: false, hasContinue: false, cwd: null, error: err instanceof Error ? err.message : String(err) };
      console.error(`studio ${studioId}: bring-up observation exec failed after failover`, err);
    }
    const repo = parseStudioId(existing.id)?.repo ?? null;
    const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
    const turnsBefore = existing.burn?.turns ?? 0;
    const nowIso = deps.now().toISOString();
    // Maestro correction #8: a failover never restores (restore is always
    // "not-attempted" here), so snapshotAgeS stays null — no R2 fallback
    // needed on this path.
    const session = computeSessionVerdict(probe, expectedCwd, "not-attempted", turnsBefore, null, nowIso, "failover");
    const patch: Partial<Observed> = { session, execFailures: 0, unreachableSince: null }; // correction #13
    if (tokenWritten) { patch.incarnation = token; patch.replacedAt = null; }
    await mergeObserved(observedStorage, patch);
  }
  await deps.notify(/* unchanged */);
  return { kind: "switched", from, to: next.name };
```

(`restore: "not-attempted"` — a failover relaunch is `--continue` against the SAME still-live container, never a fresh session restore; `runSessionRestore` is not part of this path.)

- [ ] **Step 7: Run all affected tests**

Run: `cd apps/fleet && bunx vitest run test/studio.observed.test.ts test/studio.session.test.ts test/studio.replacement.test.ts test/studio.account-failover.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 8: Integration assertion — the combined bring-up observation command is actually issued after bring-up, once**

```ts
// apps/fleet/test/studio.replacement.test.ts — add to the incarnation describe block from Task 3
import { BRINGUP_TOKEN_WRITE_SECTION } from "../src/studio/observed";

it("a successful restart issues exactly one combined token-write + pane-probe exec after BRINGUP_CMD (maestro correction #6)", async () => {
  const deps = restartDeps(() => undefined);
  const storage = fakeStorageWithObserved({
    status: status({ repoSlug: `rafarc21/${REPO}` }), roleEnv: STUDIO_ENV,
  });

  await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

  const bringupIdx = deps.cmds.indexOf(BRINGUP_CMD);
  const observationCmds = deps.cmds.filter((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION));
  expect(observationCmds).toHaveLength(1); // exactly one exec, never two
  expect(deps.cmds.indexOf(observationCmds[0])).toBeGreaterThan(bringupIdx);
  const observed = await getObserved(storage);
  expect(observed.session?.via).toBe("restart");
});
```

Run: `cd apps/fleet && bunx vitest run test/studio.replacement.test.ts`
Expected: PASS.

- [ ] **Step 9: Extend Task 4's ship-tick adoption branch with the `via: "adopted"` verdict (maestro correction #7)**

Task 4's `runShipTickWithObservation` already folds the adoption write into the SAME exec as the ship tick (`shipTickCmd`'s `adoptionToken` parameter). This step folds the pane probe into that SAME exec too, and records a verdict only on an actual adoption (the DO had no token, and this tick's `incarnationPatch` result set one).

```ts
// apps/fleet/src/studio/transcript.ts — shipTickCmd gains the probe fragment when adopting
import { paneLeadProbeCmd } from "./observed"; // add to the existing observed.ts import

export function shipTickCmd(
  manifestOffset: number, storedBootId: string | undefined, adoptionToken?: string,
): string {
  const storedBootIdLiteral = shellSingleQuote(storedBootId ?? "");
  const incarnationRead = adoptionToken === undefined
    ? `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; `
    : (
      `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
      `if [ -z "$FLEET_INC" ]; then ` +
      `mkdir -p /workspace/.fleet && printf '%s\\n' ${shellSingleQuote(adoptionToken)} > ${INCARNATION_PATH}.tmp ` +
      `&& mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH} && FLEET_INC=${shellSingleQuote(adoptionToken)}; ` +
      `fi; `
    );
  // Maestro correction #7: fold the pane probe into the SAME exec, but only
  // when this tick MIGHT adopt — a steady-state tick (adoptionToken
  // undefined) never pays for a probe it has no use for.
  const probeFragment = adoptionToken === undefined ? "" : paneLeadProbeCmd();
  return (
    `FLEET_FRESH_BOOT_ID=$(cat ${TRANSCRIPT_BOOT_ID_PATH} 2>/dev/null || echo ''); ` +
    `echo '${SECTION_BOOTID}'; echo "$FLEET_FRESH_BOOT_ID"; ` +
    `FLEET_SIZE=$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1); ` +
    `echo '${SECTION_STAT}'; echo "$FLEET_SIZE"; ` +
    incarnationRead +
    `echo '${SECTION_INCARNATION}'; echo "$FLEET_INC"; ` +
    probeFragment +
    `if [ "$FLEET_SIZE" -ge 0 ]; then ` +
    `FLEET_STORED_BOOT_ID=${storedBootIdLiteral}; ` +
    `if [ -n "$FLEET_FRESH_BOOT_ID" ] && [ -n "$FLEET_STORED_BOOT_ID" ] && [ "$FLEET_FRESH_BOOT_ID" != "$FLEET_STORED_BOOT_ID" ]; then FLEET_EFF=0; else FLEET_EFF=${manifestOffset}; fi; ` +
    `if [ "$FLEET_EFF" -gt "$FLEET_SIZE" ]; then FLEET_EFF=0; fi; ` +
    `echo '${SECTION_CHUNK}'; ` +
    `tail -c +$((FLEET_EFF+1)) ${TRANSCRIPT_LOG_PATH} | head -c ${TRANSCRIPT_PULL_MAX} | base64; ` +
    `echo '${SECTION_TAIL}'; ` +
    `tail -c ${HOT_TAIL_BYTES} ${TRANSCRIPT_LOG_PATH} | base64; ` +
    `fi`
  );
}
```

```ts
// apps/fleet/src/studio/transcript.ts — ShipResult gains the parsed probe, only present on an adoption attempt
export interface ShipResult {
  shipped: number;
  rotated: boolean;
  incarnationToken: string;
  /** Maestro correction #7 — present ONLY when this tick attempted an
   *  adoption (shipTickCmd was given an `adoptionToken`); `undefined` on
   *  every steady-state tick, which never issues the probe fragment at all. */
  adoptionProbe?: PaneProbeResult;
  skipped?: string;
}

// shipTranscriptTick — parse the probe when present
export async function shipTranscriptTick(
  deps: ShipDeps, storage: TranscriptStorage, id: string, adoptionToken?: string,
): Promise<ShipResult> {
  // ...unchanged through the tickRes.code check...
  const { freshBootId, size, incarnationToken, chunkB64, tailB64 } = parseShipTickSections(tickRes.stdout);
  const adoptionProbe = adoptionToken === undefined ? undefined : parsePaneLeadProbe(tickRes.stdout);
  if (!Number.isFinite(size) || size < 0) {
    return { shipped: 0, rotated: false, incarnationToken, adoptionProbe, skipped: "no-file" };
  }
  // ...unchanged body...
  return { shipped, rotated, incarnationToken, adoptionProbe };
}
```

```ts
// apps/fleet/src/studio/do.ts — runShipTickWithObservation's transition block gains the verdict
import { computeAdoptedVerdict } from "./observed";
import { parseStudioId } from "./ids";

// Inside the non-opFresh, non-incarnationChangedMidTick branch, right after
// computing `incPatch` and BEFORE merging `combined` — maestro correction #7:
  const isAdoption = observedNow.incarnation === null && "incarnation" in incPatch;
  let sessionPatch: Partial<Observed> = {};
  if (isAdoption && result.adoptionProbe) {
    const status = await storage.get(STATUS_KEY);
    const repo = status ? parseStudioId(status.id)?.repo ?? null : null;
    const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
    const turnsBefore = status?.burn?.turns ?? 0;
    sessionPatch = { session: computeAdoptedVerdict(result.adoptionProbe, expectedCwd, turnsBefore, now) };
  }
  const combined = { ...reachabilityPatch, ...incPatch, ...sessionPatch };
```

- [ ] **Step 10: Write the failing test for the adoption verdict, then confirm it passes**

```ts
// apps/fleet/test/studio.observation-tick.test.ts — extend
import { computeAdoptedVerdict } from "../src/studio/observed";

it("an adoption records a session verdict via: \"adopted\" (maestro correction #7)", async () => {
  const deps = {
    exec: vi.fn(async (cmd: string) => ({
      code: 0,
      stdout: [
        "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1,
        "---FLEET-SESSION-FOUND---", "yes", "---FLEET-SESSION-CONTINUE---", "yes", "---FLEET-SESSION-CWD---", "/workspace/acme-os",
      ].join("\n"),
      stderr: "",
    })),
    r2Put: vi.fn(async () => {}),
    now: () => new Date("2026-09-24T10:00:00.000Z"),
  };
  const storage = fakeStorage({ status: status({ id: "acme-os--pilot" }) });

  await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

  const observed = await getObserved(storage);
  expect(observed.session?.via).toBe("adopted");
  expect(observed.session?.verdict).toBe("resumed"); // --continue found, cwd matches
});

it("an adoption with an unclear pane never records LOST (maestro correction #7)", async () => {
  const deps = {
    exec: vi.fn(async () => ({
      code: 0,
      stdout: [
        "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1,
        "---FLEET-SESSION-FOUND---", "no", "---FLEET-SESSION-CONTINUE---", "no", "---FLEET-SESSION-CWD---", "",
      ].join("\n"),
      stderr: "",
    })),
    r2Put: vi.fn(async () => {}),
    now: () => new Date("2026-09-24T10:00:00.000Z"),
  };
  const storage = fakeStorage({ status: status({ id: "acme-os--pilot" }) });

  await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

  const observed = await getObserved(storage);
  expect(observed.session?.verdict).not.toBe("lost");
  expect(observed.session?.verdict).toBe("unknown");
});
```

Run: `cd apps/fleet && bunx vitest run test/studio.observation-tick.test.ts test/studio.transcript.test.ts`
Expected: PASS.

- [ ] **Step 11: Real-shell proof the redesigned pane probe never matches a foreign pane (maestro correction #9, #14)**

```ts
// apps/fleet/test/bun/pane-probe-lead.test.ts — new file. Linux-gated (the
// production container IS Linux; /proc/<pid>/cmdline and /proc/<pid>/cwd
// are Linux-only, same gate test/bun/pane-probe.test.ts's own #71 coverage
// already uses).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneLeadProbeCmd, parsePaneLeadProbe } from "../../src/studio/observed";

const isLinux = process.platform === "linux";

function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

describe.skipIf(!isLinux)("paneLeadProbeCmd against a real tmux server (issue #85, maestro correction #9)", () => {
  test("a member `claude -p` subprocess launched BY the lead is never mistaken for the lead itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    const env = isolatedTmuxEnv(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // Lead: a real `claude` binary is not available in this sandbox — a
      // long-lived shell function named `claude` stands in as the LEAD
      // process (pgrep -x claude matches on the process NAME, not the real
      // binary's identity), which itself spawns a background child also
      // named `claude` — the member `claude -p` this test proves is never
      // matched, since it is a grandchild of the pane, not a direct child.
      sh(
        "tmux new-session -d -s studio -n claude " +
        "'exec -a claude sh -c \"exec -a claude sleep 30 & sleep 30\"'",
      );
      const cmd = paneLeadProbeCmd().replaceAll("studio:claude", "studio:claude");
      const res = sh(cmd);
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true); // the DIRECT child (the lead) is found
    } finally {
      sh("tmux kill-server");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing studio:claude window answers unknown (found: false), never a foreign pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    const env = isolatedTmuxEnv(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      sh("tmux new-session -d -s other -n shell 'sleep 30'"); // a DIFFERENT session/window entirely
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0); // never crashes even though the target does not exist
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(false);
    } finally {
      sh("tmux kill-server");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `cd apps/fleet && bun test test/bun/pane-probe-lead.test.ts`
Expected: PASS on Linux (skipped elsewhere, matching `test/bun/pane-probe.test.ts`'s own existing gate).

- [ ] **Step 12: Full suite, all lanes (maestro correction #14 — run bun-test here too)**

Run: `cd apps/fleet && bunx vitest run && bun run check && bun run bun-test && bun test test/bun/pane-probe-lead.test.ts test/bun/incarnation-newline.test.ts`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/fleet/src/studio/observed.ts apps/fleet/src/studio/provision.ts apps/fleet/src/studio/failover.ts apps/fleet/src/studio/transcript.ts apps/fleet/src/studio/do.ts apps/fleet/test/studio.observed.test.ts apps/fleet/test/studio.session.test.ts apps/fleet/test/studio.replacement.test.ts apps/fleet/test/studio.account-failover.test.ts apps/fleet/test/studio.observation-tick.test.ts apps/fleet/test/studio.transcript.test.ts apps/fleet/test/bun/pane-probe-lead.test.ts
git commit -m "feat(studio): record a session verdict from the live lead process on every bring-up, incl. adoption (#85)"
```

---

## Task 7: Snapshot freshness — `lastSnapshotAt`

**Unchanged from the original draft — confirmed composes cleanly with Task 2's correction.** Task 2's `withObserved` wraps `syncSessionCycle`'s own `recordStudioFn` argument (one of its 10 wrapped `do.ts` closures) BEFORE this task's `mergeObserved(observedStorage, { lastSnapshotAt: now })` call inside the same tick — so by the time `mirrorBurnToRegistry` (called a few lines later in the same `syncSessionCycle` body) fires its `recordStudioFn`, the D1 write it triggers already carries the JUST-UPDATED `lastSnapshotAt`. This is exactly the "rides the mirror with zero added writes" behavior maestro correction #1 asks for — no change needed here.

**Files:**
- Modify: `apps/fleet/src/studio/do.ts` (`syncSessionCycle`, `runAccountFailover` call site inside it)
- Test: `apps/fleet/test/studio.session.test.ts` or `apps/fleet/test/studio.account-failover.test.ts` (wherever `syncSessionCycle` is already exercised directly — confirm with `grep -n "syncSessionCycle(" test/*.ts` before choosing)

**Interfaces:**
- Consumes: `Observed`, `ObservedStorage`, `mergeObserved` (Task 1); `SyncResult.skipped` (`session-sync.ts`, existing field — reused, not widened, see the note below).
- Produces: `syncSessionCycle`'s new optional 7th parameter `observedStorage?: ObservedStorage | null`.

**Design note (documented interpretation, not silently assumed):** `session-sync.ts`'s `SyncResult` already has everything needed to know whether the R2 put at `session-sync.ts:394` succeeded: the ONLY place `skipped` is ever assigned is the oversize guard at line 360, which returns BEFORE the put runs. So `result.skipped === undefined` on a normal (non-throwing) return from `syncSessionTick` already means the put ran and did not throw — no new `SyncResult` field is added. Also: the spec's "rides the mirror, adds no write" (`do.ts:1154-1164`, `mirrorBurnToRegistry`) is read here as "no new SCHEDULE" (the existing 300s `syncSession` cadence), not "literally zero additional storage calls" — `observed` is Principle 4's own separate DO key and physically cannot ride `mirrorBurnToRegistry`'s `STATUS_KEY` write. This task adds exactly one extra `mergeObserved` (one `get` + one `put`) per successful sync tick, on the same 300s cadence.

- [ ] **Step 1: Write the failing test**

First, confirm which test file already calls `syncSessionCycle` directly and copy its exact fake-storage/fake-deps shape:

```bash
cd apps/fleet && grep -n "syncSessionCycle(" test/studio.session.test.ts | head -5
```

```ts
// apps/fleet/test/studio.session.test.ts — add near the existing syncSessionCycle coverage
import { getObserved, emptyObserved, OBSERVED_KEY, type ObservedStorage } from "../src/studio/observed";

// Extend this file's own syncSessionCycle storage fake (whatever it's
// currently named — match its exact shape) with an ObservedStorage-capable
// Map, the same "one Map, several narrow-port views" pattern Task 3 used.

it("a successful sync tick sets observed.lastSnapshotAt to the tick's now (issue #85)", async () => {
  const storage = /* this file's existing fake, widened to also satisfy ObservedStorage over the same Map */;
  const deps = /* this file's existing SessionSyncDeps fake, exec always succeeds */;

  await syncSessionCycle(deps, storage, STUDIO_ID, async () => {}, null, null, storage);

  const observed = await getObserved(storage);
  expect(observed.lastSnapshotAt).not.toBeNull();
});

it("a failed sync tick (exec throws) leaves observed.lastSnapshotAt unchanged", async () => {
  const storage = /* fake, seeded with observed.lastSnapshotAt already set to an earlier value */;
  const deps = /* fake whose exec throws on the tar/stat command */;

  await syncSessionCycle(deps, storage, STUDIO_ID, async () => {}, null, null, storage);

  const observed = await getObserved(storage);
  expect(observed.lastSnapshotAt).toBe(/* the earlier seeded value, untouched */);
});
```

(Read the target test file's actual fake-building helpers before finalizing this step's literal code — the plan's own research did not pin an exact file; `grep -rl "syncSessionCycle(" apps/fleet/test/*.ts` lists the candidates: `studio.account-failover.test.ts`, `studio.self-heal.test.ts`, `studio.session.test.ts`, `studio.stopped-stays-stopped.test.ts`. Prefer `studio.session.test.ts` since it is the file most directly about session sync.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.session.test.ts`
Expected: FAIL — `syncSessionCycle` does not yet accept a 7th argument, and `observed.lastSnapshotAt` is never set.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/studio/do.ts
import { mergeObserved, type ObservedStorage } from "./observed";

export async function syncSessionCycle(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  failoverDeps?: FailoverDeps | null,
  heal?: (() => Promise<unknown>) | null,
  observedStorage?: ObservedStorage | null,
): Promise<void> {
  try {
    const now = syncDeps.now().toISOString();
    const result = await syncSessionTick(syncDeps, storage, idFallback);
    // Issue #85: the ONLY place SyncResult.skipped is ever assigned is the
    // oversize guard, which returns BEFORE the R2 put — see this task's own
    // design note. `skipped === undefined` here already means the put ran.
    if (observedStorage && result.skipped === undefined) {
      await mergeObserved(observedStorage, { lastSnapshotAt: now });
    }
  } catch (err) {
    console.error(`studio ${idFallback}: session sync tick failed`, err);
  }
  try {
    await mirrorBurnToRegistry(storage, recordStudioFn);
  } catch (err) {
    console.error(`studio ${idFallback}: burn mirror failed`, err);
  }
  if (failoverDeps) {
    try {
      const outcome = await runAccountFailover(failoverDeps, storage, idFallback, recordStudioFn, observedStorage ?? undefined);
      if (outcome.kind !== "no-modal") {
        console.log(`studio ${idFallback}: claude account failover -> ${JSON.stringify(outcome)}`);
      }
    } catch (err) {
      console.error(`studio ${idFallback}: claude account failover failed`, err);
    }
  }
  // ...unchanged readiness-check and heal blocks...
}
```

Wire the real call site (`syncSession()` method) to pass `this.ctx.storage`:

```ts
async syncSession(): Promise<void> {
  await runScheduledTick(
    this.ctx.storage,
    () => syncSessionCycle(
      this.syncDeps(), this.ctx.storage, this.selfId(), (s) => recordStudio(this.env, s), this.failoverDeps(),
      () => this.restartStudio("heal"),
      this.ctx.storage,
    ),
    () => this.rearm("syncSession", SYNC_SESSION_SECONDS),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fleet && bunx vitest run test/studio.session.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `cd apps/fleet && bunx vitest run`
Expected: PASS — every EXISTING caller of `syncSessionCycle` (the other 3 test files) omits the new trailing argument and is unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/studio/do.ts apps/fleet/test/studio.session.test.ts
git commit -m "feat(studio): record snapshot freshness on the existing sync cadence (#85)"
```

---

## Task 8: Move `SYNC_SESSION_SECONDS`, then rendering — `readyOverride`, `formatSession`, table + help text

**REVISED — see maestro corrections #4, #8, #11.** Three changes from the original draft:
- **#4:** the CLI-level "T10" fixture (`state: "provisioning"`) is kept as a render-logic regression test but explicitly RELABELED — it does NOT prove the operation-lock guard actually works, because D1's own `STATUS_KEY` read during a real operation is separately, measurably stale and stays `"running"` for the whole operation (verified against `provision.ts`'s own `OPERATION_KEY` doc comment — `provisionWithStorage`/`restartWithStorage` write `STATUS_KEY` only AFTER `runProvision`/`runRestart` return). The REAL T10 proof is the DO-level test Task 4 already added (`runShipTickWithObservation — op-lock guard`, `test/studio.observation-tick.test.ts`), which reads `OPERATION_KEY` directly the way the real ship tick does.
- **#8:** `formatSession` never renders a bare `"?"` or the literal word `"unknown"` — a `null`/`"unknown"` session still shows the snapshot-freshness suffix when one is known (`? · snap <age>[ STALE]`), since throwing away known snapshot-age information just because the SESSION verdict itself is unclear serves nobody.
- **#11:** `readyOverride`'s `unreachable` message now carries its own cost (`unreachable 6m — wedged; recycle loses work since snap 63m`, never a bare `→ recycle`); `READY_CAVEAT` gains the "inspect DO-side fail → wait" caveat (every repair verb — recycle, restart, heal — goes through the SAME DO an `unreachable`/DO-side-failing studio's `fleet inspect` would also be failing against, so racing straight to recycle when even inspect cannot get an answer just compounds the failure); `cli-args.ts`'s `ls` summary is updated to name the new override states, worded so an absence of recent commits (`LAST ACTIVITY`) is never itself described as "dead" — that column is git activity, not health, and conflating the two is exactly the class of bug this whole feature exists to stop repeating.

**Files:**
- Modify: `apps/fleet/src/studio/do.ts` (remove the local `SYNC_SESSION_SECONDS` definition, import it instead)
- Modify: `apps/fleet/src/studio/session-sync.ts` (add `SYNC_SESSION_SECONDS`)
- Modify: `apps/fleet/cli/readiness-format.ts` (`formatAge`, `readyOverride`, `formatSession`)
- Modify: `apps/fleet/cli/fleet.ts` (`formatTable`, `READY_CAVEAT`)
- Modify: `apps/fleet/src/studio/cli-args.ts` (`VERBS.ls.summary`, ~line 153)
- Test: `apps/fleet/test/cli.fleet.test.ts`

**Interfaces:**
- Consumes: `StudioStatus.observed` (Task 2), `SYNC_SESSION_SECONDS` (moved this task).
- Produces: `readyOverride(status, now): string | null`, `formatSession(status, now): string`, `formatAge(seconds): string` (`cli/readiness-format.ts`) — no later task consumes these; this is the rendering leaf.

- [ ] **Step 1: Move `SYNC_SESSION_SECONDS`**

```ts
// apps/fleet/src/studio/session-sync.ts — add near the top, beside SESSION_SYNC_DIR
/** Cadence of the syncSession tick (do.ts's own schedule) — moved here from
 *  do.ts (issue #85) so cli/readiness-format.ts, which must stay import-safe
 *  under the root tsconfig (see that file's own header — no
 *  "@cloudflare/sandbox" in its import graph), can derive its 660s
 *  staleness threshold from the SAME constant do.ts schedules against,
 *  rather than a second hardcoded copy. */
export const SYNC_SESSION_SECONDS = 300;
```

```ts
// apps/fleet/src/studio/do.ts
// DELETE the local `export const SYNC_SESSION_SECONDS = 300;` (~line 121).
// ADD SYNC_SESSION_SECONDS to the existing session-sync.ts import:
import { syncSessionTick, BURN_KEY, SYNC_SESSION_SECONDS, type SessionSyncDeps, type SessionSyncStorage } from "./session-sync";
```

Run: `cd apps/fleet && bun run check`
Expected: PASS — no other file imports `SYNC_SESSION_SECONDS` from `do.ts` (confirmed: only `do.ts` itself and comments reference it).

- [ ] **Step 2: Write the failing rendering tests**

```ts
// apps/fleet/test/cli.fleet.test.ts — add below the existing formatCheckedAt describe block
import { formatAge, readyOverride, formatSession } from "../cli/readiness-format";
import { emptyObserved } from "../src/studio/observed";
import { SYNC_SESSION_SECONDS } from "../src/studio/session-sync";

describe("formatAge (cli/readiness-format.ts)", () => {
  it("bare bucketed age, no suffix", () => {
    expect(formatAge(7)).toBe("7s");
    expect(formatAge(300)).toBe("5m");
    expect(formatAge(3 * 3600)).toBe("3h");
    expect(formatAge(2 * 86400)).toBe("2d");
  });
});

describe("readyOverride (cli/readiness-format.ts)", () => {
  const NOW = new Date("2026-09-24T12:00:00.000Z");

  // T1
  it("T1: replacedAt 6m ago, readiness still provisioned", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:59:00.000Z" },
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBe("replaced 6m ago — not brought up");
  });

  // T1b
  it("T1b: no observed at all (pre-feature row) — falls through to null", () => {
    const s = status({ state: "running", readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:59:00.000Z" } });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T2
  it("T2: unreachableSince 6m ago, a snapshot on file — the message carries its own cost (maestro correction #11)", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        unreachableSince: "2026-09-24T11:54:00.000Z",
        lastSnapshotAt: "2026-09-24T10:57:00.000Z", // 63m before NOW
      },
    });
    expect(readyOverride(s, NOW)).toBe("unreachable 6m — wedged; recycle loses work since snap 63m");
  });

  it("T2b: unreachableSince set, no snapshot on file at all — never a bare '→ recycle' (maestro correction #11)", () => {
    const s = status({
      state: "running",
      observed: { ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBe("unreachable 6m — wedged; recycle loses everything unshipped (no snapshot on file)");
  });

  // T3
  it("T3: checkedAt 14m old, nothing else set", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:46:00.000Z" },
      observed: { ...emptyObserved() },
    });
    expect(readyOverride(s, NOW)).toBe("unverified 14m — checks not completing → fleet inspect");
  });

  it("readiness null AND observed empty: no override, falls through", () => {
    const s = status({ state: "running", observed: { ...emptyObserved() } });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T9
  it("T9: stopped studio — no override regardless of observed fields", () => {
    const s = status({
      state: "stopped",
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  // T10 — maestro correction #4: this is a RENDER-LOGIC regression test only
  // (readyOverride correctly does nothing for a non-"running" state). It does
  // NOT prove the operation lock actually protects a real bring-up — D1's own
  // STATUS_KEY read stays "running" for the WHOLE duration of a real
  // operation (provisionWithStorage/restartWithStorage write it only AFTER
  // runProvision/runRestart return), so this state never actually occurs in
  // a live D1 row. The REAL proof is the DO-level test in Task 4's
  // `test/studio.observation-tick.test.ts` ("runShipTickWithObservation —
  // op-lock guard"), which reads OPERATION_KEY directly, the way the real
  // ship tick does.
  it("T10: render-logic only (see Task 4's DO-level test for the real op-lock proof) — a non-running state never gets an override", () => {
    const s = status({
      state: "provisioning",
      observed: { ...emptyObserved(), unreachableSince: "2026-09-24T11:54:00.000Z" },
    });
    expect(readyOverride(s, NOW)).toBeNull();
  });

  it("first match wins: replaced beats unreachable beats unverified", () => {
    const s = status({
      state: "running",
      readiness: { kind: "provisioned", checkedAt: "2026-09-24T11:00:00.000Z" }, // stale too
      observed: {
        ...emptyObserved(),
        replacedAt: "2026-09-24T11:54:00.000Z",
        unreachableSince: "2026-09-24T11:50:00.000Z",
      },
    });
    expect(readyOverride(s, NOW)).toBe("replaced 6m ago — not brought up");
  });
});

describe("formatSession (cli/readiness-format.ts) — maestro correction #8: never a bare \"?\" or literal \"unknown\" when a snapshot age is known", () => {
  const NOW = new Date("2026-09-24T12:00:00.000Z");

  it("no observed at all, no snapshot known: \"?\" alone is the honest floor", () => {
    expect(formatSession(status({}), NOW)).toBe("? · snap ?");
  });

  it("no session recorded yet, but a snapshot age IS known: never throws away the snapshot info", () => {
    const s = status({
      observed: { ...emptyObserved(), lastSnapshotAt: "2026-09-24T11:57:00.000Z" },
    });
    expect(formatSession(s, NOW)).toBe("? · snap 3m");
  });

  it("verdict unknown: renders \"?\", never the literal word \"unknown\"", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:57:00.000Z",
        session: {
          verdict: "unknown", at: "2026-09-24T11:00:00.000Z", via: "adopted",
          restore: "not-attempted", snapshotAgeS: null, turnsBefore: 12, reason: "adopted: launch history unknown",
        },
      },
    });
    const rendered = formatSession(s, NOW);
    expect(rendered).toBe("? · snap 3m");
    expect(rendered).not.toContain("unknown");
  });

  // T4
  it("T4: resumed, snapshot 61m old at restore time", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T11:00:00.000Z", via: "recycle",
          restore: "restored", snapshotAgeS: 61 * 60, turnsBefore: 9, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · from snap 61m old · snap 1m");
  });

  it("fresh, no snapshot age suffix, snap age shown", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T11:57:00.000Z",
        session: {
          verdict: "fresh", at: "2026-09-24T11:00:00.000Z", via: "provision",
          restore: "skip:no-snapshot", snapshotAgeS: null, turnsBefore: 0, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("fresh · snap 3m");
  });

  it("LOST: uppercase verdict, had <n> turns, no snap yet", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        session: {
          verdict: "lost", at: "2026-09-24T11:00:00.000Z", via: "restart",
          restore: "skip:has-projects", snapshotAgeS: null, turnsBefore: 412, reason: "no --continue",
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("LOST · had 412 turns · snap ?");
  });

  // T8
  it("T8: lastSnapshotAt 61m old, running -> STALE suffix", () => {
    const s = status({
      state: "running",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T10:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T10:00:00.000Z", via: "heal",
          restore: "restored", snapshotAgeS: 30, turnsBefore: 4, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · snap 61m STALE");
  });

  it("a stale snapshot on a STOPPED studio never renders STALE", () => {
    const s = status({
      state: "stopped",
      observed: {
        ...emptyObserved(),
        lastSnapshotAt: "2026-09-24T10:59:00.000Z",
        session: {
          verdict: "resumed", at: "2026-09-24T10:00:00.000Z", via: "heal",
          restore: "restored", snapshotAgeS: 30, turnsBefore: 4, reason: null,
        },
      },
    });
    expect(formatSession(s, NOW)).toBe("resumed · snap 61m");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/cli.fleet.test.ts`
Expected: FAIL — `formatAge`/`readyOverride`/`formatSession` do not exist.

- [ ] **Step 4: Implement `cli/readiness-format.ts`**

```ts
// apps/fleet/cli/readiness-format.ts
import type { StudioStatus } from "../src/studio/types";
import { SYNC_SESSION_SECONDS } from "../src/studio/session-sync";

/** Bare bucketed age, largest whole unit, NO "ago"/suffix — the shared core
 *  formatCheckedAt already computed inline; factored out (issue #85) so the
 *  READY overrides and the SESSION column, which each attach their OWN
 *  suffix convention (" ago" only for `replaced`; none for `unreachable`/
 *  `unverified`/`snap`), share one bucketing implementation. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatCheckedAt(readiness: StudioStatus["readiness"], now: Date): string {
  if (readiness == null) return "never";
  const at = Date.parse(readiness.checkedAt);
  if (Number.isNaN(at)) return readiness.checkedAt;
  const seconds = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  return `${formatAge(seconds)} ago`;
}

/** How stale a readiness verdict must be before the CLI itself calls it
 *  unverified — 2 sync cycles plus a minute of slack (issue #85). Derived
 *  from SYNC_SESSION_SECONDS, never a bare 660. */
const UNVERIFIED_AFTER_SECONDS = 2 * SYNC_SESSION_SECONDS + 60;

function ageSeconds(iso: string, now: Date): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now.getTime() - at) / 1000));
}

/**
 * Issue #85 — READY overrides, `state: "running"` only, first match wins:
 * replaced -> unreachable -> unverified -> null (render today's formatReady).
 * A stopped or provisioning studio (the operation lock — #86/#87) never
 * gets an override: a bring-up in flight has no token yet, and a stopped
 * studio renders exactly as today. Maestro correction #11: `unreachable`
 * carries its own cost (what a `recycle` right now would lose) rather than
 * a bare `→ recycle` — an operator should never have to go look that up
 * separately before deciding whether the loss is acceptable.
 */
export function readyOverride(status: StudioStatus, now: Date): string | null {
  if (status.state !== "running") return null;
  const observed = status.observed;
  if (observed?.replacedAt != null) {
    return `replaced ${formatAge(ageSeconds(observed.replacedAt, now))} ago — not brought up`;
  }
  if (observed?.unreachableSince != null) {
    const lastSnapshotAt = observed.lastSnapshotAt;
    const cost = lastSnapshotAt == null
      ? "loses everything unshipped (no snapshot on file)"
      : `loses work since snap ${formatAge(ageSeconds(lastSnapshotAt, now))}`;
    return `unreachable ${formatAge(ageSeconds(observed.unreachableSince, now))} — wedged; recycle ${cost}`;
  }
  const checkedAt = status.readiness?.checkedAt;
  if (checkedAt != null) {
    const age = ageSeconds(checkedAt, now);
    if (age > UNVERIFIED_AFTER_SECONDS) {
      return `unverified ${formatAge(age)} — checks not completing → fleet inspect`;
    }
  }
  return null;
}

/**
 * Issue #85 — the SESSION column. Grammar:
 * `<verdict>[ · had <n> turns][ · from snap <age> old] · snap <age>[ STALE]`
 * Maestro correction #8: `<verdict>` is `"?"` whenever there is nothing
 * useful to say (no `session` recorded at all, OR `session.verdict ===
 * "unknown"`) — but the trailing `snap <age>` suffix is ALWAYS computed and
 * ALWAYS appended regardless, because `lastSnapshotAt` is a completely
 * separate signal from the session verdict and throwing it away just
 * because the verdict itself is unclear serves nobody. The literal word
 * "unknown" is never rendered — `"?"` carries the same meaning without
 * reading like an error state distinct from every other reason this column
 * might not have a confident verdict.
 */
export function formatSession(status: StudioStatus, now: Date): string {
  const session = status.observed?.session ?? null;
  const parts: string[] = [];
  if (session === null || session.verdict === "unknown") {
    parts.push("?");
  } else {
    const verdict = session.verdict === "lost" ? "LOST" : session.verdict;
    parts.push(verdict);
    if (session.verdict === "lost") parts.push(`had ${session.turnsBefore} turns`);
    if (session.snapshotAgeS !== null && session.snapshotAgeS > UNVERIFIED_AFTER_SECONDS) {
      parts.push(`from snap ${formatAge(session.snapshotAgeS)} old`);
    }
  }
  const lastSnapshotAt = status.observed?.lastSnapshotAt ?? null;
  if (lastSnapshotAt === null) {
    parts.push("snap ?");
  } else {
    const age = ageSeconds(lastSnapshotAt, now);
    const stale = age > UNVERIFIED_AFTER_SECONDS && status.state === "running";
    parts.push(`snap ${formatAge(age)}${stale ? " STALE" : ""}`);
  }
  return parts.join(" · ");
}
```

- [ ] **Step 5: Run to verify pure-function tests pass**

Run: `cd apps/fleet && bunx vitest run test/cli.fleet.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `formatTable` + `READY_CAVEAT`**

```ts
// apps/fleet/cli/fleet.ts
import { formatReady, formatCheckedAt, readyOverride, formatSession } from "./readiness-format";

export function formatTable(studios: StudioStatus[], now: Date = new Date()): string {
  if (studios.length === 0) return "(no studios provisioned)";
  const headers = [
    "ID", "REPO", "STATE", "READY", "SESSION", "CHECKED", "ACCOUNT", "HOST", "BURN", "LAST ACTIVITY", "ERROR",
  ];
  const rows = studios.map((s) => [
    s.id,
    parseStudioId(s.id)?.repo ?? "-",
    s.state,
    readyOverride(s, now) ?? formatReady(s.readiness),
    formatSession(s, now),
    formatCheckedAt(s.readiness, now),
    s.claudeAccount ?? "CLAUDE_CODE_OAUTH_TOKEN",
    s.tailscaleHost ?? "-",
    formatBurn(s.burn),
    s.lastRefresh ?? "-",
    (s.error ?? "-").replace(/\s+/g, " "),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

const READY_CAVEAT =
  "READY=provisioned means ALIVE, not WORKING: pane_current_command reads \"claude\" for a lead mid-turn, " +
  "a lead stopped waiting on subagents, AND a lead dead at a shell prompt. It cannot tell those three apart. " +
  "READY may also read replaced/unreachable/unverified (issue #85) — evidence the row's LAST VERDICT is stale " +
  "or contradicted, never a live re-check: replaced means the ship tick found no incarnation token (wait for " +
  "heal, or provision — the container itself may already be fine, just not yet re-confirmed); unreachable " +
  "means the DO itself is alive but the container exec plane is not (the message itself names what a recycle " +
  "would lose); unverified means readiness checks themselves have stopped landing (run fleet inspect first — " +
  "it names which side failed). If fleet inspect ITSELF fails DO-side (not a container-side refusal), every " +
  "repair verb — restart, recycle, heal — goes through that SAME DO, so the right move is to WAIT and re-check, " +
  "not to immediately recycle into a DO that cannot currently answer at all.";
```

- [ ] **Step 7: Update `cli-args.ts`'s `ls` summary (maestro correction #11)**

```ts
// apps/fleet/src/studio/cli-args.ts — VERBS.ls.summary, ~line 153
  ls: {
    args: "[--fresh]",
    summary: "Every studio: id, repo, state, READY (provisioned/bare/\"?\" unknown, do.ts's periodic container check — the registry's own state/error can be stale, trust READY; READY may also read replaced/unreachable/unverified, issue #85, when the ship tick's own evidence contradicts the last container-side check), SESSION (resumed/fresh/LOST/\"?\", whether the live lead actually continued its history or started over, plus how old the last shipped snapshot is), CHECKED (how old that verdict is — up to 300s by default), tailnet host, burn, last activity (git commits — a quiet LAST ACTIVITY column means no recent commits, not that the studio is unhealthy; check READY/SESSION for that), error. Read-only. --fresh re-checks every studio live first (one container exec each, slower) instead of reading the last recorded verdict.",
  },
```

- [ ] **Step 8: Run the full CLI test suite**

Run: `cd apps/fleet && bunx vitest run test/cli.fleet.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 9: Full suite**

Run: `cd apps/fleet && bunx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/studio/session-sync.ts apps/fleet/src/studio/do.ts apps/fleet/src/studio/cli-args.ts apps/fleet/cli/readiness-format.ts apps/fleet/cli/fleet.ts apps/fleet/test/cli.fleet.test.ts
git commit -m "feat(cli): READY overrides + SESSION column render Observed, cost-aware wording (#85)"
```

---

## Task 9: `fleet inspect` — incarnation + bringup.log tail + stored DO-side verdict

**REVISED — see maestro corrections #2, #12.** Two changes from the original draft:
- **#2:** `inspectCmd`'s incarnation read uses the SAME newline-safe `FLEET_INC="$(cat FILE 2>/dev/null)"` convention Task 3/4 established — never the bare `cat FILE || echo ''` glued into stdout.
- **#12:** `fleet inspect` now ALSO prints the DO's OWN stored `Observed` verdict (`replaced`/`unreachable`/session) as its own section — a plain storage read, ZERO additional container exec — on BOTH the success path and the container-side-failure path (`runInspect`'s `{ok:false}` branch, e.g. the 15s exec deadline firing). Today, a container-side failure returns ONLY an error string and nothing else — an operator gets no signal at all about what the DO itself already knows, right when they need it most. `#92`'s own refusal/error strings (the `state === null`/`"stopped"`/deadline messages) stay byte-for-byte unchanged — this only ADDS a field alongside them, never touches their text.

**Files:**
- Modify: `apps/fleet/src/studio/inspect.ts` (`inspectCmd`, `InspectSnapshot`, `parseInspectOutput`)
- Modify: `apps/fleet/src/studio/do.ts` (`StudioDO.inspect()` — wraps `runInspect`'s outcome with the DO's own stored `Observed`, zero exec)
- Modify: `apps/fleet/src/studio/routes.ts` (`GET /studio/:id/inspect`, ~458-481 — `observed` on BOTH response branches)
- Modify: `apps/fleet/cli/fleet.ts` (`cmdInspect`, ~314-331)
- Test: `apps/fleet/test/studio.inspect.test.ts`, `apps/fleet/test/studio.routes.test.ts`

**Interfaces:**
- Consumes: `INCARNATION_PATH` (Task 3), `bringupLogTailCmd` (`provision.ts`, existing, unmodified), `getObserved`, `Observed` (Task 1).
- Produces: `InspectSnapshot.incarnationPresent: boolean`, `InspectSnapshot.bringupLogTail: string`, `StudioDO.inspect()`'s return widened to `InspectOutcome & { observed: Observed }` — consumed only by the route/CLI in this same task.

- [ ] **Step 1: Write the failing tests**

Read `test/studio.inspect.test.ts` first to match its exact fixture-building convention before writing these.

```ts
// apps/fleet/test/studio.inspect.test.ts — add
import { INCARNATION_PATH } from "../src/studio/observed";
import { BRINGUP_LOG_PATH } from "../src/studio/provision";

describe("inspectCmd / parseInspectOutput — incarnation + bringup log (issue #85)", () => {
  it("inspectCmd's command reads the incarnation file and the bringup log tail, both before TAIL_BEGIN's pane capture, newline-safe (maestro correction #2)", () => {
    const cmd = inspectCmd("acme-os");
    const incarnationIdx = cmd.indexOf(INCARNATION_PATH);
    const logIdx = cmd.indexOf(BRINGUP_LOG_PATH);
    const tailBeginIdx = cmd.indexOf("TAIL_BEGIN");
    expect(incarnationIdx).toBeGreaterThan(0);
    expect(logIdx).toBeGreaterThan(0);
    expect(incarnationIdx).toBeLessThan(tailBeginIdx);
    expect(logIdx).toBeLessThan(tailBeginIdx);
    expect(cmd).not.toMatch(new RegExp(`cat ${INCARNATION_PATH}[^)]*\\|\\| echo`));
  });

  it("parseInspectOutput: incarnation present, bringup log tail captured, pane tail still parses correctly", () => {
    const stdout = [
      CHECKOUT_PRESENT,
      "FLEET_INSPECT_PANE:studio:claude claude",
      "FLEET_INSPECT_INCARNATION",
      "abc-123-token",
      "FLEET_INSPECT_BRINGUP_LOG",
      "step-ok clone",
      "step-ok bring-up",
      "TAIL_BEGIN",
      "⏺ working on something",
    ].join("\n");
    const snapshot = parseInspectOutput(stdout);
    expect(snapshot.incarnationPresent).toBe(true);
    expect(snapshot.bringupLogTail).toBe("step-ok clone\nstep-ok bring-up");
    expect(snapshot.tail).toBe("⏺ working on something");
    expect(snapshot.checkoutExists).toBe(true);
    expect(snapshot.paneCommand).toBe("claude");
  });

  it("parseInspectOutput: incarnation absent (empty line) reads MISSING", () => {
    const stdout = [
      CHECKOUT_MISSING, "FLEET_INSPECT_PANE:none",
      "FLEET_INSPECT_INCARNATION", "",
      "FLEET_INSPECT_BRINGUP_LOG", "",
      "TAIL_BEGIN", "",
    ].join("\n");
    expect(parseInspectOutput(stdout).incarnationPresent).toBe(false);
  });
});
```

(`CHECKOUT_PRESENT`/`CHECKOUT_MISSING`/`inspectCmd`/`parseInspectOutput` are already imported at this file's top — confirm the exact import list before adding to it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.inspect.test.ts`
Expected: FAIL — no incarnation/bringup-log sections exist yet.

- [ ] **Step 3: Implement `inspect.ts`, newline-safe read**

```ts
// apps/fleet/src/studio/inspect.ts
import { INCARNATION_PATH } from "./observed";
import { bringupLogTailCmd } from "./provision";

export const INCARNATION_SECTION = "FLEET_INSPECT_INCARNATION";
export const BRINGUP_LOG_SECTION = "FLEET_INSPECT_BRINGUP_LOG";
/** How many bringup.log lines `fleet inspect` shows — short: this is a
 *  quick "did the last bring-up land cleanly" glance, not the full log
 *  provision.ts's own retry/degrade path already surfaces on failure. */
export const INSPECT_BRINGUP_LOG_LINES = 15;

export function inspectCmd(repo: string, tailLines: number = INSPECT_DEFAULT_TAIL_LINES): string {
  const n = Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : INSPECT_DEFAULT_TAIL_LINES;
  return (
    `if [ -d /workspace/${repo}/.git ]; then echo ${CHECKOUT_PRESENT}; else echo ${CHECKOUT_MISSING}; fi; ` +
    `p="$(tmux display-message -p -t ${INSPECT_TARGET} '#{session_name}:#{window_name} #{pane_current_command}' 2>/dev/null || true)"; ` +
    `case "$p" in ` +
    `"${INSPECT_TARGET} "*) echo "${PANE_LINE_PREFIX}\${p#${INSPECT_TARGET} }" ;; ` +
    `*) echo "${PANE_LINE_PREFIX}none" ;; ` +
    `esac; ` +
    // Maestro correction #2 — captured into a shell variable BEFORE
    // anything is echoed, never a bare `cat FILE || echo ''` glued straight
    // into this command's own stdout.
    `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
    `echo ${INCARNATION_SECTION}; echo "$FLEET_INC"; ` +
    `echo ${BRINGUP_LOG_SECTION}; ${bringupLogTailCmd(INSPECT_BRINGUP_LOG_LINES)}; ` +
    `echo ${TAIL_BEGIN}; ` +
    `tmux capture-pane -p -t ${INSPECT_TARGET} -S -${n} 2>/dev/null || true`
  );
}

export interface InspectSnapshot {
  checkoutExists: boolean;
  paneCommand: string | null;
  /** Issue #85: does `/workspace/.fleet/incarnation` exist and hold text? */
  incarnationPresent: boolean;
  /** Issue #85: the last INSPECT_BRINGUP_LOG_LINES lines of bringup.log,
   *  verbatim — empty string when the file has nothing (pre-feature
   *  container, or bring-up died before writing it). */
  bringupLogTail: string;
  tail: string;
}

export function parseInspectOutput(stdout: string): InspectSnapshot {
  const tailAt = stdout.indexOf(TAIL_BEGIN);
  const head = tailAt === -1 ? stdout : stdout.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : stdout.slice(tailAt + TAIL_BEGIN.length).replace(/^\r?\n/, "");
  const checkoutExists = head.includes(CHECKOUT_PRESENT);
  const paneLine = head.split("\n").find((line) => line.startsWith(PANE_LINE_PREFIX));
  const paneValue = paneLine ? paneLine.slice(PANE_LINE_PREFIX.length).trim() : "none";

  const incAt = head.indexOf(INCARNATION_SECTION);
  const logAt = head.indexOf(BRINGUP_LOG_SECTION);
  const incarnationRaw = incAt === -1
    ? ""
    : head.slice(incAt + INCARNATION_SECTION.length, logAt === -1 ? head.length : logAt).replace(/^\r?\n/, "").trim();
  const bringupLogTail = logAt === -1
    ? ""
    : head.slice(logAt + BRINGUP_LOG_SECTION.length).replace(/^\r?\n/, "").replace(/\n$/, "");

  return {
    checkoutExists,
    paneCommand: paneValue === "none" || paneValue === "" ? null : paneValue,
    incarnationPresent: incarnationRaw.length > 0,
    bringupLogTail,
    tail,
  };
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd apps/fleet && bunx vitest run test/studio.inspect.test.ts`
Expected: PASS.

- [ ] **Step 5: `do.ts` — wrap `runInspect`'s outcome with the DO's own stored `Observed`, zero exec (maestro correction #12)**

```ts
// apps/fleet/src/studio/do.ts
import { getObserved, type Observed } from "./observed";

/**
 * Board #91's `runInspect` stays TOTAL and exec-only, exactly as it is —
 * this wrapper is the ONE new thing issue #85 adds at this boundary: the
 * DO's own stored `Observed` record, attached with ZERO additional
 * container exec, on BOTH branches of `runInspect`'s own outcome (maestro
 * correction #12). A container-side failure (the exec deadline firing, or
 * a refusal) previously left an operator with only an error string —
 * `observed` now rides along regardless, since it costs nothing beyond a
 * storage read and is exactly the signal an operator needs most when the
 * live exec path itself is what just failed.
 */
async inspect(repo: string, tailLines?: number): Promise<InspectOutcome & { observed: Observed }> {
  const outcome = await runInspect(
    { recordedState: async () => (await this.ctx.storage.get<StudioStatus>(STATUS_KEY))?.state ?? null, exec: (cmd) => sbExec(this, cmd) },
    repo, tailLines,
  );
  const observed = await getObserved(this.ctx.storage);
  return { ...outcome, observed };
}
```

(The `recordedState`/`exec` wiring above matches whatever `deps()`-equivalent this method already builds — read the current `inspect()` method body before editing so only the return value changes, not the existing `InspectDeps` construction.)

- [ ] **Step 6: Wire the route and CLI — `observed` on BOTH response branches**

```ts
// apps/fleet/src/studio/routes.ts, ~474-480
if (!result.ok) {
  return Response.json({ ok: false, error: result.error, observed: result.observed });
}
return Response.json({
  ok: true,
  checkoutExists: result.snapshot.checkoutExists,
  paneCommand: result.snapshot.paneCommand,
  incarnationPresent: result.snapshot.incarnationPresent,
  bringupLogTail: redactSecrets(result.snapshot.bringupLogTail),
  tail: redactSecrets(result.snapshot.tail),
  observed: result.observed.session
    ? { ...result.observed, session: { ...result.observed.session, reason: redactSecrets(result.observed.session.reason ?? "") || null } }
    : result.observed,
});
```

```ts
// apps/fleet/cli/fleet.ts, ~314-331
async function cmdInspect(creds: Credentials, id: string): Promise<void> {
  const out = await requestInspect(studioUrl(creds, id, "/inspect"), accessHeaders(creds));
  if (!out.ok) {
    console.error(`fleet inspect: ${out.message}`);
    process.exit(1);
  }
  const body = out.body as
    | { ok: true; checkoutExists: boolean; paneCommand: string | null; incarnationPresent: boolean; bringupLogTail: string; tail: string; observed: Observed }
    | { ok: false; error: string; observed: Observed };
  // Maestro correction #12 — printed on BOTH branches, before the ok-check
  // returns/exits, so a container-side failure still shows what the DO
  // itself already knows.
  console.log(`replaced:     ${body.observed.replacedAt ? `yes, since ${body.observed.replacedAt}` : "no"}`);
  console.log(`unreachable:  ${body.observed.unreachableSince ? `yes, since ${body.observed.unreachableSince}` : "no"}`);
  console.log(`session:      ${body.observed.session ? `${body.observed.session.verdict} (via ${body.observed.session.via})` : "? (no verdict recorded yet)"}`);
  if (!body.ok) {
    console.error(`fleet inspect: ${body.error}`);
    process.exit(1);
  }
  console.log(`checkout:     ${body.checkoutExists ? "present" : "MISSING"}`);
  console.log(`pane:         ${body.paneCommand ?? "(studio:claude window not found)"}`);
  console.log(`incarnation:  ${body.incarnationPresent ? "present" : "MISSING"}`);
  console.log("--- bring-up log (tail) ---");
  console.log(body.bringupLogTail || "(empty)");
  console.log("--- pane tail ---");
  console.log(body.tail);
}
```

- [ ] **Step 7: Run the full route/CLI-adjacent suites**

Run: `cd apps/fleet && bunx vitest run test/studio.routes.test.ts test/studio.inspect.test.ts && bun run check`
Expected: PASS — confirm no existing `routes.ts` inspect test asserts on the exact JSON body shape in a way that a new key would break (`toEqual` on the whole body vs. field-by-field checks); update any such assertion the same way Task 6's Step 1 did for `runSessionRestore`. Confirm the `#92` refusal-string tests (`state === null`/`"stopped"`/exec-deadline messages) still assert on the EXACT same `error` text — this task only adds `observed` alongside it.

- [ ] **Step 8: Add a route-level test proving `observed` rides the container-side-failure path (maestro correction #12)**

```ts
// apps/fleet/test/studio.routes.test.ts — add near the existing inspect coverage
it("GET /studio/:id/inspect includes the DO's stored observed record even when the container-side exec fails (issue #85)", async () => {
  // ... seed a studio whose recorded state is "running" but whose exec
  // always times out/errors (reuse this file's own existing "container did
  // not answer" fixture setup), and seed observed.replacedAt beforehand ...
  const res = await SELF.fetch(`https://fleet.internal/studio/${STUDIO_ID}/inspect`);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.observed.replacedAt).not.toBeNull();
});
```

Run: `cd apps/fleet && bunx vitest run test/studio.routes.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite**

Run: `cd apps/fleet && bunx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/studio/inspect.ts apps/fleet/src/studio/do.ts apps/fleet/src/studio/routes.ts apps/fleet/cli/fleet.ts apps/fleet/test/studio.inspect.test.ts apps/fleet/test/studio.routes.test.ts
git commit -m "feat(cli): fleet inspect prints incarnation + bring-up log tail + the DO's stored verdict on every path (#85)"
```

---

## Task 10: Fixture test suite T1–T10, assembled and cross-referenced

**REVISED — see maestro correction #4.** T10's REAL proof moved to a DO-level test (Task 4); the CLI-level T10 fixture (Task 8) is kept only as a render-logic regression and is now cross-referenced as such, not as "the" op-lock proof. `T2` gained a `T2b` sibling (Task 8's cost-aware `unreachable` wording, both the with-snapshot and no-snapshot cases).

**Files:**
- No new production code. Read-and-verify only, plus filling any gap found.
- Modify (only if a gap is found): whichever test file is missing a fixture.

**Interfaces:** None new.

- [ ] **Step 1: Build the cross-reference table**

Run, from `apps/fleet/`:

```bash
grep -rn '"T1\b\|T1b\|T2:\|T2b:\|T3:\|T4:\|T5:\|T6:\|T7:\|T8:\|T9:\|T10:' test/cli.fleet.test.ts test/studio.observed.test.ts test/studio.observation-tick.test.ts
```

Confirm each of these exists with a test whose description literally names its fixture:

| Fixture | Spec expectation | Test file | Test name (from this plan) |
|---|---|---|---|
| T1 | READY `replaced 6m ago — not brought up` | `test/cli.fleet.test.ts` | `"T1: replacedAt 6m ago, readiness still provisioned"` (Task 8) |
| T1b | token adopted, no `replaced`, verdict `via: adopted` — detection half | `test/studio.observation-tick.test.ts` | `"adoption writes a token via the SAME exec as the tick itself — never a second exec"` (Task 4) |
| T1b | render half: no observed at all → no override | `test/cli.fleet.test.ts` | `"T1b: no observed at all (pre-feature row) — falls through to null"` (Task 8) |
| T2 | READY `unreachable … — wedged; recycle loses work since snap …` | `test/cli.fleet.test.ts` + `test/studio.observation-tick.test.ts` | `"T2: unreachableSince 6m ago, a snapshot on file — the message carries its own cost (maestro correction #11)"` (Task 8) / `"3 consecutive timeouts sets unreachableSince"` (Task 5) |
| T2b | READY `unreachable`, no snapshot on file — never a bare `→ recycle` | `test/cli.fleet.test.ts` | `"T2b: unreachableSince set, no snapshot on file at all — never a bare '→ recycle' (maestro correction #11)"` (Task 8) |
| T3 | READY `unverified 14m …` | `test/cli.fleet.test.ts` | `"T3: checkedAt 14m old, nothing else set"` (Task 8) |
| T4 | SESSION `resumed · from snap 61m old` | `test/cli.fleet.test.ts` | `"T4: resumed, snapshot 61m old at restore time"` (Task 8) |
| T5 | SESSION `LOST · had 412 turns` | `test/studio.observed.test.ts` | `"T5: no --continue, cwd correct, turnsBefore 412 -> lost, reason no --continue"` (Task 6) |
| T6 | SESSION `fresh` | `test/studio.observed.test.ts` | `"T6: no --continue, no prior history, no restored snapshot -> fresh"` (Task 6) |
| T7 | SESSION `LOST`, reason names the cwd | `test/studio.observed.test.ts` | `"T7: cwd is /container-server (clone refusal), history exists -> lost, reason names the cwd"` (Task 6) |
| T8 | SESSION suffix `snap 61m STALE` | `test/cli.fleet.test.ts` | `"T8: lastSnapshotAt 61m old, running -> STALE suffix"` (Task 8) |
| T9 | renders as today (stopped) | `test/cli.fleet.test.ts` | `"T9: stopped studio — no override regardless of observed fields"` (Task 8) |
| T10 (render-logic regression only) | no override for a non-running state | `test/cli.fleet.test.ts` | `"T10: render-logic only (see Task 4's DO-level test for the real op-lock proof) — a non-running state never gets an override"` (Task 8) |
| T10 (the REAL op-lock proof — maestro correction #4) | a fresh operation lock suppresses a replaced/adoption verdict even though the container reports no token | `test/studio.observation-tick.test.ts` | `"T10: a fresh operation lock suppresses a replaced/adoption verdict even though the container reports no token (the REAL op-lock proof — see Task 8's own T10 note)"` (Task 4) |

- [ ] **Step 2: Run every file in the table to confirm each named test exists and is green**

Run: `cd apps/fleet && bunx vitest run test/cli.fleet.test.ts test/studio.observed.test.ts test/studio.observation-tick.test.ts`
Expected: PASS, and every fixture ID above is visible in vitest's own test-name output (`--reporter=verbose` if the default reporter collapses names):

```bash
cd apps/fleet && bunx vitest run --reporter=verbose test/cli.fleet.test.ts test/studio.observed.test.ts test/studio.observation-tick.test.ts | grep -E "T1\b|T1b|T2:|T2b:|T3:|T4:|T5:|T6:|T7:|T8:|T9:|T10:"
```

- [ ] **Step 3: If any fixture ID is missing from the grep output, add it**

Add the missing test in the SAME file/task section the table above assigns it to (do not invent a 12th file). Re-run Step 2 until every row has a match.

- [ ] **Step 4: Commit (only if Step 3 found and fixed a gap)**

```bash
git add apps/fleet/test/<whichever file changed>
git commit -m "test(studio): fill fixture gap found in the #85 T1-T10 cross-reference"
```

If Step 3 found no gap, this task produces no commit — say so in the task's own completion report.

---

## Task 11: Integration test — a real staged restore through a heal, plus a verdict test per bring-up path

**REVISED — see maestro correction #14.** Adds a LOST case (a real restore that lands with no `--continue`/cwd mismatch), explicitly drives the restore through the SAME heal closure `syncSessionCycle` actually calls (not a bare `restartWithStorage` call standing in for it), and adds one verdict test PER bring-up path (`provision`, `recycle`, `heal`, `failover`) rather than only `restart`/`heal` — each path's own `via` and `recordBringupObservation`/`runAccountFailover` wiring is independently exercised, since a bug in one path's own call site (a forgotten `observedStorage` argument, for instance) would otherwise only ever be caught by whichever ONE path happened to already have a test.

**Files:**
- Modify: `apps/fleet/test/studio.replacement.test.ts`, `apps/fleet/test/studio.account-failover.test.ts`, `apps/fleet/test/studio.self-heal.test.ts` (or wherever the `#71` heal closure is already exercised — confirm with `grep -rl "healBareContainer\|restartStudio(\"heal\")" test/*.ts` before choosing)

**Interfaces:** None new — exercises Tasks 3/6's `provisionWithStorage`/`restartWithStorage`/`runAccountFailover` end to end, and Task 6's `syncSessionCycle`-driven heal closure.

**Design note (documented simplification):** `runSessionRestore` (`provision.ts`) never validates the TAR's internal structure — it treats `r2Get`'s bytes as opaque, slices them, and writes them to the container via `writeFile`. Structural/gzip validity is verified entirely on the CONTAINER side (`studio-bringup.sh`'s own restore-untar step), which is out of scope for this Worker-side test by Principle 3 (zero `container/` changes) and is not this test's job to re-prove. This test therefore uses a plain, deterministic `Uint8Array` fixture rather than building a real tar.gz — `test/studio.burn.test.ts`'s own `buildTar`/`gzipBytes` helpers exist for a DIFFERENT purpose (burn.ts's jsonl-extraction path genuinely gunzips/untars its input) and are not exported for reuse; copying ~80 lines of tar-header-writing machinery into this file to satisfy a code path that never inspects the bytes' structure would be scope creep, not thoroughness.

- [ ] **Step 1: Write the failing tests — RESUMED and LOST, both through the real heal closure**

```ts
// apps/fleet/test/studio.replacement.test.ts — add a new describe block
import { getObserved, type ObservedStorage } from "../src/studio/observed";
import { syncSessionCycle } from "../src/studio/do";

/**
 * Maestro correction #14 — drives the restore through the SAME heal
 * closure `syncSessionCycle` actually calls
 * (`() => this.restartStudio("heal")` in do.ts's own `syncSession()`
 * method), not a bare `restartWithStorage` call standing in for it. Confirm
 * this file's own `heal`-shaped fixture wiring (or `studio.self-heal.test.ts`'s)
 * before finalizing — the exact closure signature `syncSessionCycle`
 * expects for its `heal?` parameter must match, read from the current file.
 */
function healClosure(deps: ProvisionDeps, storage: StudioStorage & ObservedStorage, id: string, fleetRepoSlug: string) {
  return () => restartWithStorage(deps, storage, id, fleetRepoSlug, "heal", storage);
}

describe("restartWithStorage — a real staged restore through a heal, end to end (issue #85)", () => {
  it("RESUMED: stages a real restore (not skip), and records a resumed session verdict, driven via the real heal closure", async () => {
    const fakeSnapshot = new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar");
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const deps: ProvisionDeps & { cmds: string[] } = {
      sbExec: vi.fn(async (cmd: string) => {
        deps.cmds.push(cmd);
        if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
        if (cmd.includes("FLEET-SESSION-FOUND")) return { code: 0, stdout: scriptedProbe(true, "/workspace/acme-os"), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("restart must not refetch the blueprint");
      }),
      r2Get: vi.fn(async () => fakeSnapshot),
      writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
        writes.push({ path, bytes });
      }),
      cmds: [],
    };
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
    });

    const result = await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    expect(result.state).toBe("running");
    expect(writes.some((w) => w.path.endsWith("manifest.json"))).toBe(true);
    expect(writes.some((w) => w.path.includes("part-00"))).toBe(true);

    const observed = await getObserved(storage);
    expect(observed.session).not.toBeNull();
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.via).toBe("heal");
    expect(observed.session?.verdict).toBe("resumed");
  });

  it("LOST: a real restore lands, but the probe finds no --continue — records a LOST verdict with lifetime turns, never silently 'resumed' (maestro correction #14)", async () => {
    const fakeSnapshot = new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar");
    const deps: ProvisionDeps & { cmds: string[] } = {
      sbExec: vi.fn(async (cmd: string) => {
        deps.cmds.push(cmd);
        if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
        if (cmd.includes("FLEET-SESSION-FOUND")) return { code: 0, stdout: scriptedProbe(false, "/workspace/acme-os"), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
      r2Get: vi.fn(async () => fakeSnapshot),
      writeFile: vi.fn(async () => {}),
      cmds: [],
    };
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os`, burn: { turns: 88, tokens: 0 } }), roleEnv: STUDIO_ENV,
    });

    const result = await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    expect(result.state).toBe("running");
    const observed = await getObserved(storage);
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.verdict).toBe("lost");
    expect(observed.session?.turnsBefore).toBe(88);
    expect(observed.session?.reason).toBe("no --continue");
  });
});

/** A minimal, correctly-sectioned pane-probe stdout fragment — reused by
 *  both cases above so the fixture matches Task 6's real `parsePaneLeadProbe`
 *  section markers exactly, never hand-rolled per test. */
function scriptedProbe(hasContinue: boolean, cwd: string): string {
  return [
    "---FLEET-SESSION-FOUND---", "yes",
    "---FLEET-SESSION-CONTINUE---", hasContinue ? "yes" : "no",
    "---FLEET-SESSION-CWD---", cwd,
  ].join("\n");
}
```

- [ ] **Step 2: A verdict test per bring-up path — provision, recycle, heal, failover (maestro correction #14)**

```ts
// apps/fleet/test/studio.replacement.test.ts — add
describe("a session verdict is recorded on EVERY bring-up path (issue #85, maestro correction #14)", () => {
  it("provision: a fresh container with no history records fresh", async () => {
    const deps = provisionDeps(/* this file's own existing provision fixture, extended with a scripted probe answering no --continue, no history */);
    const storage = fakeStorageWithObserved({});
    await provisionWithStorage(deps, storage, cfg(), "rafarc21/fleetflare", "provision", storage);
    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("provision");
    expect(observed.session?.verdict).toBe("fresh");
  });

  it("recycle: via is \"recycle\", not the default \"restart\"", async () => {
    // Reuse this file's own recycleWithSync fixture (see the do.ts wiring —
    // provisionCore(c, "recycle") is what threads "recycle" through).
    const observed = await runRecycleFixtureAndGetObserved(); // this file's own existing recycle test harness, extended to read observed back
    expect(observed.session?.via).toBe("recycle");
  });

  it("heal: via is \"heal\" (covered above by the RESUMED/LOST tests — cross-referenced here for completeness)", () => {
    // See "restartWithStorage — a real staged restore through a heal" above.
  });

  it("failover: via is \"failover\", restore is always not-attempted", async () => {
    const storage = fakeStorageWithObserved(status({ claudeAccount: null }));
    const exec = vi.fn(async (cmd: string) =>
      cmd.includes("FLEET-SESSION-FOUND")
        ? { code: 0, stdout: scriptedProbe(true, "/workspace/acme-os"), stderr: "" }
        : cmd.includes("FLEET-BRINGUP-TOKEN")
          ? { code: 0, stdout: `---FLEET-BRINGUP-TOKEN---\nyes\n${scriptedProbe(true, "/workspace/acme-os")}`, stderr: "" }
          : execAnswering(MODAL_PANE, "printf ok")(cmd),
    );
    const deps: FailoverDeps = {
      exec, relaunch: async () => ({ code: 0, stdout: "", stderr: "" }),
      notify: async () => {}, now: () => NOW, accounts: [ACCOUNT_1, ACCOUNT_2],
    };
    await runAccountFailover(deps, storage, STUDIO_ID, async () => {}, storage);
    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("failover");
    expect(observed.session?.restore).toBe("not-attempted");
  });
});
```

(Wire each test's own fixture helpers from the file's EXISTING conventions — `provisionDeps`/`cfg`/the recycle test harness names are placeholders for whatever this file and `studio.account-failover.test.ts` already call them; read both files' own top sections before finalizing this step, the same instruction Task 3's own account-failover test addition already gives.)

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/fleet && bunx vitest run test/studio.replacement.test.ts test/studio.account-failover.test.ts`
Expected: FAIL before Tasks 3/6 land (this task is sequenced last in this plan precisely so it runs against the finished feature); once Tasks 1-9 are in place these tests should already be GREEN on first run — their job is to prove the wiring holds end to end, not to drive new production code.

- [ ] **Step 4: If any is not already green, fix the wiring (do not add new production surface)**

If a test fails after Tasks 1-9 are all committed, the failure is a wiring bug in one of those tasks (e.g. a missed parameter thread-through, or a bring-up path that never got its own `observedStorage` argument at its `do.ts` call site), not a missing feature — debug against the earlier tasks' own code, do not invent new logic here.

- [ ] **Step 5: Run the full suite, all lanes (maestro correction #14)**

Run: `cd apps/fleet && bunx vitest run && bun run check && bun run bun-test`
Expected: PASS on all three lanes.

- [ ] **Step 6: Note the live-verification boundary in the commit body**

This test proves the WORKER-side wiring (a real restore stages, a verdict records, per bring-up path) with a fake exec transport. It does **not** verify a live, batched container window — spec's own "Deploy and verify" step 6 explicitly defers that half to "the next batched container window" and says "do not claim it" in the PR. This plan's Task 11 satisfies the TEST half of that requirement only.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/test/studio.replacement.test.ts apps/fleet/test/studio.account-failover.test.ts
git commit -m "test(studio): a session verdict per bring-up path, incl. a real LOST restore through a heal (#85)"
```

---

## Self-Review

**This section was re-walked in full after applying maestro's 15 corrections (2026-09-24, board comment 5814498930).** The original self-review below is superseded where it conflicts with a correction; superseding notes are inline.

Walked the spec section by section against the tasks above:

- **Problem shapes 1-5:** shape 1 (stale after replacement) → Tasks 3+4 (incarnation, now with the correction #3 fix so `replaced` does not self-clear) + Task 8 (`replaced` override). Shape 2 (wedged) → Task 4's merged reachability half (deadline-per-exec, correction #5) + Task 8 (`unreachable` override, now cost-aware per correction #11). Shape 3 (stale restore source) → Task 6's `snapshotAgeS` (now read BEFORE the op per correction #8, with an R2 fallback) / `from snap <age> old` rendering (Task 8, T4). Shape 4 (blank lead, silent resumed-vs-fresh) → Task 6 in full (verdict recorded from the live process via the correction #9-redesigned probe, `runSessionRestore`'s result kept). Shape 5 (DO-side failure) → Task 8's `unverified` override (readiness `checkedAt` staleness, computed CLI-side so it catches a frozen/failing DO too) AND Task 9's correction #12 addition (the DO's own stored `observed` now rides the inspect response on the failure path too, which is exactly a shape-5 DO-side-failure moment) — `#92`'s inspect error strings themselves are explicitly left untouched (Global Constraints), and Task 9 only ADDS fields, never edits those strings.
- **Goal / age budgets:** `replaced` within one ship tick (Task 4, every 30s tick — now also skipped while an operation lock is fresh, per correction #4, which is correct because a bring-up in flight is not a real replacement), `unreachable` within 3 ticks (Task 4's merged reachability half, deadline now wraps only the exec per correction #5), everything else within 660s (Task 8's `UNVERIFIED_AFTER_SECONDS`). Covered.
- **Principle 1 (observation time, reader computes age):** every `Observed` timestamp is an ISO string; `readyOverride`/`formatSession` compute age at render time via `formatAge`, never store a pre-rendered string. Covered, unaffected by any correction.
- **Principle 2 (observation-only):** confirmed no task calls a heal/restart/wake/recycle trigger from a new signal — Task 4's ship tick only writes `observed`; the pre-existing `#71` heal path (`healBareContainer`) is untouched by any task in this plan except passing `"heal"` as a label through an existing call. Correction #7's adoption verdict is ALSO observation-only — it records a session verdict, it does not trigger anything.
- **Principle 3 (Worker + CLI only):** no task touches `apps/fleet/container/`; explicitly called out per-task and in Global Constraints.
- **Principle 4 (own storage):** `observed` is its own DO key (Task 1) and its own optional D1 field (Task 2), never read/written inside `checkAndRecordReadiness`'s `STATUS_KEY` cycle — confirmed no task modifies that function. Correction #1 closed the gap where `observed` was NEVER ACTUALLY ATTACHED to any `StudioStatus` reaching D1 — `withObserved` (Task 2) is now the one seam every outbound status passes through.
- **Principle 5 (unknown is neutral):** `SessionVerdict` includes `"unknown"` (pane probe failed, OR no lead process found — correction #9's `found: false` case) with a `reason`; `formatSession` (correction #8) renders `"?"` for BOTH "no session at all" and "verdict unknown" — the literal word "unknown" is never rendered, and the snapshot-age suffix is now always shown regardless. Covered, strengthened.
- **PR1 Signal 1 (incarnation token):** Task 3 (write, now newline-safe per correction #2) + Task 4 (ship-tick read/compare/adopt, now correctly non-self-clearing per correction #3, folded into one exec per correction #6, and op-lock-guarded per correction #4). Covered, including the "adoption, not an alarm" case (T1b) and its verdict (correction #7, Task 6's own step).
- **PR1 Signal 2 (reachability):** Task 4's merged reachability half, reusing `#92`'s `INSPECT_EXEC_MS` verbatim (not a second constant, but now wrapping only the exec per correction #5 — a nonzero exit/R2 blip never counts). Covered.
- **PR1 Signal 3 (session verdict):** Task 6 — live `/proc` read via the direct child NAMED `claude` of `studio:claude`'s verified pane_pid (correction #9), `runSessionRestore`'s outcome kept via the correction #10 callback (not a widened return type — issue #90 conflict avoided), `burn.turns` prior-history check, `lastSnapshotAt`-derived snapshot age (now read before the op, correction #8), token write + probe folded into one exec (correction #6), reachability reset on success (correction #13). Covered.
- **PR1 Signal 4 (snapshot freshness):** Task 7, `lastSnapshotAt` set on `syncSessionTick`'s successful R2 put, documented interpretation of "adds no write" (own key, own merge call, same 300s cadence) — confirmed (Task 7's own note) that it composes with Task 2's `withObserved` wrapping to actually reach D1, which the ORIGINAL draft never wired. Covered.
- **Storage section (D1 mirror, write-on-transition):** Task 2 (the `withObserved` D1 wiring correction #1 added, closing the gap where nothing ever populated `StudioStatus.observed` before a D1 write) + the merge-only-on-change patches in Task 4 (`incarnationPatch`'s no-op branches when nothing changed, rewritten per correction #3) + explicit out-of-cadence D1 writes on a `replaced`/`unreachable` transition or an adoption (Task 4) and on a bring-up verdict (Task 6, via `deps.recordStudio`'s existing calls already wrapped by correction #1's `withObserved`). Covered.
- **Rendering section:** `readyOverride`/`formatSession` in `cli/readiness-format.ts` (Task 8, now cost-aware per correction #11 and never-bare per correction #8), `formatTable`'s new SESSION column (Task 8), `READY_CAVEAT`/`cli-args.ts`'s `ls` summary updated (Task 8, correction #11), `fleet inspect`'s incarnation + bringup.log tail + the DO's own stored verdict on both paths (Task 9, correction #12). Covered.
- **Error handling section:** every new exec (incarnation write, pane probe, ship tick, bring-up observation) is wrapped in try/catch or a deadline race and degrades to a recorded `unknown`/log-and-continue, never an uncaught throw into the alarm — Tasks 3, 4, 6. The token-write-failure "verdict reads ?, ship tick then reports replaced" behavior is exercised directly (Task 3's "a failed incarnation write does not fail the restart, and leaves incarnation unset" test, which composes with Task 4's "missing token -> replaced" detection on the NEXT tick — now correctly staying replaced, not self-clearing, per correction #3).
- **Tests T1-T10 + integration:** Task 10's cross-reference table confirms all fixture IDs exist, with T10 now correctly split into a render-logic regression (Task 8, CLI-level) and the REAL op-lock proof (Task 4, DO-level, correction #4); Task 11 is the integration test (a real RESUMED staged restore AND a real LOST one, both driven through the actual heal closure, plus a verdict test per bring-up path — correction #14).
- **Deploy and verify:** left to the deploying maestro, not this plan (Task 11's own Step 6 says so explicitly) — this plan produces no deploy/verify steps of its own, matching "PR1 needs nothing beyond this spec" from the Delivery section (a plan, not a deploy runbook).

**All 15 maestro corrections, confirmed present in the task text above (not just this summary):**
1. D1 write wiring — Task 2, Steps 8-12 (`withObserved`), plus Task 4/6's explicit transition writes.
2. Incarnation newline — Task 3 Step 0 (`writeIncarnationCmd`), Task 4 Step 3 (`shipTickCmd`'s read), Task 9 Step 3 (`inspectCmd`'s read), plus a dedicated real-shell Bun test (Task 4 Step 1/`test/bun/incarnation-newline.test.ts`).
3. `incarnationPatch` full rewrite, never self-clears — Task 4 Step 4, with the multi-tick sequence test in Step 5.
4. Op-lock guard — Task 4's `runShipTickWithObservation` (re-reads `OPERATION_KEY` after the exec), T10 moved to a DO-level test, Task 8's T10 relabeled.
5. Deadline the exec, not the tick — Task 4's `withExecDeadline` wraps `ShipDeps.exec`, `ExecUnreachableError` distinguishes a real timeout from a resolved-but-bad response.
6. Fold every new exec — the adoption write folded into the ship-tick exec (Task 4), the bring-up token write + probe folded into one exec (Task 6's `bringupObservationCmd`).
7. Adoption verdict `via: "adopted"` — Task 6's own Step 9, extending Task 4's adoption branch.
8. Snapshot age timing + R2 fallback + never-bare `formatSession` — Task 6 Step 5 (`lastSnapshotAtBefore` read by the wrapper, `ProvisionDeps.r2Head?`), Task 8's `formatSession` rewrite.
9. Pane probe redesign — Task 6 Step 3 (`paneLeadProbeCmd`/`parsePaneLeadProbe`/`PaneProbeResult`), with the real-tmux Bun test in Step 11.
10. `onRestoreOutcome?` callback, unwidened signatures — Task 6 Step 4.
11. Wording — Task 8 (`readyOverride`'s `unreachable` cost, `READY_CAVEAT`'s inspect-DO-side-fail caveat, `cli-args.ts`'s `ls` summary).
12. Inspect stored-verdict lines, zero exec, both paths — Task 9 Step 5-6.
13. Bring-up resets reachability — Task 6's `recordBringupObservation` patch (Step 5) and `failover.ts`'s post-success block (Step 6).
14. Test requirements — injectable deadline (Task 4/5, `deadlineMs` parameter), scripted probe + LOST case + verdict-per-path (Task 11), bun-test run in Tasks 6/9 (their own Step 12/full-suite steps run `bun run bun-test` explicitly, alongside Task 8/9's own CLI-focused vitest runs).
15. `getObserved`'s existing behavior confirmed sufficient — noted at the top of the corrections index, no change to Task 1.

**Signature-consistency ripple from correction #10 (the most invasive single change):** `runProvision`'s return stays `Promise<{ status, roleEnv, keepAlive }>` and `runRestart`'s stays `Promise<StudioStatus>` — IDENTICAL to today's real code, confirmed by reading `provision.ts` directly (not assumed) before drafting Task 6. Every caller of either function (`provisionWithStorage`/`restartWithStorage`, the only two) destructures/uses the return EXACTLY as they do today — no downstream task (7, 8, 9, 10, 11) ever assumed the old widened-return-type design, because that design was never committed; it only ever existed in the original draft of Task 6, replaced in place before any later task could depend on it. `ProvisionDeps.onRestoreOutcome?`/`.r2Head?` are both optional, additive fields — every existing test's `ProvisionDeps` literal (Task 3's `restartDeps`, Task 11's own fixtures, etc.) is unaffected by their addition.

**Gaps found and fixed during THIS correction pass (on top of the original draft's own gap list, which is preserved below for history):**
- `PaneProbeResult` losing its `argv` field (correction #9) ripples into `computeSessionVerdict`'s call sites (Task 6 Step 3/5/6) and the adoption verdict (Task 6 Step 9) — all rewritten together in this pass, confirmed no stale `probe.argv` reference remains anywhere in the corrected text.
- `incarnationPatch`'s return type changed from `{ patch, needsAdoptionWrite }` to a bare `Partial<Observed>` (correction #3 + #6's fold-in eliminating the second-exec case entirely) — every call site (`runShipTickWithObservation`, Task 4) and every test (Task 4 Step 5, Task 10's cross-reference) uses the new shape; confirmed no leftover `.needsAdoptionWrite` destructure anywhere in the corrected text.
- `bringupObservationCmd`'s introduction (correction #6) means Task 3's OWN narrower `recordIncarnation`/single-exec `writeIncarnationCmd`-only helper is explicitly superseded twice now — once by the original draft's Task 6 Step 5, and that superseding text itself rewritten in this pass to reflect the folded-exec design. Both supersession notes point at the same two functions (`provisionWithStorage`/`restartWithStorage`), so there is exactly one final version of each, not two competing drafts.

**Original draft's own gap list (unaffected by this correction pass, preserved for history):**
- `SYNC_SESSION_SECONDS` was assumed importable from `do.ts` into `cli/readiness-format.ts`; `do.ts` imports `"@cloudflare/sandbox"` and is not importable from a Bun-free CLI module. Fixed by moving the constant to `session-sync.ts` (Task 8, Step 1) — the file both `do.ts` and the CLI already can/do import cleanly.
- Widening `provisionWithStorage`/`restartWithStorage`/`runAccountFailover`/`syncSessionCycle`'s existing storage-typed parameters to require `& ObservedStorage` would have broken every existing test file's local `fakeStorage()` cast (7+ files). Fixed by adding Observed access as a new, trailing, OPTIONAL parameter everywhere instead — zero ripple to any existing test, matching this codebase's own established "optional dependency, absence = no-op" idiom.
- `session-sync.ts`'s `SyncResult` did not need a new field for Task 7 — `skipped === undefined` already unambiguously means the R2 put succeeded (the only place `skipped` is ever assigned returns BEFORE the put). Documented as a design note in Task 7 rather than adding a redundant field.
- `formatCheckedAt`'s age-bucketing logic would have been reimplemented a third time for the READY overrides and the SESSION column (each with a DIFFERENT suffix convention). Fixed by factoring `formatAge(seconds)` out of `formatCheckedAt` (Task 8, Step 4) and having all three call sites share it.
- `runSessionRestore`'s widened return breaks 4 existing whole-object `toEqual` assertions in `test/studio.session.test.ts`; Task 6 Step 1 updates all four explicitly rather than leaving them to fail silently in a later task.

**Placeholder scan:** no "TBD"/"similar to Task N"/"add appropriate handling" found in the final draft — every step above shows the actual diff or the actual new file content. The two `void via;` lines in Task 3 (unchanged by this correction pass — Task 3 itself was not touched, only Task 3's own Step 3 `recordIncarnation` helper, still a real, working, deliberate stepping stone) remain exactly where the original draft put them, still explicitly marked as superseded by Task 6's own (now corrected) Step 5 `recordBringupObservation`, which threads `via` directly — confirmed the supersession note (line ~2299 of this document) was itself re-verified during this pass and still correctly names the two functions Task 6's REVISED Step 5 replaces.

**Type/signature consistency check (re-run after the correction pass):** `Observed`/`ObservedSession`/`BringupVia`/`RestoreOutcome`/`SessionVerdict` (Task 1, unchanged — correction #15 confirmed) are used with IDENTICAL field names across Tasks 2, 4, 6, 7, 8, 9 — cross-checked `incarnation`, `replacedAt`, `execFailures`, `unreachableSince`, `lastSnapshotAt`, `session.{verdict,at,via,restore,snapshotAgeS,turnsBefore,reason}` at every call site drafted above. `mergeObserved`/`getObserved`'s signatures (Task 1) match every call site in Tasks 3, 4, 6, 7. `PaneProbeResult`'s NEW shape (`{ ok, found, hasContinue, cwd, error }`, correction #9) is used identically everywhere it appears — Task 6's `computeSessionVerdict`/`computeAdoptedVerdict`/`parsePaneLeadProbe`/`recordBringupObservation`, `failover.ts`'s post-success block, Task 4's adoption-verdict extension — no stale `{ ok, argv, cwd, error }` reference remains. `incarnationPatch`'s new signature (`(before, containerToken, now): Partial<Observed>`) is used identically at its one call site (`runShipTickWithObservation`, Task 4) and in every test (Task 4 Step 5, Task 10). `runProvision`/`runRestart`'s UNCHANGED signatures (correction #10) are used identically at their one call site each (`provisionWithStorage`/`restartWithStorage`, Task 6 Step 5) — confirmed no downstream task destructures a `restoreOutcome` field off either function's own return.
