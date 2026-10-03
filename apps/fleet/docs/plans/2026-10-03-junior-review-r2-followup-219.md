# junior review round-2 follow-up (#219)

Fix task, filed by this studio itself from PR #220's round-2 review
(cap reached, filed instead of a 3rd review pass). Branched off
`fix-221-junior-usage-review-followup` (PR #223, open) — stacks further,
since this touches the same `main.ts`/`usage.ts`/`cli/junior.ts` #221
already modified. PR targets that branch, not `main`.

## 1. Spec — local AuthError branch never records usage

`skills/junior/src/main.ts`'s `catch` block:
```ts
if (e instanceof AuthError) { console.error(`junior: ${e.message}`); return EXIT.AUTH; }
```
never calls `recordLocalUsage`, unlike every other catch branch (timeout,
api-error). The original premise ("calls === 0, no model call ever
happened") is false for 2 real paths: `client.ts`'s `callOnce` throws
`AuthError` AFTER a genuine HTTP attempt (401/403, or `code===10000`);
an expired `wrangler auth token` refresh (`auth.ts`) hits the same
branch after `isLocal` is already `true`.

Fix is a direct mirror of the other 4 catch-branch calls already in this
file — add the same two lines:
```ts
if (e instanceof AuthError) {
  console.error(`junior: ${e.message}`);
  console.error(telemetry(model, start, last, calls, "auth-error"));
  recordLocalUsage(env, isLocal, args.mode, model, { in: usageIn, out: usageOut }, calls, false);
  return EXIT.AUTH;
}
```
No new logic needed: `recordLocalUsage`'s own `if (!isLocal) return;`
guard ALREADY distinguishes the two cases precisely — `resolveTransport`'s
own pre-call `AuthError` (config missing, no account id) throws before
`isLocal` is ever set `true`, so it still correctly records nothing; a
post-call `AuthError` (from inside `callWithPolicy`, after
`isLocal = transport.kind !== "proxy"` already ran) now correctly
records `ok:false`. This matches the EXACT same "`calls`/`usageIn`/
`usageOut` may legitimately read 0 for a first-call failure" limitation
every other catch branch already has (an internal retry counter inside
`callWithPolicy` is lost on throw, not returned to the caller) — not a
new gap introduced here, not in scope to fix.

Test: in `skills/junior/test/main.test.ts`, a direct-transport run
against a fake server returning 401 — assert a local usage-log line
lands with `ok: false`. A second test: `resolveTransport`'s own
pre-call `AuthError` (e.g. no `CLOUDFLARE_ACCOUNT_ID`/config at all) —
assert NO local usage-log line is written (locks in the narrowing this
fix depends on).

## 2. Standards — speculative `verifyAccessFn` DI param

`apps/fleet/src/junior/usage.ts`'s `handleJuniorUsageStats(req, env,
verifyAccessFn: typeof verifyAccess = verifyAccess)` — every sibling
`/studio/*` handler (`board/routes.ts`, `memory/routes.ts`) calls
`verifyAccess(req, env)` directly and is tested via `vi.spyOn`, which
this file's own test ALREADY uses in one of its 3
`handleJuniorUsageStats` tests.

Fix: drop the `verifyAccessFn` parameter, call `verifyAccess(req, env)`
directly. Update `apps/fleet/test/junior.usage.test.ts`'s other 2 tests
(currently passing a fake function directly) to use `vi.spyOn(authModule,
"verifyAccess")` instead, consistent with the third test and with
`board.test.ts`/`memory.test.ts`'s own pattern.

## 3. Standards — cross-package source import

`apps/fleet/cli/junior.ts`: `import { juniorUsageLogPath } from
"../../../skills/junior/src/usage"` is the only `apps/fleet` →
`skills/*/src` TS source import in the repo; everywhere else `skills/*`
is treated as a filesystem/runtime asset only (e.g. `juniorPaths`'s
`skillSrc: join(repoRoot, "skills", "junior")` in the same file).

Fix: duplicate the short path-join literal in `apps/fleet/cli/junior.ts`
instead (3 lines: `join(home, ".local", "share", "fleet",
"junior-usage.jsonl")`), remove the cross-package import. Lowest blast
radius — relocating the shared constant would touch
`skills/junior/src/usage.ts`'s own callers/tests for no benefit.

## Files

- `skills/junior/src/main.ts` (AuthError branch)
- `skills/junior/test/main.test.ts` (2 new tests)
- `apps/fleet/src/junior/usage.ts` (drop `verifyAccessFn` param)
- `apps/fleet/test/junior.usage.test.ts` (2 tests converted to `vi.spyOn`)
- `apps/fleet/cli/junior.ts` (duplicate path-join literal, drop cross-package import)

## Merge Danger

Door: one-way (stacks on `feat-218-junior-usage-counter`/PR #220,
already merged to main with a one-way D1 migration, and on PR #223
which is also one-way for the same reason). This diff alone adds no
migration — pure logic/test changes, no schema, no new network surface.
Blast radius: a bad fix here could under/over-count `fleet junior stats`
locally, or regress the `handleJuniorUsageStats` auth check (mitigated
by keeping the exact same `verifyAccess` call shape every other
`/studio/*` route already uses) — never touches an actual `/fleet/junior`
response path.

## Verification plan

1. Scoped: `bun test skills/junior/test/main.test.ts`.
2. Scoped: `vitest run apps/fleet/test/junior.usage.test.ts` (from `apps/fleet`).
3. Scoped: `bun run check -p cli` or equivalent narrow typecheck for `apps/fleet/cli/junior.ts`'s import removal.
4. Full gate, SEQUENTIAL, one at a time (11.6 GiB memory ceiling): `bun run check` → `bun run test` → `bun run bun-test` → `bun run test-lies-check` → `bun run english-check`. Note: `bun run bun-test` has one PRE-EXISTING unrelated failure (`test/bun/install-cache-security.test.ts`, confirmed on the base branch already, untouched by this stack) — expect that one failure, not a regression.
