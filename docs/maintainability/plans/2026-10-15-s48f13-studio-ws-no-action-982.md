# S48-F13 — studio.ws + ws-close-idempotent yields: no action (recorded)

Issue: https://github.com/rafarc21/fleetflare/issues/982
Sweep: docs/maintainability/2026-10-15-slow-tests-sweep-48.md

## Problem
`apps/fleet/test/studio.ws.test.ts:650,689` and
`apps/fleet/test/studio.ws-close-idempotent.test.ts:39-95` use real
setTimeout yields — 20ms between pty emits for pump scheduling, and
`setTimeout(r, 0)` macrotask yields in close-idempotent. Sweep estimated
under 0.5s combined.

## Decision
No change. The yields are the smallest wait that lets the pump's async
reader consume a socket frame; sub-100ms combined per run, not on the
gate's slowest-shard path. `vi.waitFor` is already used where the
assertion is awaitable. Recorded to close the lens.

## Verification
- `npx vitest run test/studio.ws.test.ts test/studio.ws-close-idempotent.test.ts` — 48 passed.
- `npx tsc --noEmit -p test` — exit 0.
- `bun run english-check` — clean.