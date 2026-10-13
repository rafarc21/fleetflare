# Plan — S32-F1: `handleBoard` ports object (#666)

Sweep 32 finding S32-F1 (docs/maintainability/2026-10-13-long-params-sweep-32.md, refs #663), tier GLM-OK. `handleBoard` (apps/fleet/src/board/routes.ts:825) takes eight positionals; six are injectable ports, each defaulted off `env`. Production caller src/index.ts:102 passes `(req, env)` only; the other 94 call-site lines are tests injecting 1–5 ports through trailing `undefined` holes — test/board.read-repos.test.ts:72 reads `handleBoard(r, testEnv, api, reach, undefined, undefined, wakeDeps())`.

## Steps

1. Branch `refactor-666-handleboard-ports` off origin/main (done).
2. routes.ts: add an internal (un-exported) type `BoardPorts` with six optional fields — `api: BoardApi`, `reach: RepoReachFetch`, `verifyFetch: VerifyFetch`, `reapPort: ReapPort`, `assignWake: AssignWakeDeps`, `rescueGcPort: RescueGcPort` — and change the signature to `handleBoard(req: Request, env: Env, ports: BoardPorts = {})`, destructuring the same six names with the same env-resolving defaults the positional list had (`githubBoardApi(env)`, `githubRepoReach(env)`, `realVerifyFetch(env)`, `realReapPort(env)`, `realWakeDeps(env)`, `realRescueGcPort(env)`). Function body unchanged. Keep the board-#41 comment attached to `assignWake`; update the file-header seam sentence so "defaulted parameters" reads as the `ports` object's fields.
3. Rewrite every test call site to name the ports it injects:

| old trailing args | new third argument |
|---|---|
| `api, reach` | `{ api, reach }` |
| `fakeApi(), reach` | `{ api: fakeApi(), reach }` |
| `api, reach, okVerifyFetch` | `{ api, reach, verifyFetch: okVerifyFetch }` |
| `api, reach, undefined, reapPort` | `{ api, reach, reapPort }` |
| `api, reach, undefined, undefined, deps` | `{ api, reach, assignWake: deps }` |
| `api, reach, undefined, undefined, wake(x)` | `{ api, reach, assignWake: wake(x) }` |
| `fakeApi(), reach, undefined, undefined, undefined, port` | `{ api: fakeApi(), reach, rescueGcPort: port }` |

Files: test/board.routes.test.ts (80 calls), test/board.open-prs-route.test.ts (12), test/board.read-repos.test.ts (2). Multi-line calls: same mapping. src/index.ts:102 unchanged.
4. Self-check: `grep -rn "handleBoard(" apps/fleet/test` — every call site has at most three positional arguments and no `undefined` hole.
5. Verification, strictly serial, one gate at a time (container memory ceiling):
   a. `cd apps/fleet && npx vitest run test/board.routes.test.ts test/board.read-repos.test.ts test/board.open-prs-route.test.ts` — exit 0
   b. `cd apps/fleet && bun run check` (the one full gate — run alone, never alongside another build or test suite) — exit 0
   c. `cd apps/fleet && bun run english-check` — exit 0
   d. `cd apps/fleet && bun run test-lies-check` — exit 0
6. Commit `refactor(fleet): S32-F1 handleBoard — six ports move from positionals to a ports object (refs #663)`, push.

## Verification

The four commands above, each exit 0, real output captured for the completion record. No RED/GREEN mutation of a heavy gate: this is a signature refactor; the three vitest files are the behavior net, `bun run check` proves no call site kept the old positional shape.

## Boundaries

- Heavy gate budget: step 5b runs `bun run check` once, alone. Never alongside vitest or another build.
- No behavior change: status codes, route order, auth, defaults identical.
- Tier GLM-OK: no auth/secrets/rescue/failover/deploy/migration/write-proxy/leak-gate/approvals code touched.
