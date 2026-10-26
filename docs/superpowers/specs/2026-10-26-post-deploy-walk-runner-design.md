# Post-deploy cloud staging walk runner — design (issue #1348)

Refs #1134. Sprint 5, same epic as #1342-#1347 (gate e2e image, browser-leg
semantics, AI leg harness, gate-scoped secrets, CF Browser Run spike).

v1 revision (review r1, 2026-10-26): replaces the original stub-v0 schema
with the consumer maestro's real walk-evidence schema (issue #1348 comment
6412380632) and fixes two review findings in the control flow and
redaction. §4 and §5 are rewritten; §3's control flow changed shape (two
evidence producers, not one aggregation).

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
  dependency — a route console sweep plus one `runItem` method — and is
  engine-agnostic. The real CDP capture (console/network events,
  screenshots, AI-turn harness) is T6's, not this runner's.
- **R2 binding, Worker route, cron/trigger that invokes the runner**:
  follow-up wiring once T5/T6 land.
- **Gate rules** (screenshot size/hash uniqueness, red-chip detection, step
  counts, zero-console-error enforcement): these decide whether one
  `WalkAttempt` *is* a pass or a fail. That decision is the engine's (T6) to
  make before it returns; this runner persists whatever verdict it is
  handed, it does not re-derive one. §4.3 restates the rules as given, for
  whoever builds that engine.

## 3. Design

Dependency-injected, same shape as `gate/run-leg.ts`'s `RunLegDeps` /
`GateContainer`: every I/O boundary (auth, engine, storage write, clock) is a
structural interface passed in, so `runSweep` itself is pure control flow and
unit-testable with fakes — no network, no real R2 binding, no real browser.

```ts
interface WalkAuthProvider {
  /** undefined, "", or a Playwright storage state with no cookies and no
   *  origin localStorage entries all mean "no usable auth" (storage-
   *  state.ts's hasUsableAuth). A provider throws only for its own
   *  transport failure, never to signal "no credential". */
  getStorageState(): Promise<string | undefined>;
}

interface WalkEngine {
  /** The route console sweep behind sweep.json's nominal shape. */
  sweepRoutes(): Promise<{ routes: RouteEvidence[]; signatures: SweepSignature[] }>;
  /** May throw; runSweep treats a throw as this item's error — no item
   *  file is written for it (v1 defines no "error" result value). */
  runItem(item: WalkItem, storageState: string): Promise<WalkAttempt>;
}

interface WalkEvidenceSink {
  putEvidence(key: string, body: string): Promise<void>;
}

interface WalkDeps {
  auth: WalkAuthProvider;
  engine: WalkEngine;
  sink: WalkEvidenceSink;
  verifier: string; // v1 item evidence's "verifier" field — this run's agent label
  log: WalkLog;      // structured fields only, never raw captured text
  now?: () => string; // ISO timestamp, injectable for tests
}
```

### 3.1 Control flow (`runSweep`)

Two evidence producers, not one aggregation: v1's `sweep.json` is a
standalone route console sweep, unrelated to whether any checklist item
passed — it is not an aggregation of item results the way stub-v0's was.

1. Call `auth.getStorageState()` once, before anything else.
   - **Throws**: no secret was ever obtained. Write `sweep.json` in its
     abnormal shape (`state: "error"`, `reason` = the error text) instead of
     writing nothing (review r1 item 5) and return `{ state: "error" }`. The
     engine is never called.
   - **No usable auth** (`hasUsableAuth` false — undefined, `""`, or a
     credential-less storage state, review r1 item 2): write `sweep.json` in
     its abnormal shape (`state: "did-not-run"`) and return
     `{ state: "did-not-run" }`. The engine is never called. No item files
     are written — v1's item schema has no "did-not-run" result value, so
     there is nothing valid to write per item; the sweep-level record is the
     one place this outcome is recorded.
