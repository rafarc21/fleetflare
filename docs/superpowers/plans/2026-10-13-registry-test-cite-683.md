# S28-F1 — Fix stale test citation in registry.ts comment (refs #683, refs #643)

Sweep 28 finding: `apps/fleet/src/studio/registry.ts:266` cites
`test/studio.burn-window-expiry.ts`, but the file is
`test/studio.burn-window-expiry.test.ts` — no bare `.ts` file exists.

## Scope

Comment-only change. Never code. One word added (`.test` suffix).

## Steps

1. Edit the comment at registry.ts:266 from
   `test/studio.burn-window-expiry.ts's` to
   `test/studio.burn-window-expiry.test.ts's`.
2. Verify: grep shows no remaining bare citation
   `burn-window-expiry.ts` without `.test` anywhere in apps/fleet/src.
3. Run english-check (comment text is repo content).

## Verification

- `grep -rn "burn-window-expiry" apps/fleet/src` → only `.test.ts`
  spellings.
- `cd apps/fleet && bun run scripts/english-check.ts` → exit 0.
- `cd apps/fleet && bun run scripts/test-lies-check.ts` → exit 0
  (registry.ts is source; confirms no citation-lie pattern).
