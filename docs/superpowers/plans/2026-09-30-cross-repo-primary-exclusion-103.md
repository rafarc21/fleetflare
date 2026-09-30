# cross-repo primary exclusion in wrap failover (issue #103)

## Problem (verbatim gist)

`nextClaudeAccount` (accounts.ts:195-214) wrap-around candidate selection only
excludes accounts BEFORE the calling studio's own `CLAUDE_ACCOUNT_BY_REPO`-
mapped primary (via the `start`/`scopedAccounts` slicing in
failover.ts:1406-1418, `runAccountFailover`). It does NOT exclude an account
that is ANOTHER repo's own mapped primary sitting FURTHER ALONG the list.

Concrete scenario: repo A's mapped primary = slot 2, repo B's mapped primary =
slot 4, 4 accounts total. A repo-A studio currently on slot 3 (limited) wraps
forward and can land on slot 4 — the account `CLAUDE_ACCOUNT_BY_REPO` reserves
exclusively for repo B. Slot 4 must be skipped as a candidate for repo A, same
as if it were fleet-wide limited. The wrap should instead land back on slot 2
(repo A's own primary), which is free.

## Design

### accounts.ts — pure, still D1-free (file's own header: no Env/D1 import)

`nextClaudeAccount` gains a 5th optional param, `reserved: Set<string> = new
Set()`. Inside `isFree`, `reserved.has(a.name)` is checked FIRST and treated
exactly like a live fleet-wide limit — skip and keep stepping. Default empty
means every existing 2-, 3- and 4-arg call site (there were none outside the
test file, failover.ts) keeps behaving identically.

New `otherRepoPrimaries(env: ClaudeAccountEnv, ownRepo: string | null):
Set<string>` — parses `CLAUDE_ACCOUNT_BY_REPO` via the existing
`parseAccountMap`, and returns `claudeAccountVarName(slot)` for every repo
entry in the map EXCEPT `ownRepo`. `ownRepo`'s own mapped slot is never in the
result — a repo's own primary is exactly where a wrap starts and is free to
land back on (the whole point of the fix). `null`, or a repo the map does not
mention, reserves every mapped slot: such a caller has no "own" entry to
exempt.

### failover.ts — FailoverDeps.reservedAccounts (optional port)

`reservedAccounts?: Set<string>` added next to the existing `primary?: string
| null` field. Doc comment states it is the FORWARD half of the same #271
boundary `primary`'s own backward-only `scopedAccounts` slicing already
enforces: `primary` only ever excludes accounts BEFORE this studio's own
mapped slot; `reservedAccounts` excludes ones FURTHER ALONG the list that
belong to a different repo entirely.

`runAccountFailover`'s `nextClaudeAccount(scopedAccounts, current, limits,
deps.now())` call becomes `nextClaudeAccount(scopedAccounts, current, limits,
deps.now(), deps.reservedAccounts ?? new Set())`. Absent (every caller
written before #103): no cross-repo boundary known, same as a fleet with no
`CLAUDE_ACCOUNT_BY_REPO` map at all.

### do.ts wiring

`failoverDeps()` adds `reservedAccounts: otherRepoPrimaries(this.env,
parseStudioId(this.selfId())?.repo ?? null)`. `otherRepoPrimaries` imported
alongside the existing `resolveClaudeAccounts, claudeAccountToken,
launchAccount, autoFailoverOn, accountDisplay` group from `./accounts`.
`parseStudioId` was already imported (used by `primaryAccount()`).

## TDD

RED first — `apps/fleet/test/studio.account-failover.test.ts`:

- `nextClaudeAccount`: a 4-account list, current on account 2 (free, no
  limits), `reserved` naming account 3 — asserts the wrap lands on account 4,
  never account 3, proving `reserved` overrides plain freedom, not just
  limits (a fleet-wide limit entry would have been indistinguishable from
  this if `reserved` only ever intersected with `limits`).
- `otherRepoPrimaries`: `CLAUDE_ACCOUNT_BY_REPO: '{"repo-a":2,"repo-b":4}'`
  called with `ownRepo: "repo-a"` returns `{CLAUDE_CODE_OAUTH_TOKEN_4}` only;
  called with `ownRepo: null` or a repo absent from the map returns both
  `{_2, _4}`; an empty/absent map returns an empty set.
- `runAccountFailover` (near "auto-failover ON with a mapped primary #271"):
  reproduces the exact issue scenario — 4 accounts, repo A's studio
  (`primary: "CLAUDE_CODE_OAUTH_TOKEN_2"`, `reservedAccounts:
  new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"])`), currently recorded on
  `CLAUDE_CODE_OAUTH_TOKEN_3` (fleet-wide limited, still live), account 4
  fleet-wide FREE. Asserts `{ kind: "switched", from:
  "CLAUDE_CODE_OAUTH_TOKEN_3", to: "CLAUDE_CODE_OAUTH_TOKEN_2" }` — wraps
  back to repo A's own primary, never lands on account 4.

