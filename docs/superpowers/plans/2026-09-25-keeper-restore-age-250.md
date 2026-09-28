# Keeper restore measures its own R2 upload time, not `latest`'s (board issue #250)

## Background — the gap #85/#118 left open

`pickRestoreSource` (`apps/fleet/src/studio/provision.ts`) picks a session
snapshot to restore: `latest` whenever it holds a session, and only when
`latest` is missing, unreadable, or blank does it fall back to the newest
daily keeper (`source: "daily <date>"`). A keeper is, by construction, from a
genuinely OLDER snapshot than `latest`.

`runSessionRestore` already returns this `source` on its result. But nothing
past that point ever looked at it: `recordBringupObservation` always measured
`snapshotAgeS` against `lastSnapshotAtBefore` (a cache of
`Observed.lastSnapshotAt`, only ever written by the periodic sync tick's
`latest` R2 put) or, as a fallback, `deps.r2Head(sessionLatestKey(...))` —
both describing `latest`'s own upload time regardless of which snapshot was
actually restored. A keeper restore's recorded age therefore understated the
real work-at-risk, sometimes by days. `ProvisionDeps.onRestoreOutcome`'s own
doc comment named this exact gap as issue #85 review round 6, MUST-FIX 10c —
"KNOWN FOLLOW-UP, NOT this PR" — tracked as board issue #250, a mechanical,
test-only follow-up (no design left to decide beyond the one call already
made below).

## The decision (the one part left open)

A keeper restore measures age against the KEEPER object's own R2 `uploaded`
time, read ONCE during this bring-up (same read-before convention
`lastSnapshotAtBefore` already uses for `latest` — except a keeper has no
persisted cache to serve that read from, since `lastSnapshotAt` is only ever
written by `latest`'s own sync-tick put, so the keeper's read is a fresh
`r2Head` every time, not a cache hit). The row renders `from daily <date> snap
N old` so an operator can tell a keeper restore apart from a `latest` one —
`snapshotAgeS` alone gives no such signal.

## The fix

1. **`ProvisionDeps.onRestoreOutcome`** (`provision.ts`) — widened from
   `(outcome: RestoreOutcome) => void` to `(outcome: RestoreOutcome, source:
   string | null) => void`. Doc comment updated from "KNOWN FOLLOW-UP, NOT
   this PR" to "WIRED (board #250)".
2. Both call sites that invoke it (`runProvision`'s and `runRestart`'s own
   restore try/catch) now capture `restoreResult.source ?? null` alongside
   `restoreResult.restore` and forward both.
3. Both registration sites (`provisionWithStorage`/`restartWithStorage`) add
   a `restoreSource` local beside the existing `restoreOutcome`/
   `restoreObservedAt`, captured in the same callback, and thread it into
   `recordBringupObservation` as a new parameter.
4. **`recordBringupObservation`** gains `restoreSource: string | null`. Inside
   the `restoreOutcome === "restored"` block, a `keeperSource` local
   (`restoreSource` when it starts with `"daily "`, else `null`) decides which
   R2 key's own `uploaded` timestamp to read:
   - Keeper: reconstructs the key as `` `${sessionDailyPrefix(status.id)}${date}.tar.gz` ``
     (reusing the already-imported `sessionDailyPrefix`, the same prefix
     `pickRestoreSource` itself lists against) and reads it via a fresh
     `deps.r2Head?.(keeperKey)` call — no cache.
   - Otherwise (source is `"latest"` or null/undefined — the untouched,
     existing common case): the exact pre-existing logic, unchanged —
     `lastSnapshotAtBefore` first, `r2Head(sessionLatestKey(...))` fallback.
   `resolveSnapshotAge` itself (`observed.ts`) is untouched — it only ever
   sees one `snapshotUploadedAt` string; what changed is which one
   `recordBringupObservation` passes in. Its own doc comment updated from
   "KNOWN FOLLOW-UP, NOT this PR" to describe the now-wired behavior.
5. **`ObservedSession.snapshotSource?: string`** (`observed.ts`) — the
   keeper's own source label (`"daily <date>"`), applied the same way
   `snapshotAgeIsUpperBound` already is: a conditional spread on top of
   whatever `computeSessionVerdict` (or the untouched-lead branch) built,
   present in both of `recordBringupObservation`'s session-construction
   branches. Absent for a `latest` restore, a skip, or a failed restore.
6. **`formatSession`** (`apps/fleet/cli/readiness-format.ts`) — when
   `session.snapshotSource` is set, renders `from ${session.snapshotSource}
   snap ${bound}${age} old` (e.g. `from daily 2026-09-20 snap 3d old`)
   instead of the plain `from snap ${bound}${age} old`; absent renders exactly
   as before.

## Test strategy

RED first throughout. New coverage lives beside the existing suites for the
functions touched:

- `apps/fleet/test/studio.replacement.test.ts` — real gzip'd single-file tar
  fixtures (same in-test-built-archive shape `studio.backup-guard.test.ts`'s
  own fixture section uses) so `pickRestoreSource` genuinely chooses a
  keeper, not a stand-in:
  - `runRestart — onRestoreOutcome forwards runSessionRestore's own source` —
    a keeper-sourced restore forwards `("restored", "daily <date>")`; a
    latest-only restore (no `r2List` wired) forwards `("restored", null)`.
    Mutant 2 bite-proof: reverting either call site back to a single-argument
    `deps.onRestoreOutcome?.(restoreOutcome)` turns both tests red (verified,
    then reverted).
  - `restartWithStorage — a keeper-sourced restore measures snapshotAgeS
    against the KEEPER's own R2 upload time, not latest's` — `r2Head` mocked
    per-key, keeper's own upload time ~13 days before latest's; asserts the
    recorded age matches the keeper's own math and `snapshotSource` is
    stamped. Mutant 1 bite-proof: pointing the keeper branch at
    `sessionLatestKey(status.id)` instead of the reconstructed keeper key
    turns this test red (verified, then reverted).
  - `restartWithStorage — an explicit source: "latest" restore is
    byte-for-byte unchanged` — a real, richer `latest` (through
    `pickRestoreSource`, `r2List` wired) still measures age against
    `lastSnapshotAtBefore`, never calls `r2Head` for it, and never sets
    `snapshotSource` — pins the untouched branch even when `source` is now an
    explicit, non-null `"latest"` rather than merely absent.
- `apps/fleet/test/cli.fleet.test.ts` — `formatSession` renders `from daily
  2026-09-20 snap 3d old` when `snapshotSource` is set, and the unchanged
  `from snap 3d old` when it is absent.

## Verification

- `cd apps/fleet && bun run check` — clean across all 5 tsconfig projects.
- Targeted vitest run of the touched test files first, then the full suite —
  no regressions; exact pass-count delta over main's baseline recorded in
  `.fleet/done.json`.
- Zero diff under `apps/fleet/container/` (Principle 3 — Worker-side fix
  only).

## Files touched

- `apps/fleet/src/studio/provision.ts` — `ProvisionDeps.onRestoreOutcome`
  widened; both call sites; both registration sites; `recordBringupObservation`'s
  new `restoreSource` parameter and keeper-vs-latest key selection.
- `apps/fleet/src/studio/observed.ts` — `ObservedSession.snapshotSource`;
  `resolveSnapshotAge`'s doc comment updated to reflect the now-wired
  behavior (the function's own logic is unchanged).
- `apps/fleet/cli/readiness-format.ts` — `formatSession`'s `from
  daily <date> snap N old` rendering.
- `apps/fleet/test/studio.replacement.test.ts`,
  `apps/fleet/test/cli.fleet.test.ts` — test coverage above.
