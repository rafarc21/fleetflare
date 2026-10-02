# ACTIVITY column false-positive on a replaced container (#192)

**Board issue:** https://github.com/rafarc21/fleetflare/issues/192

## Problem

After a rollout replaces a running studio's container, for roughly the
2-3 minute "replaced but not yet brought up" window (`observed.replacedAt`
set, `observed.incarnation` null — do.ts/observed.ts's own "replacement
detected, not yet confirmed back" state), `fleet inspect`/`fleet ls` show
TWO contradictory statements side by side:

- `readyOverride` (`cli/readiness-format.ts:169-174`) correctly prints
  `replaced <age> ago — not brought up`, because it already checks
  `observed?.replacedAt != null`.
- The ACTIVITY column/line keeps printing a STALE verdict ("WAITING
  MEMBERS <age>", "WORKING <age>", ...) left over from BEFORE the
  container was replaced — because none of the three activity renderers
  check `replacedAt` at all.

## Root cause

`clearActivityState` (`apps/fleet/src/studio/activity.ts:758`) only runs
on a graceful `onStop` (do.ts:6387) or after a completed `provision()`
bring-up (do.ts:6295) — i.e. once the NEW container is confirmed back up.
An abrupt rollout replacement does not necessarily go through a clean
`onStop` first, so the stale `ACTIVITY_KEY` blob in DO storage survives
untouched for the whole replaced-but-not-confirmed window. Within that
window it is still fresh enough (under both the 90s DO-direct and 660s
D1-mirror staleness budgets) to render as a confident word instead of `?
stale`.

The robust fix belongs on the READ side — the three renderers in
`apps/fleet/cli/readiness-format.ts` that are shown directly to an
operator — not on chasing every container-death path to call
`clearActivityState` in time:

1. **`formatActivity`** (~line 375) — the `fleet ls` ACTIVITY column. Its
   final `else` branch unconditionally calls
   `formatActivityVerdict(status.observed?.activity ?? null, now,
   staleAfterSeconds)` with no check of `status.observed?.replacedAt`.
2. **`formatObservedLines`** (~line 634) — the `fleet inspect` `activity:`
   line. It prints a `replaced:` line from `observed.replacedAt` AND,
   separately and unconditionally, an `activity:` line via
   `formatActivityVerdict(observed.activity, ...)` with no gate on
   `replacedAt` at all.
3. **`lsJsonRows`** (~line 423) — the `fleet ls --json` machine-readable
   `lead` field. After the rate-limit branches it reads
   `s.observed?.activity` directly, with the same missing check, so the
   JSON `lead` field suffers the identical false positive.

## Fix

Mirrors the existing "— for a stopped studio even with a stale-looking
activity record left over" convention
(`apps/fleet/test/cli.fleet.test.ts` ~line 1153), which already returns
`"—"` for a non-live studio regardless of what is stored in `activity`.
This fix adds the same gate for the "replaced, not yet confirmed back"
state.

1. **`formatActivity`**: before the final `else` branch's call to
   `formatActivityVerdict`, add a check — if `status.observed?.replacedAt
   != null`, set `base = "—"` instead of calling `formatActivityVerdict`.
   Every rate-limit branch (`rl?.dead`, `rl?.select`, `rl.until`, ...)
   stays untouched and takes precedence exactly as today; this is scoped
   only to the activity/WORKING/WAITING-MEMBERS false positive, not
   rate-limit display.
2. **`formatObservedLines`**: the `activity:` line gets the same gate —
   when `observed.replacedAt != null`, render `activity:     —` instead
   of calling `formatActivityVerdict`.
3. **`lsJsonRows`**: right before `const a = s.observed?.activity ?? null;`,
   add a check — if `s.observed?.replacedAt != null`, return `{ ...base,
   lead: "unknown", leadSince: null, limitResetsAt: null }`. Reuses the
   existing `"unknown"` enum value ("no verdict or a stale one" — the
   `LsJsonRow.lead` doc comment), no new enum value. This check sits
   AFTER the existing rate-limit branches, same precedence as point 1.

## Out of scope

- `apps/fleet/src/studio/activity.ts`, `do.ts`, `observed.ts`,
  `failover.ts` are untouched. `clearActivityState`'s call sites are not
  widened — the fix is entirely a read-side render gate.
- No change to rate-limit (`DEAD`/`LIMIT`/modal) branch precedence or
  wording in any of the three functions.
- No change to `readyOverride`, which already handles `replacedAt`
  correctly and is the reference this fix matches.

## Test plan

All three new tests live in `apps/fleet/test/cli.fleet.test.ts`, next to
the existing coverage for each function, using that file's existing
`status()`/`emptyObserved()`/`activity()` helpers.

1. `formatActivity` describe block: a `status()` with `state: "running"`,
   `observed: { ...emptyObserved(), replacedAt: "<iso>", activity:
   activity({ state: "waiting-members", since: ... }) }` must render
   `"—"`, not `"WAITING MEMBERS ..."`. Title mirrors the existing
   stopped-studio test: "— for a running studio whose container was just
   replaced, even with a stale-looking activity record left over".
2. `formatObservedLines` describe block: the same replaced + stale
   activity setup must render the `activity:` line as
   `"activity:     —"` instead of the stale word.
3. `lsJsonRows` describe block: the same setup must produce `lead:
   "unknown"`, `leadSince: null`, `limitResetsAt: null` — not `lead:
   "waiting-members"`.

Each test is written RED first (confirmed failing against the
pre-fix code), then the three-point fix above is implemented and the
same tests confirmed GREEN.
