# Plan — S32-F9: `closeTaskOnPromote` opts object (#673)

Sweep 32 finding S32-F9 (docs/maintainability/2026-10-13-long-params-sweep-32.md, refs #663), tier GLM-OK. `closeTaskOnPromote` (apps/fleet/src/board/close-action.ts:120) takes six positionals, only the last optional:

```ts
closeTaskOnPromote(db: D1Port, api: BoardApi, repo: string, issueNumber: number,
  evidence: CloseEvidence, now: number = Date.now())
```

The `now` positional reads as data (the mark-evidence timestamp) sitting after the `evidence` object that already carries the shape of the close. This function crosses the board/github boundary — called from src/board/routes.ts:409 (reap route), src/github/webhook.ts:414 (push close loop), and 25 test call sites in test/board.close-action.test.ts.

## Steps

1. Branch `refactor-673-close-task-opts` off origin/main `040e6b1`.
2. RED: test/board.close-action.test.ts — add one test inside the `idempotency` describe (after the "a DIFFERENT sha..." test) that calls `closeTaskOnPromote(testEnv.DB, api, "o/r", 12, { sha: "sha-opts-9999", branch: "main" }, { now: 4_000 })` and asserts the marker row `gh_close_o/r_12_sha-opts-9999` carries `ts === 4_000`. Under the current positional signature the object lands in `now` and is never read, so the marker stamps wall clock — this test must fail before the refactor. Run the file: exactly this test red. Commit, push.
3. GREEN, one atomic commit:
   - close-action.ts: signature `closeTaskOnPromote(db: D1Port, api: BoardApi, repo: string, issueNumber: number, evidence: CloseEvidence, opts: { now?: number } = {})`; first body statement `const { now = Date.now() } = opts;`; everything else byte-identical. Add one comment line above the signature naming S32-F9.
   - github/webhook.ts:414: trailing `now` becomes `{ now }`.
   - board/routes.ts:409: unchanged — no argument after `evidence`.
   - test/board.close-action.test.ts: all 25 call expressions migrate their trailing clock `, 1_000)` → `, { now: 1_000 })` and `, 2_000)` → `, { now: 2_000 })` (multi-line calls too).
4. Self-check: `grep -rn "closeTaskOnPromote(" apps/fleet/src apps/fleet/test` — no call passes a bare number as sixth argument; every explicit clock is named `now:` inside an object.
5. Verification, strictly serial, one gate at a time (container memory ceiling):
   a. `cd apps/fleet && npx vitest run test/board.close-action.test.ts` — exit 0
   b. `cd apps/fleet && bun run check` (the one heavy gate — run alone, never alongside vitest) — exit 0
   c. `cd apps/fleet && bun run english-check` — exit 0
   d. `cd apps/fleet && bun run test-lies-check` — exit 0
6. Commits, each pushed immediately after being made:
   - `docs(fleet): #673 plan — closeTaskOnPromote opts object (refs #663)`
   - `test(fleet): S32-F9 RED — closeTaskOnPromote reads now from opts (refs #663)`
   - `refactor(fleet): S32-F9 closeTaskOnPromote — now moves from positional to opts object (refs #663)`

## Verification

The four commands above, each exit 0, real output tails captured for the completion record. The RED run in step 2 proves the new test can fail (no mutation of a heavy gate — the vitest file is the behavior net, `bun run check` proves no call site kept the old shape).

## Boundaries

- Heavy gate budget: step 5b runs `bun run check` once, alone. Never alongside vitest or another build.
- No behavior change: default clock identical (`Date.now()`), routes.ts caller untouched, webhook.ts only wraps its existing `now` value as `{ now }`.
- Tier GLM-OK: board/github close path only — no auth, secrets, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate or approvals code touched.
