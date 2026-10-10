# A stopped row never carries a stale readiness verdict (board issue #331)

Source: #331 (live 2026-10-10), Refs only — a cleanly parked studio shows
`? studio X is being destroyed — it will not start a container` in `fleet
ls` forever.

## Root cause

A background pass's readiness exec was mid-flight when destroy took the
container; it hit startRefusal and stamped that refusal text as an
`inconclusive` verdict onto the row. `destroyAndRecord` (destroy.ts:370)
spreads `...existing` onto the stopped row, so the verdict survives; nothing
ever re-checks a stopped studio. `watchForDestroy` cannot catch every
placement: the marker check goes blind when a destroy runs start-to-finish
inside the snapshot window (provision.ts's own doc), and the write at
do.ts:2975 re-reads STATUS_KEY after the guard — a row stopped in that exact
gap still takes the stamp.

## Fix (both halves, defense in depth)

1. destroyAndRecord: `readiness: null` on the completed stopped row. A
   stopped studio has no meaningful readiness — "?" is honest, a stale
   verdict is a lie. The destroyLanded/epoch guards stay (suspenders); this
   is the belt. No new StudioReadiness kind — the issue offers "clear or set
   parked/stopped"; clearing is the minimal, honest one.
2. checkAndRecordReadiness: when the fresh row (do.ts:2975's re-read) reads
   `state: "stopped"`, skip the STATUS_KEY/recordStudioFn writes and return
   that row as-is — a verdict taken against a container a destroy already
   stopped must not land on the stopped row.

## Tests-first order

1. test/studio.destroy.test.ts: a running row seeded with the refusal-shaped
   `inconclusive` verdict; destroyWithSync runs; result AND stored row read
   `readiness: null`. RED today (the spread keeps it).
2. test/studio.readiness.test.ts (checkAndRecordReadiness's own home): a
   storage whose STATUS_KEY flips to a stopped row DURING the check's exec
   (the exec callback flips the map), no destroy marker, no epoch bump;
   the returned status is the stopped row, readiness unstamped, no
   recordStudioFn call. RED today.
3. Green: the two source edits; existing tests must pass unmodified.

## Verification

Targeted vitest files, one step at a time: studio.destroy.test.ts,
studio.destroy-race.test.ts, studio.readiness.test.ts,
studio.stopped-stays-stopped.test.ts, studio.session.test.ts,
studio.start-gate-writeback.test.ts. Then `flock /tmp/fleet-gate.lock bun run
check` once, alone. Then `bun run english-check` (this doc is prose).

## Files touched

- `docs/superpowers/plans/2026-10-10-stale-destroyed-readiness-331.md` (this)
- `apps/fleet/src/studio/destroy.ts`
- `apps/fleet/src/studio/do.ts`
- `apps/fleet/test/studio.destroy.test.ts`
- `apps/fleet/test/studio.readiness.test.ts`

## Out of scope

ASIDE_SHIP_KEY (a separate DO key mirrored at read time; failures render as
a note via `error`/asideShip fields), the WIP-sync gate (already skips on a
non-"provisioned" verdict), any new StudioReadiness kind ("parked"/
"stopped"), registry.ts's read side, `freshStatus`'s shape.