2. **Usable auth present**: extract every individual secret value
   (`storage-state.ts`'s `secretValues`) once, for write-time redaction
   (§5).
   - Run every checklist item in order (sibling tasks' browser/AI legs run
     in parallel inside the gate container; this runner stays sequential —
     staging walks are a handful of items, not a fan-out of legs, and
     sequential keeps one run's evidence trivially orderable). A thrown
     `runItem` writes no file for that item (same "thrown is infra, not a
     verdict" split `gate/verdict.ts` draws for legs) and contributes
     `"error"` to this run's own aggregate; a returned `WalkAttempt` is
     written verbatim as `item-<role>-<idx>-<id>.json` and contributes
     `"success"` (pass) or `"failure"` (fail).
   - Call `engine.sweepRoutes()` once and write `sweep.json` in its nominal
     shape. A throw there writes the abnormal shape instead (`state:
     "error"`) and contributes `"error"` to the aggregate — same
     thrown-is-infra split.
3. The run's own state (`WalkRunState` — never a v1 schema field) is
   `aggregateSweepState` over every item outcome plus the route-sweep
   outcome: any `"error"` wins, else any `"failure"`, else any
   `"did-not-run"`, else `"success"`. An empty outcome list (a walk with zero
   checklist items AND a failed route sweep... in practice: zero items is
   not itself `"did-not-run"` if auth was usable and the route sweep ran —
   `aggregateSweepState([])` only fires on the truly empty case, which
   `runSweep` never produces once past the auth gate, since `sweepRoutes`
   always contributes one outcome).

### 3.2 R2 key shape

`walk/<fingerprint>/sweep.json`, `walk/<fingerprint>/item-<role>-<idx>-<id>.json`
— one flat directory per walk, matching the consumer maestro's "evidence dir
per walk" framing (comment 6412380632) exactly, not a nested `items/`
subfolder. Plain keys, no presigned URL — same reasoning `leg-env.ts`
already states for gate legs: a presigned URL is itself a bearer credential.
Every key segment (`fingerprint`, `role`, `id`) is validated against a safe
charset before use (review r1 item 5) — an item's `role`/`id` are
schema-supplied, not trusted verbatim into a path. The real binding and
prefix are Worker-side wiring, out of this issue's boundary;
`WalkEvidenceSink` is the seam a follow-up PR implements against the real
`R2Bucket`.

## 4. Evidence schema v1 (consumer maestro, issue #1348 comment 6412380632 — copied verbatim)

### 4.1 `sweep.json` — nominal shape (a console sweep of main routes on the served build)

```ts
interface RouteEvidence {
  url: string;
  finalUrl: string;
  navError: string | null;
  consoleErrors: ConsoleEvent[];      // { type, text, source, at }
  consoleWarnings: ConsoleEvent[];
  debugLogs: DebugLog[];              // { type, text }
  exceptions: ExceptionEvent[];       // { text, url }
  badRequests: RequestFault[];        // { method, path, status, errorText, type }
  canceledRequests: RequestFault[];   // same shape + canceled: true
  screenshot: string;                 // abs png path
}
interface SweepSignature { sig: string; count: number; routes: string[] }

interface WalkSweepEvidenceNominal {
  fingerprint: string; // build id
  at: string;          // UTC ISO
  routes: RouteEvidence[];
  signatures: SweepSignature[];
}
```

Capture per route via CDP: `Runtime.enable` + `Log.enable` + `Network.enable`.
`consoleAPICalled` error/warning/assert -> `consoleErrors`/`consoleWarnings`.
`log`/`info`/`debug` whose text starts `[tag]` -> `debugLogs`.
`exceptionThrown` -> `exceptions`. `responseReceived` status>=400 and
`loadingFailed` with `canceled:false` -> `badRequests`. `loadingFailed` with
`canceled:true` -> `canceledRequests`.

### 4.2 `item-<role>-<idx>-<id>.json` — one per checklist item

```ts
interface WalkStep { n: number; screenshot: string; observed: string } // verbatim UI text
interface AiTurn { prompt: string; reply: string; chips: string[] }
interface ConsoleCapture {
  consoleErrors: ConsoleEvent[]; consoleWarnings: ConsoleEvent[]; debugLogs: DebugLog[];
  exceptions: ExceptionEvent[]; badRequests: RequestFault[]; canceledRequests: RequestFault[];
}

interface WalkItemEvidence {
  fingerprint: string; // same build id as sweep.json
  verifier: string;    // agent label
  at: string;          // UTC ISO
  result: "pass" | "fail";
  steps: WalkStep[];
  console: ConsoleCapture;
  ai: { turns: AiTurn[] };
  accounts: string[];
  failReason?: string; // only if fail
}
```

### 4.3 Gate rules (restated as given — this PR does not implement them; the real engine, T6, must satisfy them before returning a `WalkAttempt`)

- `fingerprint` == the build served now; walk data carries the same
  fingerprint + git sha.
- `result: "pass"` only; `steps.length` >= the item's configured step count;
  every screenshot exists, is a PNG, >=20KB, >=320px wide, and its sha256 is
  unique across the whole walk; every `observed` is non-empty.
- Zero entries in `consoleErrors`, `consoleWarnings`, `debugLogs`,
  `exceptions`, `badRequests`. `canceledRequests` is ignored. An allowlist
  row needs `{ pattern, why, issue }`.
- `kind: ai` items: >=3 turns, distinct prompts, non-empty replies, no red
  chip (regex `I couldn.t|couldn.t save|Something went wrong` + localized
  equivalents) unless the item expects one.
- `kind: two-account` items: >=2 distinct accounts.
- The route sweep covers the main list, templates, settings, and one
  workspace route.

### 4.4 Harness facts (measured, restated as given — for whoever builds the real engine)

- `Log.enable` replays old entries each round — dedupe by timestamp; count
  HTTP faults from Network events only.
- In-page resource timing misses 503/429 — CDP only.
- Headless needs a real UA and `navigator.webdriver` false.
- AI turns in automation need an App Check debug token via an init script.

### 4.5 This runner's own abnormal `sweep.json` (not a v1 field — see §3.1)

```ts
type WalkSweepEvidence =
  | WalkSweepEvidenceNominal
  | { fingerprint: string; at: string; state: "did-not-run" | "error"; reason: string };
```

v1 defines no state for "the walk never produced route evidence" (missing
auth, or the auth provider / route sweep itself failing). Rather than force
one of its enum values, `runSweep` writes this minimal record instead —
documented here so a schema consumer downstream knows to expect either
shape, discriminated by the presence of `routes`.

## 5. Secret hygiene

A storage state's cookie values and origin localStorage values are bearer
credentials (a logged-in session). Review r1 item 3: a probe against the
original design (one `redact(text, wholeBlobSecret)` call matching only an
exact whole-blob substring) leaked 5 of 6 vectors — a lone cookie value
pulled out of the blob, the value JSON-escaped, URL-encoded, or base64'd,
and the value sitting inside a multi-line blob. Fixed:

1. **Per-value, not per-blob** (`storage-state.ts`'s `secretValues`): every
   individual cookie value and origin localStorage value is extracted from
   the live storage state once, at the top of `runSweep`. A lone leaked
   value now matches directly — the old failure mode was redacting against
   the *whole JSON blob* as "the secret", which a substring of it can never
   equal.
2. **Every encoding, per value** (`redact.ts`'s `redactValues`): each value
   is scrubbed in four forms — raw, JSON-string-escaped (nested inside
   another JSON string), URL-encoded, and base64 — independent of whatever
   text surrounds it, so a value embedded in a multi-line blob (vector 5) is
   caught the same as one on its own line: substring matching does not care
   about surrounding newlines, only the earlier whole-blob scope did.
3. **One seam, at write time** (`runner.ts`'s `writeEvidence`): every
   evidence body is `JSON.stringify`'d, then scrubbed against every
   extracted value, then handed to the sink — not threaded through each
   individual field (`description`, `failReason`, …) ad hoc. Any field in
   any future schema revision gets the same scrub for free.
4. **Logs never carry captured text at all**: every `log()` call passes
   only structured metadata (`fingerprint`, `role`/`idx`/`id`, `result`/
   `state`) — never a description, a failReason, or any engine output — so
   there is nothing to redact on the log path in the first place.
5. **Nothing to redact before auth resolves**: the auth-throw and
   no-usable-auth paths write their abnormal `sweep.json` before any secret
   value is ever extracted — their `reason` strings are either a fixed
   constant or the auth provider's own error text, never built from a
   storage state.

## 6. Tests

From the original task body:
- **missing storage state -> RED did-not-run**: extended (review r1 item 2)
  to also cover `""` and a credential-less storage state
  (`{"cookies":[],"origins":[]}`) — all three read as no usable auth, write
  the abnormal `sweep.json`, and never call the engine.
- **item evidence shape matches schema**: every written item JSON parses
  with the v1 field names verbatim.
- **secret absent from logs**: a distinctive fake secret value, embedded in
  an engine's `failReason` in raw/JSON-escaped/URL-encoded/base64 form,
  appears in none of: log calls, item evidence, or `sweep.json`.

From review r1:
- `aggregateSweepState([])` is `"did-not-run"`, not a vacuous `"success"`
  (item 1).
- `""` and a credential-less storage state are no-usable-auth, same as
  `undefined` (item 2, folded into the first bullet above).
- Per-value, multi-encoding redaction, including a value split across lines
  (item 3, folded into the secret-hygiene bullet above).
- `itemEvidenceKey`/`sweepEvidenceKey` refuse an unsafe `role`/`id`/
  `fingerprint` segment, and a non-integer or negative `idx` (item 5, key
  half).
- `getStorageState()` throwing writes an error `sweep.json` instead of
  letting the throw escape `runSweep` (item 5, error half).

## 7. Open dependencies

- #1346 (T5): real `WalkAuthProvider` wired to gate-scoped secrets.
- #1347 (T6): real `WalkEngine` wired to whichever benchmark wins, satisfying
  §4.3's gate rules before returning a `WalkAttempt`.
- Follow-up: Worker route/cron that builds `WalkDeps` from real bindings and
  calls `runSweep` after a consumer staging deploy.
