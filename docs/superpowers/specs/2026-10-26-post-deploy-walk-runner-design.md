# Post-deploy cloud staging walk runner — design (issue #1348)

Refs #1134. Sprint 5, same epic as #1342-#1347 (gate e2e image, browser-leg
semantics, AI leg harness, gate-scoped secrets, CF Browser Run spike).

## 1. Problem

After a consumer repo deploys to staging, nothing walks the live site logged
in as a real user. The gate (pre-merge) never holds cloud credentials and
never runs against a deployed URL; this is the post-deploy counterpart: run
a small set of "walk" checks against staging, authenticated, and leave
evidence an operator or a later gate can read.

## 2. Scope

This issue: the runner itself — `apps/fleet/src/walk/**` — pure logic, no
Worker wiring, no secret-reading code, no browser engine.

Explicitly NOT this issue (owned elsewhere, stubbed here):
- **Auth (#1346, "T5")**: how a TEST account's browser storage state
  reaches the container. T5 owns gate-scoped secret delivery. This runner
  takes storage state through an injected `getStorageState()` dependency —
  never reads an env var or secret store itself.
- **Engine (#1347, "T6")**: in-container Chrome vs CF Browser Rendering.
  The spike has not picked a winner. This runner takes a `WalkEngine`
  dependency — one `runItem` method — and is engine-agnostic.
- **Walk-gate schema**: the consumer maestro owns the real item/sweep JSON
  shape. Until it arrives, §4 below is a stub (`schemaVersion: "stub-v0"`),
  documented as non-final so a later PR can swap it without touching the
  runner's control flow.
- **R2 binding, Worker route, cron/trigger that invokes the runner**: follow-up
  wiring once T5/T6 land and the real schema arrives.

## 3. Design

Dependency-injected, same shape as `gate/run-leg.ts`'s `RunLegDeps` /
`GateContainer`: every I/O boundary (auth, engine, storage write, clock) is a
structural interface passed in, so `runSweep` itself is pure control flow and
unit-testable with fakes — no network, no real R2 binding, no real browser.

```ts
interface WalkAuthProvider {
  /** undefined = no storage state available. Never throws on "missing";
   *  a throw is reserved for a provider's own transport failure. */
  getStorageState(): Promise<string | undefined>;
}

interface WalkEngine {
  /** storageState is never logged, never put in a thrown message by this
   *  engine's own convention — callers additionally redact (§5). */
  runItem(item: WalkItem, storageState: string): Promise<WalkAttempt>;
}

interface WalkAttempt { state: "success" | "failure" | "error"; description?: string }

interface WalkEvidenceSink {
  putEvidence(key: string, body: string): Promise<void>;
}

interface WalkDeps {
  auth: WalkAuthProvider;
  engine: WalkEngine;
  sink: WalkEvidenceSink;
  now?: () => string; // ISO timestamp, injectable for tests
}
```

### 3.1 Control flow (`runSweep`)

1. Call `auth.getStorageState()` once, before any item runs.
2. **Missing (`undefined`)**: every item gets a `"did-not-run"` evidence
   record with the same reason; the engine is never called (no storage
   state to hand it); the sweep's aggregate state is `"did-not-run"`. This
   is the one RED path this issue's tests pin (see #6).
3. **Present**: run items in order (sibling tasks' browser/AI legs run in
   parallel inside the gate container; this runner stays sequential —
   staging walks are a handful of items, not a fan-out of legs, and
   sequential keeps one run's evidence trivially orderable). Each item's
   `engine.runItem` outcome maps straight to its evidence record; a thrown
   error from the engine becomes `"error"` (same "thrown is infra, returned
   is a verdict" split `gate/verdict.ts` already draws for legs).
4. Aggregate the sweep state same precedence `gate/verdict.ts` uses for legs:
   any `"error"` wins, else any `"failure"`, else any `"did-not-run"`, else
   `"success"`.
5. Write one evidence JSON per item, then one `sweep.json`, through
   `sink.putEvidence`. Item keys first: a crash after some items but before
   the sweep summary still leaves per-item evidence behind.

### 3.2 R2 key shape

`walk/<sweepId>/items/<itemId>.json`, `walk/<sweepId>/sweep.json`. Plain
keys, no presigned URL — same reasoning `leg-env.ts` already states for gate
legs: a presigned URL is itself a bearer credential. The real binding and
prefix are Worker-side wiring, out of this issue's boundary; `WalkEvidenceSink`
is the seam a follow-up PR implements against the real `R2Bucket`.

## 4. Evidence schema (STUB — supersede on arrival, do not extend in place)

```ts
interface WalkItemEvidence {
  schemaVersion: "stub-v0";
  sweepId: string;
  itemId: string;
  url: string;
  state: "success" | "failure" | "error" | "did-not-run";
  description?: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
}

interface WalkSweepEvidence {
  schemaVersion: "stub-v0";
  sweepId: string;
  state: "success" | "failure" | "error" | "did-not-run";
  startedAt: string;
  finishedAt: string;
  items: { itemId: string; state: WalkItemEvidence["state"]; key: string }[];
}
```

When the consumer maestro's real schema arrives: bump `schemaVersion`, map
this runner's internal `WalkAttempt` to the new shape at the
`makeItemEvidence`/`makeSweepEvidence` boundary (`evidence.ts`). The control
flow in §3.1 does not change — only the JSON shape written to R2.

## 5. Secret hygiene

`storageState` is a bearer credential (a logged-in session). Three guards:

1. It is never passed to `console.log`/`console.error` directly — every log
   call in this module logs structured fields (`itemId`, `state`,
   `description`), never the raw string.
2. `redact(text, secret)` scrubs an exact-substring match of the live
   storage state out of any `description` before it is written to evidence
   or logged, defense-in-depth against an engine that echoes it in an error
   message. Applied at the one seam (`evidence.ts`) every description
   passes through on the way to disk/log, not re-applied ad hoc per call
   site.
3. Never printed on the missing-storage-state path either, since there is
   nothing to redact there — the reason string is a fixed constant, not
   built from input.

## 6. Tests (this issue's three, from the task body)

- **missing storage state -> RED did-not-run**: `auth.getStorageState()`
  resolves `undefined` -> every item's evidence is `"did-not-run"`, sweep
  state is `"did-not-run"`, and the fake engine's `runItem` is never called
  (asserted via a call-count spy, not a mock of this module's own code —
  `WalkEngine` is the system boundary this runner depends on, same class of
  boundary `test-lies-check` already exempts).
- **item evidence shape matches schema**: every written item JSON parses and
  has exactly the stub's required fields, right types, `schemaVersion:
  "stub-v0"`.
- **secret absent from logs**: run a sweep with a distinctive fake storage
  state string; assert it appears in none of: console.log/error calls
  (spied), item evidence JSON, sweep.json. Covers both the missing-state and
  present-state paths, and a thrown engine error whose message happens to
  include the secret (redaction guard, mutation-tested — see PR body).

## 7. Open dependencies

- #1346 (T5): real `WalkAuthProvider` wired to gate-scoped secrets.
- #1347 (T6): real `WalkEngine` wired to whichever benchmark wins.
- Consumer maestro: real walk-gate schema, superseding §4.
- Follow-up: Worker route/cron that builds `WalkDeps` from real bindings and
  calls `runSweep` after a consumer staging deploy.