`harness()` gained a `reservedAccounts?: Set<string>` option, wired into
`deps` the same conditional-spread way `primary` already is.

RED confirmed by running the file against pre-fix `src/`: `otherRepoPrimaries`
does not exist (`TypeError: otherRepoPrimaries is not a function`,
3 failures) and `nextClaudeAccount`'s 5th arg is silently accepted by JS at
runtime but ignored by the un-fixed implementation, so both the direct unit
test and the `runAccountFailover` reproduction assert the wrong candidate
(account 3 instead of 4 for the direct case; account 4 instead of 2 for the
integration case) — 5 failures, 91 pre-existing tests untouched:

```
 Test Files  1 failed (1)
      Tests  5 failed | 91 passed (96)
```

GREEN — implemented exactly the 3-file design above. Same file, same run:

```
 Test Files  2 passed (2)
      Tests  124 passed (124)
```
(124 = the 96 in `studio.account-failover.test.ts` plus the 28 in
`studio.account-by-repo.test.ts`, run together per the verification section
below — both files touch/could be affected by `accounts.ts`.)

## Verification

Run ONE heavy thing at a time, per the shared-lock rule.

1. `cd apps/fleet && npx vitest run test/studio.account-failover.test.ts
   test/studio.account-by-repo.test.ts`:
   ```
    Test Files  2 passed (2)
         Tests  124 passed (124)
      Duration  4.17s
   ```
2. `cd apps/fleet && bun run test -- test/studio.account-failover.test.ts
   test/studio.account-by-repo.test.ts` (through the package.json `test`
   script, `vitest run`, with args):
   ```
    Test Files  2 passed (2)
         Tests  124 passed (124)
      Duration  4.02s
   ```
3. `flock /tmp/fleet-gate.lock bash -c 'cd /workspace/fleetflare/apps/fleet
   && bun run check'` (5-tsconfig repo-wide typecheck, the one heavy gate
   this task ran, once):
   ```
   $ tsc --noEmit && tsc --noEmit -p container && tsc --noEmit -p cli && tsc --noEmit -p test-integration && tsc --noEmit -p test
   ```
   Exit 0, no output — clean.
4. `cd apps/fleet && bun run english-check`:
   ```
   $ bun run scripts/english-check.ts
   english-check: clean
   ```
   Exit 0.

Full repo-wide `vitest run` (148 files) deliberately NOT run, matching the
#102 PR's own precedent for this exact gate — every file this change touches
or could affect (accounts.ts, failover.ts, do.ts) was run directly above
instead, and `bun run check` typechecks every file in the repo including all
of them.

## Deviations / judgment calls

None. The fix follows the dispatched shape exactly: `reserved` param on
`nextClaudeAccount` defaulting to empty, `otherRepoPrimaries` built on the
existing `parseAccountMap`, `FailoverDeps.reservedAccounts` wired through
`runAccountFailover`'s existing `nextClaudeAccount` call, and do.ts's
`failoverDeps()` sourcing it from `otherRepoPrimaries(this.env,
parseStudioId(this.selfId())?.repo ?? null)`.

One environment note, not a code deviation: this container's local clone of
`main` was stale relative to `origin/main` (a second PR, #75, had merged
after the clone was made) — the branch was rebased onto `origin/main` before
the first push so the push wrapper's leak-scan diff stayed scoped to this
change's own commit rather than walking unrelated history it didn't
recognize as already on the remote.

## Files touched

`apps/fleet/src/studio/accounts.ts` (`nextClaudeAccount`'s 5th param,
`otherRepoPrimaries`), `apps/fleet/src/studio/failover.ts`
(`FailoverDeps.reservedAccounts`, the `nextClaudeAccount` call site),
`apps/fleet/src/studio/do.ts` (import + `failoverDeps()` wiring),
`apps/fleet/test/studio.account-failover.test.ts` (new tests + `harness()`
option).
